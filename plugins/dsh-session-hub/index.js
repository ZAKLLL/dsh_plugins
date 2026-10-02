/**
 * dsh-session-hub — Host half.
 *
 * Collects every coding-agent session this machine has on disk into one
 * normalized inventory, and serves it to the browser half over the shared
 * `/api` Fetch route.
 *
 * Sources — each one a separate on-disk dialect, parsed independently:
 *
 *   dsh     ~/.dsh/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd
 *           Zstandard in *concatenated frames* (one per flush), then JSONL.
 *   claude  ~/.claude/projects/<slug>/**.jsonl           (Claude Code)
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (Codex CLI)
 *   gemini  ~/.gemini/tmp/<project>/chats/**.jsonl       (Gemini CLI)
 *
 * Two read paths, deliberately separate:
 *
 *   listing      a growing prefix of the file, large enough to find the
 *                recorded header and the first human message, then stopped.
 *   transcript   the whole file, rendered as normalized markdown.
 *
 * @module dsh-session-hub
 */

import { execFile, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

/** The Cordis service this plugin requires to publish a browser route. */
export const inject = ["connection"];

/** The one exact Fetch route the client talks to; every call is a POST with an `op`. */
const ROUTE = "/api/session-hub";

const AGENT_LABELS = {
  dsh: "DSH",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  pi: "pi",
  opencode: "opencode",
};

/** A session whose store holds no human text at all. */
const UNTITLED = "(untitled)";

/** Upper bound on one bulk delete, so a runaway payload cannot walk the disk. */
const MAX_BATCH_DELETE = 2000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const home = () => homedir();
const dshHome = () => process.env.DSH_HOME || join(home(), ".dsh");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Accept epoch ms, epoch seconds, or an ISO/parseable string. */
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function oneLine(text, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The concatenated `text` of a content payload, tolerating a plain string. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** Absolute project path → its last segment, for compact display. */
function projectOf(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  const trimmed = cwd.replace(/[/\\]+$/, "");
  return basename(trimmed) || trimmed;
}

/** Run `worker` over `items` with a bounded number of in-flight promises. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    new Array(width).fill(null).map(async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index], index);
        } catch {
          results[index] = null;
        }
      }
    }),
  );
  return results;
}

/** Recursively collect matching files under `root`, bounded on both axes. */
async function walk(root, match, { maxFiles = 4000, maxDepth = 8 } = {}) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: path, depth: depth + 1 });
      } else if (entry.isFile() && match(path, entry.name)) {
        found.push(path);
      }
    }
  }
  return found;
}

/**
 * Read at most `bytes` from the head of a file, looping over short reads.
 *
 * @returns {{ text: string, filled: boolean }} `filled` is false when the file
 * ended before the cap, which is how callers detect they saw the whole file.
 */
async function readHead(path, bytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    let total = 0;
    while (total < bytes) {
      const { bytesRead } = await handle.read(buffer, total, bytes - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return { text: buffer.subarray(0, total).toString("utf8"), filled: total >= bytes };
  } finally {
    await handle.close();
  }
}

/** Drop a trailing line that the byte cap cut in half. */
function dropPartialLine(text) {
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? "" : text.slice(0, cut + 1);
}

/**
 * Read a prefix of a JSONL file, growing the read until `complete` says the
 * events already answer everything the listing needs — or until `max`.
 *
 * The trailing partial line is always discarded, so a cap that lands inside a
 * long record never costs us that record.
 *
 * @returns {{ events: unknown[], truncated: boolean }}
 */
async function readPrefix(file, { start, max, complete }) {
  let size = start;
  for (;;) {
    const { text: raw, filled } = await readHead(file, size);
    const truncated = filled;
    const text = truncated ? dropPartialLine(raw) : raw;
    const events = parseJsonl(text);
    if (!truncated || size >= max || complete(events)) return { events, truncated };
    size = Math.min(size * 4, max);
  }
}

/** Parse JSONL, skipping anything that is not a complete JSON record. */
function parseJsonl(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* A partially written tail line is expected on a live session. */
    }
  }
  return events;
}

/**
 * Decode a Zstandard file made of **concatenated frames**.
 *
 * DSH appends one frame per flush and Node's `zstdDecompressSync` stops after
 * the first, so frames are located by magic number. A magic number occurring
 * inside compressed payload is harmless: the slice ending there fails to
 * decode and the next candidate boundary is tried instead.
 */
function decodeZstdFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const boundaries = [];
  for (let at = buffer.indexOf(MAGIC, 0); at >= 0; at = buffer.indexOf(MAGIC, at + 4)) {
    boundaries.push(at);
  }
  if (boundaries.length === 0) return zlib.zstdDecompressSync(buffer);

  const parts = [];
  let position = boundaries[0];
  while (position < buffer.length) {
    const candidates = boundaries.filter((at) => at > position);
    candidates.push(buffer.length);
    let advanced = false;
    for (const end of candidates) {
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(position, end)));
        position = end;
        advanced = true;
        break;
      } catch {
        /* Not a frame boundary — widen and retry. */
      }
    }
    if (!advanced) break;
  }
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * Normalized card
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} SessionCard
 * @property {string} key          Stable identity: `<agent>:<file>`.
 * @property {string} agent        `dsh` | `claude` | `codex` | `gemini`.
 * @property {string} agentLabel   Human label for the source.
 * @property {string|null} sessionId
 * @property {string} title
 * @property {string|null} cwd
 * @property {string|null} project Last segment of `cwd`.
 * @property {number|null} createdAt
 * @property {number|null} updatedAt
 * @property {number} bytes
 * @property {number} messages     Lower bound when `partial` is true.
 * @property {boolean} partial     True when only a prefix of the file was read.
 * @property {string} file         Absolute path of the raw session store.
 * @property {string|null} resumeCommand
 */

/* ------------------------------------------------------------------ *
 * Source: DSH
 * ------------------------------------------------------------------ */

/** DSH stores one zstd-framed JSONL file per session; the whole file is read. */
async function buildDsh(file, stats) {
  const text = decodeZstdFrames(await readFile(file)).toString("utf8");
  const events = parseJsonl(text);

  const header = events.find((event) => event.type === "session") ?? {};
  // DSH titles are log-backed and "newest wins": a `provider` (LLM) title can
  // replace the `fallback`, and a `user` rename supersedes both. So the last
  // title event is the current one — except a fallback that merely echoed an
  // injected prompt, which is dropped in favour of this plugin's own reading.
  const titleEvents = events.filter(
    (event) => event.type === "session/title" && typeof event.data?.title === "string" && event.data.title !== "",
  );
  const dshTitle = titleEvents.length > 0 ? titleEvents[titleEvents.length - 1].data.title : "";

  const lines = [];
  let messages = 0;
  let assistantTitle = "";
  for (const event of events) {
    if (event.type === "user/message") {
      if (event.data?.role !== "user" && event.data?.source?.kind !== "user") continue;
      const body = textOf(event.data?.content);
      if (body === "" || looksInjected(body)) continue;
      messages += 1;
      lines.push("## User", "", body, "");
    } else if (event.type === "assistant/message") {
      const body = textOf(event.data?.message?.content);
      if (body === "") continue;
      if (assistantTitle === "") assistantTitle = body;
      messages += 1;
      lines.push("## Assistant", "", body, "");
    } else if (event.type === "tool/call") {
      lines.push(`> tool: \`${event.data?.name ?? "tool"}\``, "");
    }
  }

  /**
   * A subagent session's first "human" message is the prompt its parent
   * delegated to it — instructions, not conversation. Titling from it produces
   * rows like "You are researching the DeepSeek…", so those sessions fall back
   * to what the subagent actually said it would do.
   */
  const isSubagent = header.origin === "subagent" || (Number(header.delegationDepth) || 0) > 0;

  const recorded = isSubagent || looksInjected(dshTitle) ? "" : oneLine(dshTitle, 140);
  const cwd = typeof header.cwd === "string" ? header.cwd : null;
  const createdAt = toMs(header.createdAt) ?? Math.round(stats.birthtimeMs ?? 0) ?? null;
  const human = isSubagent
    ? undefined
    : events.find((event) => event.type === "user/message" && !looksInjected(textOf(event.data?.content)));

  return {
    card: {
      key: `dsh:${file}`,
      agent: "dsh",
      agentLabel: AGENT_LABELS.dsh,
      sessionId: typeof header.id === "string" ? header.id : basename(dirname(file)),
      title: recorded || oneLine(textOf(human?.data?.content), 140) || oneLine(assistantTitle, 140) || UNTITLED,
      cwd,
      project: projectOf(cwd),
      createdAt,
      updatedAt: Math.round(stats.mtimeMs ?? createdAt ?? 0) || null,
      bytes: stats.size ?? 0,
      messages,
      partial: false,
      subagent: isSubagent,
      parentSessionId: typeof header.parentSession === "string" ? header.parentSession : null,
      depth: Number(header.delegationDepth) || 0,
      file,
      resumeCommand: null,
    },
    body: lines.join("\n").trimEnd(),
    meta: { agentPreset: header.agentPreset ?? null, formatVersion: header.version ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Source: Claude Code
 * ------------------------------------------------------------------ */

/** Claude's first human message can carry a platform wrapper; keep the question. */
function claudeUserText(text) {
  if (typeof text !== "string") return "";
  const query = /<userQuery>([\s\S]*?)<\/userQuery>/.exec(text);
  const body = query ? query[1] : text.replace(/<bizContext>[\s\S]*?<\/bizContext>/g, "");
  return body.trim();
}

function buildClaude(file, stats, events, truncated) {
  let sessionId = null;
  let cwd = null;
  let title = "";
  let assistantTitle = "";
  let createdAt = null;
  let messages = 0;
  const lines = [];

  for (const event of events) {
    if (sessionId === null && typeof event.sessionId === "string") sessionId = event.sessionId;
    if (cwd === null && typeof event.cwd === "string") cwd = event.cwd;
    const at = toMs(event.timestamp);
    if (at !== null && (createdAt === null || at < createdAt)) createdAt = at;

    if (event.type === "ai-title") {
      // Claude regenerates its own title as the conversation evolves, so the
      // newest one wins — taking the first would freeze an early guess.
      const candidate = event.aiTitle ?? event.title;
      if (typeof candidate === "string" && candidate !== "") title = oneLine(candidate, 140);
      continue;
    }
    // `last-prompt` repeats the user's latest prompt, not a title.
    if (event.type === "last-prompt") continue;
    if (event.type === "user") {
      const blocks = event.message?.content;
      if (Array.isArray(blocks) && blocks.some((block) => block?.type === "tool_result")) continue;
      const body = claudeUserText(textOf(blocks));
      if (body === "" || looksInjected(body)) continue;
      messages += 1;
      lines.push("## User", "", body, "");
    } else if (event.type === "assistant") {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const body = textOf(blocks);
      const tools = blocks.filter((block) => block?.type === "tool_use").map((block) => block.name);
      if (body === "" && tools.length === 0) continue;
      if (assistantTitle === "" && body !== "") assistantTitle = body;
      messages += 1;
      if (body !== "") lines.push("## Assistant", "", body, "");
      for (const tool of tools) lines.push(`> tool: \`${tool}\``, "");
    }
  }

  if (sessionId === null) sessionId = basename(file, ".jsonl");
  if (title === "") {
    const firstUser = events.find((event) => {
      if (event.type !== "user") return false;
      const body = claudeUserText(textOf(event.message?.content));
      return body !== "" && !looksInjected(body);
    });
    title = oneLine(claudeUserText(textOf(firstUser?.message?.content)), 140);
  }
  if (cwd === null) cwd = claudeProjectPath(file);

  const created = createdAt ?? Math.round(stats.birthtimeMs ?? 0) ?? null;
  return {
    card: {
      key: `claude:${file}`,
      agent: "claude",
      agentLabel: AGENT_LABELS.claude,
      sessionId,
      title: title || oneLine(assistantTitle, 140) || UNTITLED,
      cwd,
      project: projectOf(cwd),
      createdAt: created,
      updatedAt: Math.round(stats.mtimeMs ?? created ?? 0) || null,
      bytes: stats.size ?? 0,
      messages,
      partial: truncated,
      file,
      resumeCommand: sessionId ? `claude --resume ${sessionId}` : null,
    },
    body: lines.join("\n").trimEnd(),
    meta: {},
  };
}

/**
 * Claude's project directory name is the project path with separators replaced
 * by `-`; it is only a fallback for when no event carried a `cwd`.
 */
function claudeProjectPath(file) {
  const slug = basename(dirname(file));
  if (!slug.startsWith("-")) return null;
  const guess = slug.replace(/-/g, "/");
  return guess.startsWith("/") ? guess : null;
}

/* ------------------------------------------------------------------ *
 * Source: Codex CLI
 * ------------------------------------------------------------------ */

/**
 * Codex writes its model-generated thread names to its own index rather than
 * into the rollout file:
 *
 *   ~/.codex/session_index.jsonl
 *   {"id":"<session id>","thread_name":"编写 SkillStudio 使用说明","updated_at":"…"}
 *
 * This is the closest thing Codex has to an AI title, and it beats anything
 * derived from the first message, so it is read once per scan.
 */
const codexIndex = { at: 0, value: null };

function codexThreadNames() {
  const now = Date.now();
  if (codexIndex.value !== null && now - codexIndex.at < 5000) return codexIndex.value;

  const names = new Map();
  try {
    const text = readFileSync(join(home(), ".codex", "session_index.jsonl"), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.id === "string" && typeof row?.thread_name === "string" && row.thread_name !== "") {
          names.set(row.id, row.thread_name);
        }
      } catch {
        /* A partially written tail line is expected. */
      }
    }
  } catch {
    /* Codex may not be installed, or may keep no index. */
  }

  codexIndex.value = names;
  codexIndex.at = now;
  return names;
}

/**
 * Agents open a session by *injecting* instruction, environment, reference and
 * delegation text as a user-role message before the human speaks. Those blocks
 * are not conversation: they must not become the title, and they would swamp
 * the transcript.
 *
 * Every marker here comes from a real session on this machine. The generic tag
 * rule insists on a `-` or `_` inside the tag name, so a user pasting `<div>`
 * or `<html>` at position zero still reads as their own words.
 */
function looksInjected(text) {
  const head = String(text ?? "").slice(0, 800);
  return (
    /^<[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[ >]/i.test(head) ||
    /^#{1,3}\s*(AGENTS\.md instructions|CLAUDE\.md|Referenced chats|Context Usage|Code review guidelines)/i.test(head) ||
    /^Current runtime context/i.test(head) ||
    /^Caveat: The messages below were generated/i.test(head) ||
    /<INSTRUCTIONS>/.test(head) ||
    /<environment_context>/.test(head) ||
    /<user_instructions>/.test(head) ||
    /<app-context>/.test(head) ||
    /<multi_agent_/.test(head) ||
    /<session_context>/.test(head)
  );
}

function codexUserText(payload) {
  const body = textOf(payload?.content);
  return looksInjected(body) ? "" : body;
}

function buildCodex(file, stats, events, truncated) {
  const meta = events.find((event) => event.type === "session_meta")?.payload ?? {};
  const sessionId = meta.session_id ?? meta.id ?? basename(file, ".jsonl");
  const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
  const created = toMs(meta.timestamp) ?? Math.round(stats.birthtimeMs ?? 0) ?? null;

  const lines = [];
  let title = "";
  let assistantTitle = "";
  let messages = 0;

  for (const event of events) {
    if (event.type !== "response_item") continue;
    const payload = event.payload ?? {};
    if (payload.type !== "message") continue;

    if (payload.role === "user") {
      const body = codexUserText(payload);
      if (body === "") continue;
      messages += 1;
      if (title === "") title = oneLine(body, 140);
      lines.push("## User", "", body, "");
    } else if (payload.role === "assistant") {
      const body = textOf(payload.content);
      if (body === "") continue;
      if (assistantTitle === "") assistantTitle = body;
      messages += 1;
      lines.push("## Assistant", "", body, "");
    }
  }

  return {
    card: {
      key: `codex:${file}`,
      agent: "codex",
      agentLabel: AGENT_LABELS.codex,
      sessionId,
      title: codexThreadNames().get(sessionId) ?? (title || oneLine(assistantTitle, 140) || UNTITLED),
      cwd,
      project: projectOf(cwd),
      createdAt: created,
      updatedAt: Math.round(stats.mtimeMs ?? created ?? 0) || null,
      bytes: stats.size ?? 0,
      messages,
      partial: truncated,
      file,
      resumeCommand: sessionId ? `codex resume ${sessionId}` : null,
    },
    body: lines.join("\n").trimEnd(),
    meta: { cliVersion: meta.cli_version ?? null, originator: meta.originator ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Source: Gemini CLI
 * ------------------------------------------------------------------ */

/**
 * A Gemini chat file interleaves patch records: an initial `$set.messages`, then
 * one standalone message object per later turn, with small `$set` patches in
 * between. A prefix therefore yields the opening messages, and a full read
 * yields all of them.
 */
function buildGemini(file, stats, events, truncated) {
  const header = events[0] ?? {};
  const sessionId = header.sessionId ?? basename(file, ".jsonl");
  const created = toMs(header.startTime) ?? Math.round(stats.birthtimeMs ?? 0) ?? null;

  // A prefix cannot see the consolidating patch at the tail; a full read can.
  const messages = geminiMessageList(events, truncated);

  const lines = [];
  let title = "";
  let assistantTitle = "";
  let count = 0;
  for (const message of messages) {
    const body = textOf(message?.content)
      .replace(/<session_context>[\s\S]*?<\/session_context>/g, "")
      .trim();
    if (body === "") continue;
    const isHuman = message?.type === "user";
    count += 1;
    if (isHuman) {
      if (title === "") title = oneLine(body, 140);
    } else if (assistantTitle === "") {
      assistantTitle = body;
    }
    lines.push(isHuman ? "## User" : "## Assistant", "", body, "");
  }

  const cwd = geminiProjectPath(dirname(dirname(file)));
  return {
    card: {
      key: `gemini:${file}`,
      agent: "gemini",
      agentLabel: AGENT_LABELS.gemini,
      sessionId,
      title: title || oneLine(assistantTitle, 140) || UNTITLED,
      cwd,
      project: projectOf(cwd),
      createdAt: created,
      updatedAt: toMs(header.lastUpdated) ?? (Math.round(stats.mtimeMs ?? created ?? 0) || null),
      bytes: stats.size ?? 0,
      messages: count,
      partial: truncated,
      file,
      resumeCommand: sessionId ? `gemini --resume ${sessionId}` : null,
    },
    body: lines.join("\n").trimEnd(),
    meta: {},
  };
}

/**
 * Gemini records the project root as the directory the chat file's parent is
 * named after, and mirrors it in a `.project_root` file.
 */
function geminiProjectPath(sessionDir) {
  for (const candidate of [`${sessionDir}/.project_root`, `${dirname(sessionDir)}/.project_root`]) {
    try {
      const text = readFileSync(candidate, "utf8").trim();
      if (text !== "") return text;
    } catch {
      /* Optional file. */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Live state — the DSH registry, the process table, and cmux's hook records
 * ------------------------------------------------------------------ */

/**
 * Which agent a live process is, by its executable name.
 *
 * The process table is the primary liveness source because most agents are
 * started straight from a terminal, with nothing cooperating. cmux's hook
 * records only ever see the agents that cmux launched, so they are an
 * enrichment rather than the foundation.
 */
const AGENT_EXECUTABLES = ["claude", "codex", "gemini", "pi", "opencode"];

const PROCESS_TTL_MS = 2000;
const processCache = { at: 0, value: [] };

/**
 * The session id an agent process names on its command line, if any.
 *
 * Claude and Gemini take `--resume <id>`; Codex takes `resume <id>` as a
 * subcommand. A fresh run names nothing, which is why the workspace fallback
 * below exists.
 */
function sessionIdFromArgs(args) {
  const tokens = String(args ?? "").split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^--(?:resume|session-id)=(.+)$/.exec(token);
    if (inline !== null) return inline[1];
    if (token === "--resume" || token === "--session-id" || token === "resume") {
      const next = tokens[index + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) return next;
    }
  }
  return null;
}

/** The working directory of a live process, which is how a fresh run is matched. */
async function cwdOf(pid) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    /* lsof may be denied, or the process may have exited between the calls. */
  }
  return null;
}

/**
 * Whether a process name *names* this agent, rather than merely containing it.
 *
 * The delimiters matter: a plain `includes("pi")` would claim `apiserver`, and
 * `xcode` would be read as `codex`.
 */
function namesAgent(text, agent) {
  return new RegExp(`(?:^|[-_.])${agent}(?:$|[-_.])`, "i").test(text);
}

/** A path with symlinks resolved; `lsof` already reports it this way. */
const canonicalCache = new Map();
async function canonical(path) {
  if (typeof path !== "string" || path === "") return path;
  const hit = canonicalCache.get(path);
  if (hit !== undefined) return hit;
  let value = path;
  try {
    value = await realpath(path);
  } catch {
    /* A path that no longer exists stays as written. */
  }
  canonicalCache.set(path, value);
  return value;
}

/**
 * Seconds from a `ps` `etime` field: `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS`.
 *
 * @returns {number|null} Elapsed seconds, or null when the field is not one of
 *   those shapes.
 */
function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? "").trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Every live agent process on this machine, refreshed on a short interval. */
async function scanAgentProcesses() {
  const now = Date.now();
  if (now - processCache.at < PROCESS_TTL_MS) return processCache.value;

  const found = [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,etime=,command="], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      // `ps` prints " <pid> <etime> <executable> <args…>".
      const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
      if (match === null) continue;
      const pid = Number(match[1]);
      const elapsed = parseEtime(match[2]);
      const args = match[4] ?? "";

      // The executable, and the script it may hand off to: macOS reports a
      // shebang script as `/bin/sh /path/to/agent`, and a wrapper as
      // `node /path/to/claude-wrapper`, so the executable alone is `sh` or
      // `node` and matches nothing. Only the *first* argument is considered, so
      // a later argument that merely mentions an agent name is not a match.
      const argv = args.split(/\s+/).filter(Boolean);
      const names = [basename(match[3]), argv[0] === undefined ? null : basename(argv[0])];
      const agent = AGENT_EXECUTABLES.find((name) => names.some((candidate) => candidate !== null && namesAgent(candidate, name)));
      if (agent === undefined || !Number.isInteger(pid) || pid <= 0) continue;

      found.push({
        agent,
        pid,
        args,
        sessionId: sessionIdFromArgs(args),
        cwd: null,
        // How long the process has been up, straight from the process table.
        startedAt: elapsed === null ? null : Date.now() - elapsed * 1000,
      });
    }
  } catch {
    /* No `ps` — the other two sources still work. */
  }

  // Only a process that could not name its session needs a directory lookup.
  await mapLimit(found, 4, async (entry) => {
    if (entry.sessionId === null) entry.cwd = await cwdOf(entry.pid);
    return entry;
  });

  processCache.value = found;
  processCache.at = now;
  return found;
}

/**
 * Attach each live process to the session it belongs to.
 *
 * An exact `--resume <id>` match wins. A fresh run names nothing, so it is
 * matched by workspace to the *newest* session there — which, for an agent that
 * just started, is the session it created.
 */
async function linkProcesses(cards, processes) {
  for (const card of cards) delete card.process;

  const bySession = new Map();
  for (const card of cards) {
    if (typeof card.sessionId === "string") bySession.set(`${card.agent}:${card.sessionId}`, card);
  }

  const claimed = new Set();
  for (const entry of processes) {
    if (entry.sessionId === null) continue;
    const card = bySession.get(`${entry.agent}:${entry.sessionId}`);
    if (card !== undefined && card.process === undefined) {
      card.process = entry;
      claimed.add(entry);
    }
  }

  // `cards` is newest-first, so the first match is the most recent session there.
  for (const entry of processes) {
    if (claimed.has(entry) || entry.sessionId !== null || entry.cwd === null) continue;
    const sameAgent = cards.filter((card) => card.agent === entry.agent && card.process === undefined);

    let card = sameAgent.find((candidate) => candidate.cwd === entry.cwd);
    if (card === undefined) {
      // `lsof` reports a canonical path while an agent may have recorded a
      // symlinked one — `/tmp` is `/private/tmp` on macOS — so the fallback
      // compares both sides with symlinks resolved.
      const target = await canonical(entry.cwd);
      for (const candidate of sameAgent) {
        if ((await canonical(candidate.cwd)) === target) {
          card = candidate;
          break;
        }
      }
    }

    if (card !== undefined) {
      card.process = entry;
      claimed.add(entry);
    }
  }
}

/**
 * cmux is a terminal that installs agent hooks (`SessionStart`, `Stop`,
 * `Notification`, …). Its CLI can print the resulting records as JSON without a
 * running cmux socket. It is kept as a *second* source: it carries a session id
 * and a pid for agents cmux launched, which the process table alone cannot
 * always map.
 *
 * The record's `agent_lifecycle` alone is NOT trustworthy: a Stop hook that
 * never fired leaves `running` behind forever. The process id is the real
 * signal, so liveness is decided by the pid, and the lifecycle is only carried
 * along as a hint.
 */
const CMUX_TTL_MS = 2000;
const cmuxCache = { at: 0, value: null };
let cmuxCliPath;

/** Locate the cmux CLI: the bundled one, or whatever PATH provides. */
function resolveCmuxCli() {
  if (cmuxCliPath !== undefined) return cmuxCliPath;
  const candidates = [];
  if (typeof process.env.CMUX_BUNDLED_CLI_PATH === "string" && process.env.CMUX_BUNDLED_CLI_PATH !== "") {
    candidates.push(process.env.CMUX_BUNDLED_CLI_PATH);
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "") candidates.push(join(dir, "cmux"));
  }
  candidates.push("/Applications/cmux.app/Contents/Resources/bin/cmux");

  cmuxCliPath =
    candidates.find((candidate) => {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null;
  return cmuxCliPath;
}

/** Whether a recorded pid still names a live process. `EPERM` means it exists. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * cmux's agent session records, keyed `<agent>:<sessionId>` and cached briefly
 * so a polling client does not spawn a process per request.
 */
async function readCmuxSessions(force) {
  const now = Date.now();
  if (!force && cmuxCache.value !== null && now - cmuxCache.at < CMUX_TTL_MS) return cmuxCache.value;

  const cli = resolveCmuxCli();
  const records = new Map();
  if (cli !== null) {
    try {
      const { stdout } = await execFileAsync(cli, ["sessions", "list", "--json", "--limit", "500"], {
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const row of JSON.parse(stdout)?.sessions ?? []) {
        if (typeof row?.session_id !== "string" || typeof row?.agent !== "string") continue;
        records.set(`${row.agent}:${row.session_id}`, row);
      }
    } catch {
      /* cmux absent, too old, or unhappy — an empty map is a valid answer. */
    }
  }
  cmuxCache.value = records;
  cmuxCache.at = now;
  return records;
}

/**
 * The live state of one card.
 *
 * DSH sessions are read from the in-process agent registry, which is exact. Every
 * other agent is matched against cmux's hook records by `<agent>:<sessionId>`.
 *
 * @returns {{ running: boolean, source: string|null, lifecycle: string|null, surfaceId?: string|null, launchArguments?: string[]|null }}
 */
function liveOf(card, cmuxRecords, ctx) {
  if (card.agent === "dsh") {
    // `ctx.get` is the optional-service lookup the runtime itself uses, so an
    // absent registry degrades to "unknown" instead of throwing.
    const registry = ctx?.get?.("agents");
    const agent = registry?.get?.(card.sessionId);
    const status = typeof agent?.status === "string" ? agent.status : null;
    return { running: status === "running", source: status === null ? null : "dsh", lifecycle: status };
  }

  // A live process is the strongest evidence, and the only one that sees an
  // agent started straight from a terminal with nothing cooperating.
  if (card.process !== undefined) {
    return {
      running: true,
      source: "process",
      pid: card.process.pid,
      lifecycle: null,
      sessionNamed: card.process.sessionId !== null,
    };
  }

  // cmux's record carries a session id and a pid for what cmux launched.
  const row = cmuxRecords.get(`${card.agent}:${card.sessionId}`);
  if (row === undefined) return { running: false, source: null, lifecycle: null };
  if (row.stored_pid_exists === true || pidAlive(row.pid)) {
    return {
      running: true,
      source: "cmux",
      pid: row.pid,
      lifecycle: typeof row.agent_lifecycle === "string" ? row.agent_lifecycle : null,
      surfaceId: typeof row.surface_id === "string" ? row.surface_id : null,
      launchArguments: Array.isArray(row.launch_arguments) ? row.launch_arguments : null,
    };
  }

  // The record claims a lifecycle but its pid is gone: a Stop hook that never
  // fired. Reported as not running, with the stale lifecycle kept as context.
  return {
    running: false,
    source: null,
    lifecycle: typeof row.agent_lifecycle === "string" ? row.agent_lifecycle : null,
  };
}

/**
 * Refresh liveness across a set of cards from every source.
 *
 * The process table is read first so each card can be linked to the session it
 * owns before the per-card verdict is taken.
 */
async function refreshLive(ctx, cards, force = false) {
  if (force) {
    cmuxCache.at = 0;
    processCache.at = 0;
  }
  const [cmuxRecords, processes] = await Promise.all([readCmuxSessions(force), scanAgentProcesses()]);
  await linkProcesses(cards, processes);
  for (const card of cards) decorate(card, cmuxRecords, ctx);
  return cards;
}

/* ------------------------------------------------------------------ *
 * The inventory
 * ------------------------------------------------------------------ */

/**
 * Every source: its root, its file matcher, how large a listing prefix to read,
 * when that prefix is already sufficient, and how to build a value from text.
 */
/* ------------------------------------------------------------------ *
 * Source: pi
 * ------------------------------------------------------------------ */

/**
 * pi keeps one JSONL file per session under
 * `~/.pi/agent/sessions/<workspace-slug>/<timestamp>_<id>.jsonl`.
 *
 * The header is close to DSH's (`type` / `id` / `timestamp` / `cwd`) and each
 * turn is a `message` row whose `message.content` is a block list — so this is
 * deliberately the same shape of parser rather than a new dialect.
 */
function buildPi(file, stats, events, truncated) {
  const header = events.find((event) => event.type === "session") ?? {};
  const sessionId = typeof header.id === "string" ? header.id : basename(file, ".jsonl");
  const cwd = typeof header.cwd === "string" ? header.cwd : null;
  const created = toMs(header.timestamp) ?? Math.round(stats.birthtimeMs ?? 0) ?? null;

  const lines = [];
  let title = "";
  let assistantTitle = "";
  let messages = 0;

  for (const event of events) {
    if (event.type !== "message") continue;
    const payload = event.message ?? {};
    const body = textOf(payload.content);
    if (body === "") continue;
    if (payload.role === "user") {
      if (looksInjected(body)) continue;
      messages += 1;
      if (title === "") title = oneLine(body, 140);
      lines.push("## User", "", body, "");
    } else if (payload.role === "assistant") {
      messages += 1;
      if (assistantTitle === "") assistantTitle = body;
      lines.push("## Assistant", "", body, "");
    }
  }

  return {
    card: {
      key: `pi:${file}`,
      agent: "pi",
      agentLabel: AGENT_LABELS.pi,
      sessionId,
      title: title || oneLine(assistantTitle, 140) || UNTITLED,
      cwd,
      project: projectOf(cwd),
      createdAt: created,
      updatedAt: Math.round(stats.mtimeMs ?? created ?? 0) || null,
      bytes: stats.size ?? 0,
      messages,
      partial: truncated,
      subagent: false,
      parentSessionId: null,
      depth: 0,
      file,
      resumeCommand: sessionId ? `pi --session ${sessionId}` : null,
    },
    body: lines.join("\n").trimEnd(),
    meta: { formatVersion: header.version ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Source: opencode
 * ------------------------------------------------------------------ */

/**
 * opencode stores every session in one SQLite database rather than one file per
 * session, so this source does not fit the walk-a-directory shape at all: it
 * queries, reads and deletes by session id.
 *
 * `node:sqlite` ships with the runtime, and is imported lazily so a machine
 * without opencode (or on an older Node) simply has no rows here.
 */
const OPENCODE_STAMP_TTL_MS = 2000;

function opencodeDbPath() {
  return join(home(), ".local", "share", "opencode", "opencode.db");
}

/** Open the database, or return null when it is absent or unreadable. */
async function openOpencode({ readOnly }) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(opencodeDbPath(), { readOnly });
  } catch {
    return null;
  }
}

/** The concatenated text of one message's `part` rows. */
function opencodeText(parts) {
  const chunks = [];
  for (const row of parts) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data?.type === "text" && typeof data.text === "string") chunks.push(data.text);
  }
  return chunks.join("\n").trim();
}

/** One card per session row, without reading any message bodies. */
async function listOpencode() {
  const db = await openOpencode({ readOnly: true });
  if (db === null) return [];
  try {
    const rows = db
      .prepare("select id, parent_id, directory, title, time_created, time_updated from session")
      .all();
    const counts = new Map(
      db
        .prepare("select session_id, count(*) as n from message group by session_id")
        .all()
        .map((row) => [row.session_id, row.n]),
    );

    return rows.map((row) => ({
      card: {
        key: `opencode:${row.id}`,
        agent: "opencode",
        agentLabel: AGENT_LABELS.opencode,
        sessionId: row.id,
        title: typeof row.title === "string" && row.title !== "" ? oneLine(row.title, 140) : UNTITLED,
        cwd: typeof row.directory === "string" ? row.directory : null,
        project: projectOf(row.directory),
        createdAt: Number(row.time_created) || null,
        updatedAt: Number(row.time_updated) || null,
        // A row has no byte size; the panel renders that as "—".
        bytes: 0,
        messages: counts.get(row.id) ?? 0,
        // Sessions are read completely in one query, so nothing is a prefix.
        partial: false,
        subagent: row.parent_id !== null,
        parentSessionId: typeof row.parent_id === "string" ? row.parent_id : null,
        depth: 0,
        file: opencodeDbPath(),
        resumeCommand: `opencode --session ${row.id}`,
      },
      body: "",
      meta: {},
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Read one opencode session in full, for the transcript and the preview. */
async function readOpencode(sessionId, { withBody }) {
  const db = await openOpencode({ readOnly: true });
  if (db === null) return null;
  try {
    const row = db.prepare("select * from session where id = ?").get(sessionId);
    if (row === undefined) return null;

    const messages = db
      .prepare("select id, data from message where session_id = ? order by time_created, id")
      .all(sessionId);
    const parts = db
      .prepare("select message_id, data from part where session_id = ? order by time_created, id")
      .all(sessionId);
    const byMessage = new Map();
    for (const part of parts) {
      if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
      byMessage.get(part.message_id).push(part);
    }

    let input = null;
    let output = null;
    const lines = [];
    let count = 0;
    for (const message of messages) {
      let meta;
      try {
        meta = JSON.parse(message.data);
      } catch {
        continue;
      }
      const body = opencodeText(byMessage.get(message.id) ?? []);
      if (body === "") continue;
      if (meta?.role === "user") {
        if (looksInjected(body)) continue;
        count += 1;
        if (input === null) input = body;
        if (withBody) lines.push("## User", "", body, "");
      } else if (meta?.role === "assistant") {
        count += 1;
        output = body;
        if (withBody) lines.push("## Assistant", "", body, "");
      }
    }

    const card = {
      key: `opencode:${row.id}`,
      agent: "opencode",
      agentLabel: AGENT_LABELS.opencode,
      sessionId: row.id,
      title:
        typeof row.title === "string" && row.title !== "" ? oneLine(row.title, 140) : oneLine(input ?? "", 140) || UNTITLED,
      cwd: typeof row.directory === "string" ? row.directory : null,
      project: projectOf(row.directory),
      createdAt: Number(row.time_created) || null,
      updatedAt: Number(row.time_updated) || null,
      bytes: 0,
      messages: count,
      partial: false,
      subagent: row.parent_id !== null,
      parentSessionId: typeof row.parent_id === "string" ? row.parent_id : null,
      depth: 0,
      file: opencodeDbPath(),
      resumeCommand: `opencode --session ${row.id}`,
    };
    return { card, body: lines.join("\n").trimEnd(), meta: { preview: { input, output } } };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Delete one opencode session.
 *
 * opencode owns this database and may be writing to it, so the caller's
 * running-process guard is what keeps this safe; the three deletes run in one
 * transaction so a failure cannot leave a session half-removed.
 */
async function removeOpencode(sessionId) {
  const db = await openOpencode({ readOnly: false });
  if (db === null) throw new Error("opencode database is not readable");
  try {
    db.exec("begin");
    db.prepare("delete from part where session_id = ?").run(sessionId);
    db.prepare("delete from message where session_id = ?").run(sessionId);
    db.prepare("delete from session where id = ?").run(sessionId);
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      /* The transaction may already be gone. */
    }
    throw error;
  } finally {
    db.close();
  }
}

const SOURCES = [
  {
    id: "dsh",
    root: () => join(dshHome(), "sessions"),
    match: (name) => name.endsWith(".jsonl.zstd"),
    concurrency: 4,
    build: buildDsh,
  },
  {
    id: "claude",
    root: () => join(home(), ".claude", "projects"),
    match: (name) => name.endsWith(".jsonl"),
    concurrency: 16,
    prefix: { start: 131072, max: 2097152, complete: (events) => hasClaudeSignal(events) },
    build: buildClaude,
  },
  {
    id: "codex",
    root: () => join(home(), ".codex", "sessions"),
    match: (name) => name.endsWith(".jsonl"),
    concurrency: 16,
    prefix: { start: 131072, max: 2097152, complete: (events) => hasCodexSignal(events) },
    build: buildCodex,
  },
  {
    id: "gemini",
    root: () => join(home(), ".gemini", "tmp"),
    match: (name) => name.endsWith(".jsonl"),
    concurrency: 8,
    prefix: { start: 131072, max: 2097152, complete: (events) => hasGeminiSignal(events) },
    build: buildGemini,
  },
  {
    id: "pi",
    root: () => join(home(), ".pi", "agent", "sessions"),
    match: (name) => name.endsWith(".jsonl"),
    concurrency: 8,
    // `pi` records no title of its own, so the first human message is the gate.
    prefix: { start: 131072, max: 2097152, complete: (events) => hasPiSignal(events) },
    build: buildPi,
  },
  {
    id: "opencode",
    // A SQLite store: this source answers with its own list/read/delete rather
    // than a directory walk, so it has no `match` or `build`.
    root: () => dirname(opencodeDbPath()),
    list: () => listOpencode(),
    full: (sessionId) => readOpencode(sessionId, { withBody: true }),
    preview: (card) => readOpencode(card.sessionId, { withBody: false }),
    remove: (card) => removeOpencode(card.sessionId),
  },
];

function hasPiSignal(events) {
  for (const event of events) {
    if (event.type !== "message" || event.message?.role !== "user") continue;
    const body = textOf(event.message.content);
    if (body !== "" && !looksInjected(body)) return true;
  }
  return false;
}

function hasClaudeSignal(events) {
  let human = false;
  let title = false;
  for (const event of events) {
    if (event.type === "ai-title") title = true;
    if (event.type === "user") {
      const body = claudeUserText(textOf(event.message?.content));
      if (body !== "" && !looksInjected(body)) human = true;
    }
  }
  return human || title;
}

function hasCodexSignal(events) {
  let meta = false;
  let human = false;
  for (const event of events) {
    if (event.type === "session_meta") meta = true;
    if (event.type === "response_item" && event.payload?.type === "message" && event.payload?.role === "user") {
      if (codexUserText(event.payload) !== "") human = true;
    }
  }
  return meta && human;
}

function hasGeminiSignal(events) {
  return events.length > 0 && geminiHasText(events);
}

function geminiHasText(events) {
  for (const event of events) {
    if (Array.isArray(event?.$set?.messages)) continue;
    if (event?.type === "user" && textOf(event.content).replace(/<session_context>[\s\S]*?<\/session_context>/g, "").trim() !== "") {
      return true;
    }
  }
  return false;
}

/** Parse a file into a normalized value, reading only as much as needed. */
async function parseValue(source, file, stats, { full }) {
  if (source.prefix === undefined) {
    return source.build(file, stats);
  }
  if (full) {
    return source.build(file, stats, parseJsonl(await readFile(file, "utf8")), false);
  }
  const { events, truncated } = await readPrefix(file, source.prefix);
  return source.build(file, stats, events, truncated);
}

/** File → parsed value, invalidated by mtime + size. */
const cache = new Map();

/** The listing path: cached, prefix-based, cheap. */
async function cachedCard(source, file, force) {
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return null;
  }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const hit = cache.get(file);
  if (!force && hit !== undefined && hit.stamp === stamp) return hit.value;

  const value = await parseValue(source, file, stats, { full: false });
  cache.set(file, { stamp, value });
  return value;
}

/** The most recent inventory, so a lightweight `status` poll can skip the scan. */
let lastCards = [];

/** Decorate one card with its live state, in place. */
function decorate(card, cmuxRecords, ctx) {
  const live = liveOf(card, cmuxRecords, ctx);
  card.live = live;
  card.running = live.running;
  card.subagent = card.subagent === true;
  card.parentKey = typeof card.parentKey === "string" ? card.parentKey : null;
  card.depth = Number.isInteger(card.depth) ? card.depth : 0;
  return card;
}

/**
 * Link subagent sessions to their parents.
 *
 * A subagent is a real session with its own log, so the scanner lists it like
 * any other. Rendering it flat would bury the sessions a person actually
 * started, so the parent link is resolved here once — by session id, within the
 * same agent — and the client draws the family as a tree.
 *
 * A parent that is not in the corpus (filtered out, or pruned from disk) leaves
 * its child as a root rather than hiding it.
 */
function linkFamilies(cards) {
  const keyBySession = new Map();
  for (const card of cards) {
    if (typeof card.sessionId === "string" && card.sessionId !== "") {
      keyBySession.set(`${card.agent}:${card.sessionId}`, card.key);
    }
  }
  for (const card of cards) {
    const parent =
      typeof card.parentSessionId === "string" && card.parentSessionId !== ""
        ? keyBySession.get(`${card.agent}:${card.parentSessionId}`)
        : undefined;
    card.parentKey = parent !== undefined && parent !== card.key ? parent : null;
  }
}

/** Scan every source, attach live state, and return the newest-first inventory. */
/**
 * Whether a workspace is a disposable scratch directory rather than a project.
 *
 * A directory named after a bare UUID is machine-generated: `avp-agent`, for
 * instance, makes one per run under `~/blueai_tmp/avp-agent/cc_sessions/` and
 * starts Claude inside it. Those are not projects. Left in, this one tool's runs
 * alone appeared as 17 separate "projects" named after UUIDs — and their
 * workspaces are useless for resuming into anyway.
 *
 * Measured against this machine's whole corpus (414 sessions): 41 match, and
 * nothing else does, so the rule costs no real project.
 */
const UUID_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isScratchWorkspace(cwd) {
  if (typeof cwd !== "string" || cwd === "") return false;
  return UUID_DIRECTORY.test(cwd.replace(/\/+$/, "").split("/").pop());
}

async function inventory(force, ctx) {
  const cards = [];
  const sources = [];

  for (const source of SOURCES) {
    const root = source.root();
    // A source that owns a non-file store answers with its own list.
    const values =
      typeof source.list === "function"
        ? await source.list(force)
        : await mapLimit(
            await walk(root, (_path, name) => source.match(name)),
            source.concurrency,
            (file) => cachedCard(source, file, force),
          );
    let parsed = 0;
    let skipped = 0;
    for (const value of values) {
      if (value === null || value === undefined) continue;
      // A scratch workspace is not a project; it is counted, not silently lost.
      if (isScratchWorkspace(value.card.cwd)) {
        skipped += 1;
        continue;
      }
      cards.push(value.card);
      parsed += 1;
    }
    sources.push({ id: source.id, label: AGENT_LABELS[source.id], root, total: values.length, parsed, skipped });
  }

  cards.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  linkFamilies(cards);
  await refreshLive(ctx, cards, force);

  lastCards = cards;
  const runningCount = cards.reduce((total, card) => total + (card.running ? 1 : 0), 0);
  return { cards, sources, runningCount, cmux: resolveCmuxCli() !== null, pins: await readPins() };
}

/* ------------------------------------------------------------------ *
 * Transcript materialization
 * ------------------------------------------------------------------ */

/** Resolve one card by key and re-read its store in full. */
async function fullValueByKey(key) {
  for (const source of SOURCES) {
    const prefix = `${source.id}:`;
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    // A source that owns a non-file store re-reads by its own id.
    if (typeof source.full === "function") return await source.full(rest);
    let stats;
    try {
      stats = await stat(rest);
    } catch {
      return null;
    }
    return parseValue(source, rest, stats, { full: true });
  }
  return null;
}

const NOTE = [
  "> Exported by **Session Hub** from another coding agent's own session store.",
  "> It is a faithful but reduced rendering: assistant reasoning, tool results and",
  "> attachments are omitted, and tool activity appears as one-line markers.",
].join("\n");

/** Render the full markdown transcript for one parsed value. */
function transcriptMarkdown(value) {
  const { card, body, meta } = value;
  const facts = [
    `- **agent**: ${card.agentLabel}`,
    `- **session**: \`${card.sessionId ?? "unknown"}\``,
    `- **project**: \`${card.cwd ?? "unknown"}\``,
    `- **created**: ${iso(card.createdAt) ?? "unknown"}`,
    `- **updated**: ${iso(card.updatedAt) ?? "unknown"}`,
    `- **messages**: ${card.messages}`,
    `- **raw store**: \`${card.file}\``,
  ];
  for (const [name, entry] of Object.entries(meta ?? {})) {
    if (entry !== null && entry !== undefined) facts.push(`- **${name}**: ${entry}`);
  }
  return [`# Session: ${card.title}`, "", ...facts, "", NOTE, "", "---", "", body, ""].join("\n");
}

function slug(text, max = 48) {
  const flat = String(text ?? "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (flat.slice(0, max) || "session").toLowerCase();
}

/** The workspace of a live DSH session, read from that session's own header. */
async function dshWorkspaceOf(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const files = await walk(join(dshHome(), "sessions"), (_path, name) => name.endsWith(".jsonl.zstd"));
  const match = files.find((file) => file.includes(`/${sessionId}/`));
  if (match === undefined) return null;
  const cached = cache.get(match)?.value;
  if (cached !== undefined) return cached.card.cwd ?? null;
  const value = await cachedCard(SOURCES[0], match, false);
  return value?.card?.cwd ?? null;
}

/**
 * Write the transcript into the current workspace and return a ready prompt.
 *
 * The destination matters: the file has to land where the receiving agent is
 * allowed to read it, so an explicit `destDir` wins, then the asking session's
 * own workspace, and only then a temporary directory.
 */
async function materialize(value, destDir, currentSessionId) {
  let base = typeof destDir === "string" && destDir.startsWith("/") ? destDir : null;
  if (base === null) base = await dshWorkspaceOf(currentSessionId);
  const inWorkspace = base !== null;
  const dir = join(inWorkspace ? base : tmpdir(), ".dsh-session-hub");

  await mkdir(dir, { recursive: true });
  const short = String(value.card.sessionId ?? "session").replace(/^session-/, "").slice(0, 8);
  const path = join(dir, `${value.card.agent}-${slug(value.card.title)}-${short}.md`);
  await writeFile(path, transcriptMarkdown(value), "utf8");

  const relative = inWorkspace ? path.slice(base.length + 1) : path;
  const prompt = [
    "The session history below is attached as a file. Read it, work out where that",
    "conversation got to, and continue its work here.",
    "",
    `- file: \`${relative}\``,
    `- agent: ${value.card.agentLabel}`,
    `- project: ${value.card.cwd ?? "unknown"}`,
  ].join("\n");
  return { path, relative, prompt, inWorkspace };
}

/* ------------------------------------------------------------------ *
 * Deleting a session
 * ------------------------------------------------------------------ */

/** The store root one agent owns; nothing outside it is ever touched. */
function rootOf(agent) {
  return SOURCES.find((source) => source.id === agent)?.root() ?? null;
}

/**
 * Codex keeps its model-generated thread names in its own index, so removing a
 * rollout without removing its entry leaves the name behind for a session that
 * no longer exists. Rewritten through a temp file so an interrupted write
 * cannot truncate the index.
 */
async function removeCodexIndexEntry(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const path = join(home(), ".codex", "session_index.jsonl");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }

  const kept = [];
  let removed = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      if (JSON.parse(line)?.id === sessionId) {
        removed = true;
        continue;
      }
    } catch {
      /* Keep anything we cannot parse rather than dropping data. */
    }
    kept.push(line);
  }
  if (!removed) return false;

  const temporary = `${path}.dsh-session-hub-${Date.now()}`;
  await writeFile(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
  await rename(temporary, path);
  codexIndex.value = null;
  return true;
}

/**
 * Delete one session from its agent's own store.
 *
 * Three guards, because this is irreversible and touches files that live
 * outside the workspace:
 *
 *   1. the key must resolve to a session this plugin actually listed;
 *   2. the target must sit inside the store root that agent owns;
 *   3. a session whose process is alive is refused unless `force` is set, since
 *      deleting the log from under a running agent is not a normal operation.
 *
 * cmux's hook records are deliberately left alone: they are keyed by session id
 * and only decorate a card, so a stale record for a deleted session is inert,
 * while rewriting a file cmux may be writing is not.
 *
 * @returns {{ target: string, indexEntryRemoved: boolean }}
 */
async function deleteSession(card, force) {
  const source = SOURCES.find((entry) => entry.id === card.agent);
  if (source === undefined) throw new Error(`no store known for agent ${card.agent}`);

  if (card.running === true && force !== true) {
    const error = new Error("session is running");
    error.code = "running";
    throw error;
  }

  // A store that is not a directory of files deletes through its own handle:
  // there is no path to fence, and opencode's transaction is the guard instead.
  if (typeof source.remove === "function") {
    await source.remove(card);
    cache.delete(card.key);
    previewCache.delete(card.key);
    lastCards = lastCards.filter((entry) => entry.key !== card.key);
    return { target: card.sessionId ?? card.key, indexEntryRemoved: false, store: source.id };
  }

  const root = rootOf(card.agent);
  if (root === null) throw new Error(`no store known for agent ${card.agent}`);

  // DSH keeps one directory per session; every other agent keeps one file.
  const target = card.agent === "dsh" ? dirname(card.file) : card.file;
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  if (!target.startsWith(normalizedRoot)) {
    throw new Error(`refusing to delete ${target}: outside ${normalizedRoot}`);
  }

  await rm(target, { recursive: card.agent === "dsh", force: false });

  const indexEntryRemoved = card.agent === "codex" ? await removeCodexIndexEntry(card.sessionId) : false;
  cache.delete(card.file);
  previewCache.delete(card.file);
  lastCards = lastCards.filter((entry) => entry.key !== card.key);
  return { target, indexEntryRemoved };
}

/* ------------------------------------------------------------------ *
 * Pins
 * ------------------------------------------------------------------ */

/**
 * Pins are this plugin's own preference, so they live in its own file rather
 * than in any agent's store — none of them has a "pinned" concept to borrow,
 * and writing into a store another product owns would be rude.
 *
 *   ~/.dsh/session-hub/state.json
 *   { "version": 1, "projects": ["<workspace path>"], "sessions": ["<key>"] }
 */
const pinCache = { at: 0, value: null };

function pinPath() {
  return join(dshHome(), "session-hub", "state.json");
}

function normalizePins(parsed) {
  const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry !== "") : []);
  return { version: 1, projects: strings(parsed?.projects), sessions: strings(parsed?.sessions) };
}

async function readPins() {
  const now = Date.now();
  if (pinCache.value !== null && now - pinCache.at < 2000) return pinCache.value;

  let pins = { version: 1, projects: [], sessions: [] };
  try {
    pins = normalizePins(JSON.parse(await readFile(pinPath(), "utf8")));
  } catch {
    /* No file yet, or an unreadable one — start empty rather than fail. */
  }
  pinCache.value = pins;
  pinCache.at = now;
  return pins;
}

/** Written through a temp file, so an interrupted write cannot lose every pin. */
async function writePins(pins) {
  const path = pinPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  pinCache.value = pins;
  pinCache.at = Date.now();
  return pins;
}

/** Drop the pins of sessions that no longer exist, so the file cannot rot. */
async function prunePins(keys) {
  if (keys.length === 0) return;
  const pins = await readPins();
  const doomed = new Set(keys);
  const kept = pins.sessions.filter((key) => !doomed.has(key));
  if (kept.length === pins.sessions.length) return;
  await writePins({ ...pins, sessions: kept });
}

/**
 * Read the last `bytes` of a file.
 *
 * `fromStart` says whether the window reached the beginning, which is what tells
 * a JSONL reader to trust its first line. Every store here is append-only, so a
 * tail is enough to answer "what is this agent doing right now" without
 * re-reading a 20 MB rollout.
 *
 * @returns {{ buffer: Buffer, fromStart: boolean }}
 */
async function readTail(file, bytes) {
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    const start = Math.max(0, stats.size - bytes);
    const buffer = Buffer.alloc(stats.size - start);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, start + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return { buffer: buffer.subarray(0, total), fromStart: start === 0 };
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ *
 * Live preview — what is each running agent doing right now
 * ------------------------------------------------------------------ */

/** Bounds, so one poll cannot walk the whole disk. */
const MAX_PREVIEWS = 12;
const PREVIEW_TAIL_BYTES = 262144;
const PREVIEW_CHARS = 1200;

/**
 * The hook spool: an append-only JSONL file any agent can write to.
 *
 *   ~/.dsh/session-hub/hooks.jsonl
 *   {"agent":"claude","sessionId":"…","phase":"output","input":"…","output":"…","at":1234567890}
 *
 * A file rather than an HTTP endpoint on purpose: the route lives behind the
 * browser trust fence, and a hook runs as a plain shell command that has no
 * cookie. Anything that can append a line can register — see `hook.mjs`.
 */
function hooksPath() {
  return join(dshHome(), "session-hub", "hooks.jsonl");
}

const hookCache = { at: 0, value: null };

async function readHooks() {
  const now = Date.now();
  if (hookCache.value !== null && now - hookCache.at < 1500) return hookCache.value;

  const hooks = new Map();
  try {
    const { buffer, fromStart } = await readTail(hooksPath(), 512 * 1024);
    let text = buffer.toString("utf8");
    if (!fromStart) text = text.slice(text.indexOf("\n") + 1);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.agent === "string" && typeof row?.sessionId === "string") {
          hooks.set(`${row.agent}:${row.sessionId}`, row);
        }
      } catch {
        /* A half-written tail line is expected while another process appends. */
      }
    }
  } catch {
    /* No spool yet — nothing has registered. */
  }

  hookCache.value = hooks;
  hookCache.at = now;
  return hooks;
}

/** Gemini interleaves a seeded list with appended messages; a prefix sees less. */
function geminiMessageList(events, truncated) {
  let seeded = [];
  let lastSet = [];
  const standalone = [];
  for (const event of events) {
    if (Array.isArray(event?.$set?.messages)) {
      lastSet = event.$set.messages;
      if (seeded.length === 0) seeded = event.$set.messages.slice();
      continue;
    }
    if (Array.isArray(event?.content) && (event.type === "user" || event.type === "model" || event.type === "gemini")) {
      standalone.push(event);
    }
  }
  return !truncated && lastSet.length >= seeded.length + standalone.length ? lastSet : [...seeded, ...standalone];
}

/**
 * The last human input and the last agent output in a run of events.
 *
 * Only the newest of each survives, so this doubles as a tail reducer: the
 * caller can hand it a window and get the current turn out of it.
 */
function previewFrom(agent, events) {
  let input = null;
  let output = null;
  let at = null;
  const stamp = (value) => {
    const ms = toMs(value);
    if (ms !== null) at = Math.max(at ?? 0, ms);
  };

  if (agent === "gemini") {
    for (const message of geminiMessageList(events, false)) {
      const body = textOf(message?.content)
        .replace(/<session_context>[\s\S]*?<\/session_context>/g, "")
        .trim();
      if (body === "") continue;
      if (message?.type === "user") {
        if (!looksInjected(body)) input = body;
      } else {
        output = body;
      }
    }
  } else {
    for (const event of events) {
      if (agent === "dsh") {
        if (event.type === "user/message") {
          const body = textOf(event.data?.content);
          if (body !== "" && !looksInjected(body)) input = body;
        } else if (event.type === "assistant/message") {
          const body = textOf(event.data?.message?.content);
          if (body !== "") output = body;
        }
        stamp(event.time);
      } else if (agent === "claude") {
        if (event.type === "user") {
          const body = claudeUserText(textOf(event.message?.content));
          if (body !== "" && !looksInjected(body)) input = body;
        } else if (event.type === "assistant") {
          const body = textOf(event.message?.content);
          if (body !== "") output = body;
        }
        stamp(event.timestamp);
      } else if (agent === "pi") {
        if (event.type === "message") {
          const body = textOf(event.message?.content);
          if (body !== "") {
            if (event.message?.role === "user") {
              if (!looksInjected(body)) input = body;
            } else if (event.message?.role === "assistant") {
              output = body;
            }
          }
        }
        stamp(event.timestamp);
      } else if (agent === "codex") {
        if (event.type === "response_item" && event.payload?.type === "message") {
          if (event.payload.role === "user") {
            const body = codexUserText(event.payload);
            if (body !== "") input = body;
          } else if (event.payload.role === "assistant") {
            const body = textOf(event.payload.content);
            if (body !== "") output = body;
          }
        }
        stamp(event.timestamp);
      }
    }
  }

  return {
    input: input === null ? null : oneLine(input, PREVIEW_CHARS),
    output: output === null ? null : oneLine(output, PREVIEW_CHARS),
    at,
  };
}

/** Derived previews, keyed by file and invalidated by mtime + size. */
const previewCache = new Map();

/** Derive one session's preview from the tail of its own store. */
/* ------------------------------------------------------------------ *
 * What a running session is doing: tokens spent, and what it waits on
 * ------------------------------------------------------------------ */

const STORE_READ_CHUNK = 1024 * 1024;
const STORE_READINGS_MAX = 512;

/**
 * Incremental readings taken from a running session's own store.
 *
 * The live view polls every couple of seconds, so re-reading a multi-megabyte
 * transcript each time is the wrong shape. JSONL stores are append-only, so
 * these keep a byte offset and parse only what was appended; the accumulators
 * carry across calls, which also means a partial trailing line simply waits for
 * the rest of itself. A store that shrank was rotated or replaced and resets.
 *
 * DSH is the exception: its store is a run of zstd frames, not plain JSONL, so
 * byte offsets are not line boundaries there. Its files are also the small ones,
 * so it is decoded whole and gated on mtime + size.
 */
const storeReadings = new Map();

function freshReading() {
  return {
    offset: 0,
    stamped: "",
    carry: "",
    tokens: null,
    asked: new Set(),
    decided: new Set(),
    approvalTools: new Map(),
    tools: new Map(),
  };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function blocksOf(content) {
  return Array.isArray(content) ? content : [];
}

/** Add one turn's usage onto the running total. */
function accumulate(reading, parts) {
  const current = reading.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  current.input += num(parts.input);
  current.output += num(parts.output);
  current.cacheRead += num(parts.cacheRead);
  current.cacheWrite += num(parts.cacheWrite);
  current.total = current.input + current.output + current.cacheRead + current.cacheWrite;
  reading.tokens = current;
}

/** Track one tool call by id, so a call that never finished stays visible. */
function trackTool(reading, id, name, present) {
  if (typeof id !== "string" || id === "") return;
  if (present) reading.tools.set(id, typeof name === "string" ? name : null);
  else reading.tools.delete(id);
}

/** Fold one store event into a reading. Each dialect reports different things. */
function readEvent(agent, event, reading) {
  if (agent === "claude") {
    if (event.type === "assistant") {
      const usage = event.message?.usage;
      if (usage !== null && usage !== undefined) {
        accumulate(reading, {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
        });
      }
      for (const block of blocksOf(event.message?.content)) {
        if (block?.type === "tool_use") trackTool(reading, block.id, block.name, true);
      }
    } else if (event.type === "user") {
      for (const block of blocksOf(event.message?.content)) {
        if (block?.type === "tool_result") trackTool(reading, block.tool_use_id, null, false);
      }
    }
    return;
  }

  if (agent === "pi") {
    if (event.type === "message" && event.message?.role === "assistant") {
      const usage = event.message.usage;
      if (usage !== null && usage !== undefined) {
        accumulate(reading, {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        });
      }
    }
    return;
  }

  if (agent === "codex") {
    const payload = event.payload ?? {};
    if (event.type === "event_msg" && payload.type === "token_count") {
      // Codex reports a running total, so this replaces rather than adds.
      const total = payload.info?.total_token_usage ?? {};
      reading.tokens = {
        input: num(total.input_tokens),
        output: num(total.output_tokens) + num(total.reasoning_output_tokens),
        cacheRead: num(total.cached_input_tokens),
        cacheWrite: num(total.cache_write_input_tokens),
        total: num(total.total_tokens),
      };
    } else if (payload.type === "function_call") {
      trackTool(reading, payload.call_id, payload.name, true);
    } else if (payload.type === "function_call_output") {
      trackTool(reading, payload.call_id, null, false);
    }
    return;
  }

  if (agent === "dsh") {
    // Approval asks and decisions both carry an id, so an ask with no matching
    // decision is a request genuinely still waiting — not a guess about what a
    // tool happens to be doing.
    const data = event.data ?? {};
    if (event.type === "approval/asked") {
      if (typeof data.id === "string") {
        reading.asked.add(data.id);
        reading.approvalTools.set(data.id, typeof data.toolName === "string" ? data.toolName : null);
      }
    } else if (event.type === "approval/decided") {
      if (typeof data.id === "string") reading.decided.add(data.id);
    }
  }
}

function summariseReading(reading) {
  const waiting = [...reading.asked].filter((id) => !reading.decided.has(id));
  if (waiting.length > 0) {
    return {
      tokens: reading.tokens,
      pending: { kind: "approval", label: reading.approvalTools.get(waiting[0]) ?? null, count: waiting.length },
    };
  }
  if (reading.tools.size > 0) {
    return {
      tokens: reading.tokens,
      pending: { kind: "tool", label: [...reading.tools.values()][0] ?? null, count: reading.tools.size },
    };
  }
  return { tokens: reading.tokens, pending: null };
}

/** Read whatever this card's store already holds about tokens and waiting work. */
async function readStore(card) {
  if (typeof card.file !== "string" || card.file === "") return null;
  let reading = storeReadings.get(card.file);
  if (reading === undefined) {
    if (storeReadings.size >= STORE_READINGS_MAX) storeReadings.clear();
    reading = freshReading();
    storeReadings.set(card.file, reading);
  }

  let stats;
  try {
    stats = await stat(card.file);
  } catch {
    return null;
  }

  if (card.agent === "dsh") {
    const stamp = `${stats.mtimeMs}:${stats.size}`;
    if (reading.stamped !== stamp) {
      try {
        const text = decodeZstdFrames(await readFile(card.file)).toString("utf8");
        for (const event of parseJsonl(text)) readEvent("dsh", event, reading);
        reading.stamped = stamp;
      } catch (error) {
        // A store caught mid-write can fail to decode, and the next poll
        // retries. Anything else is a bug and must surface rather than be
        // swallowed — this catch once hid a Buffer/String mix-up.
        if (error?.code !== "Z_DATA_ERROR" && !(error instanceof SyntaxError)) throw error;
      }
    }
    return summariseReading(reading);
  }

  if (stats.size < reading.offset) {
    reading = freshReading();
    storeReadings.set(card.file, reading);
  }

  while (reading.offset < stats.size) {
    const length = Math.min(stats.size - reading.offset, STORE_READ_CHUNK);
    let handle = null;
    try {
      handle = await open(card.file, "r");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, reading.offset);
      if (bytesRead <= 0) break;
      reading.offset += bytesRead;

      const text = reading.carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      // Whatever follows the last newline is a half-written line: keep it until
      // the rest of it arrives.
      reading.carry = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        readEvent(card.agent, event, reading);
      }
    } catch {
      break;
    } finally {
      if (handle !== null) await handle.close().catch(() => {});
    }
  }

  return summariseReading(reading);
}

async function derivePreview(card) {
  // A source that owns a non-file store answers the preview from its own query,
  // and is invalidated by the session's own updated-at rather than an mtime.
  const owner = SOURCES.find((entry) => entry.id === card.agent);
  if (typeof owner?.preview === "function") {
    const stamp = `store:${card.updatedAt ?? 0}:${card.messages ?? 0}`;
    const hit = previewCache.get(card.key);
    if (hit !== undefined && hit.stamp === stamp) return hit.value;
    const value = await owner.preview(card);
    const raw = value?.meta?.preview ?? { input: null, output: null };
    const normalised = {
      input: raw.input === null || raw.input === undefined ? null : oneLine(raw.input, PREVIEW_CHARS),
      output: raw.output === null || raw.output === undefined ? null : oneLine(raw.output, PREVIEW_CHARS),
      at: card.updatedAt ?? null,
    };
    previewCache.set(card.key, { stamp, value: normalised });
    return normalised;
  }

  let stats;
  try {
    stats = await stat(card.file);
  } catch {
    return { input: null, output: null, at: null };
  }

  // A preview poll is frequent, and an agent only writes between polls, so an
  // unchanged store must cost nothing. mtime has sub-millisecond resolution
  // here, and every append changes the size too.
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const hit = previewCache.get(card.file);
  if (hit !== undefined && hit.stamp === stamp) return hit.value;

  let value = { input: null, output: null, at: null };
  try {
    const { buffer, fromStart } = await readTail(card.file, PREVIEW_TAIL_BYTES);
    let events;
    if (card.agent === "dsh") {
      events = parseJsonl(decodeZstdFrames(buffer).toString("utf8"));
    } else {
      const text = buffer.toString("utf8");
      events = parseJsonl(fromStart ? text : dropPartialLine(text));
    }
    value = previewFrom(card.agent, events);
  } catch {
    /* A store being rewritten is not an error worth surfacing. */
  }

  previewCache.set(card.file, { stamp, value });
  return value;
}

/* ------------------------------------------------------------------ *
 * Reopen in the original agent
 * ------------------------------------------------------------------ */

/** The command that continues this session inside its own agent. */
function resumeCommandFor(card) {
  const id = card.sessionId;
  if (card.agent === "dsh" || typeof id !== "string" || id === "") return null;
  if (card.agent === "claude") return `claude --resume ${id}`;
  if (card.agent === "codex") return `codex resume ${id}`;
  if (card.agent === "gemini") return `gemini --resume ${id}`;
  if (card.agent === "pi") return `pi --session ${id}`;
  if (card.agent === "opencode") return `opencode --session ${id}`;
  return null;
}

/**
 * Wake a session in a terminal.
 *
 * cmux is preferred: `new-workspace --cwd … --command …` reopens the session in
 * the terminal the user already drives these agents from, and launches cmux
 * itself when it is not running. Terminal.app is the fallback. The command is
 * returned either way, so the UI can always show or copy exactly what ran.
 */
/**
 * Run a command in a terminal at `cwd`.
 *
 * cmux first — it is the terminal these agents are usually driven from, and it
 * launches itself if it is not running. Terminal.app is the fallback, and a
 * `.command` script copied to the clipboard path is the last resort. The caller
 * gets the command back either way, so the UI can always show what ran.
 *
 * @returns {{ kind: 'cmux'|'terminal'|'manual', command: string, terminal: string|null, reason?: string }}
 */
async function launchInTerminal(cwd, command, title) {
  const cli = resolveCmuxCli();
  if (cli !== null) {
    try {
      await execFileAsync(
        cli,
        ["new-workspace", "--cwd", cwd, "--command", command, "--name", oneLine(title, 40), "--focus", "true"],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      return { kind: "cmux", command, terminal: "cmux" };
    } catch {
      /* cmux failed — fall through to Terminal.app. */
    }
  }

  const script = join(tmpdir(), `dsh-session-hub-${Date.now()}.command`);
  await writeFile(
    script,
    ["#!/bin/zsh", `cd ${JSON.stringify(cwd)}`, `echo ${JSON.stringify(title)}`, command, ""].join("\n"),
    { mode: 0o755 },
  );

  try {
    spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }).unref();
    return { kind: "terminal", command, terminal: "Terminal" };
  } catch (error) {
    return { kind: "manual", command, terminal: null, reason: String(error?.message ?? error) };
  }
}

/** The command that starts a fresh interactive session for each agent. */
const SPAWN_COMMANDS = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  pi: "pi",
  opencode: "opencode",
};

async function openOriginal(value) {
  const { card } = value;
  if (card.agent === "dsh") {
    return { kind: "dsh", sessionId: card.sessionId, command: null, terminal: null };
  }

  const command = card.resumeCommand ?? resumeCommandFor(card);
  if (command === null) {
    return { kind: "manual", sessionId: card.sessionId, command: null, reason: "no resume command known" };
  }

  const cwd = typeof card.cwd === "string" && card.cwd !== "" ? card.cwd : home();
  const launched = await launchInTerminal(cwd, command, `${card.agentLabel} · ${card.title}`);
  return { ...launched, sessionId: card.sessionId };
}

/**
 * Start a brand-new session in a project, with the agent the caller picked.
 *
 * DSH sessions are started through the client (they belong to the workspace
 * registry, not to a shell), so this handles the command-line agents only.
 */
async function spawnSession(agent, cwd) {
  const command = SPAWN_COMMANDS[agent];
  if (command === undefined) {
    return { ok: false, error: `no way to start a ${agent} session from here` };
  }
  const launched = await launchInTerminal(cwd, command, `${AGENT_LABELS[agent]} · ${basename(cwd)}`);
  return { ok: true, agent, cwd, command, ...launched };
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * The route's dispatch target lives in one process-global slot, not in module
 * scope.
 *
 * `ctx.connection.fetch.register` is owned by the connection service's own
 * context, so the route outlives this plugin's fiber and keeps the closure it
 * was created with. A reload re-evaluates this module and would otherwise build
 * a *fresh* module-scope object that the already-registered route never reads —
 * leaving the first generation serving every later request, which is exactly
 * how `unknown op` appears after the client has already moved on.
 *
 * `Symbol.for` resolves through the global symbol registry, so two module
 * instances agree on the key.
 */
const HUB_STATE = Symbol.for("dsh-session-hub/route-state");

function hubState() {
  const existing = globalThis[HUB_STATE];
  if (existing !== undefined) return existing;
  const created = { handler: null };
  globalThis[HUB_STATE] = created;
  return created;
}

/**
 * Serve one Session Hub operation.
 *
 * @param payload - The request body; `op` selects the operation.
 * @param ctx - The Host plugin context of the generation that is live.
 */
/** Every operation this Host answers; also reported when an unknown one arrives. */
const OPS = ["list", "status", "preview", "pin", "transcript", "continue", "open", "spawn", "delete", "delete-many"];

async function dispatch(payload, ctx) {
  const op = typeof payload?.op === "string" ? payload.op : "list";

  if (op === "list") {
    const { cards, sources, runningCount, cmux, pins } = await inventory(payload?.refresh === true, ctx);
    return {
      ok: true,
      generatedAt: Date.now(),
      cmux,
      cmuxPath: resolveCmuxCli(),
      agents: SOURCES.map((source) => ({ id: source.id, label: AGENT_LABELS[source.id] })),
      sources,
      runningCount,
      pins,
      sessions: cards,
    };
  }

  /**
   * Pin or unpin one project (by workspace path) or one session (by key).
   *
   * A session pin is scoped to its own project in the UI — the panel sorts it to
   * the top of its group, not to the top of the whole list.
   */
  if (op === "pin") {
    const kind = payload?.kind;
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (id === "" || (kind !== "project" && kind !== "session")) {
      return { ok: false, error: "pin needs kind ('project' | 'session') and a non-empty id" };
    }

    const pins = await readPins();
    const target = new Set(kind === "project" ? pins.projects : pins.sessions);
    if (payload?.pinned === true) target.add(id);
    else target.delete(id);

    const next = {
      version: 1,
      projects: kind === "project" ? [...target] : pins.projects,
      sessions: kind === "session" ? [...target] : pins.sessions,
    };
    await writePins(next);
    return { ok: true, projects: next.projects, sessions: next.sessions };
  }

  /**
   * The polling operation: no rescan, no re-parse — only live state, over the
   * already-parsed cards. Cheap enough to run every few seconds.
   */
  if (op === "status") {
    if (lastCards.length === 0) await inventory(false, ctx);
    await refreshLive(ctx, lastCards);
    const running = {};
    let runningCount = 0;
    for (const card of lastCards) {
      running[card.key] = card.running;
      if (card.running) runningCount += 1;
    }
    return { ok: true, generatedAt: Date.now(), runningCount, running };
  }

  /**
   * Delete one session from its agent's own store. Destructive and outside the
   * workspace, so it re-checks liveness first and refuses a running session
   * unless the caller forces it.
   */
  if (op === "delete") {
    const key = typeof payload?.key === "string" ? payload.key : "";
    if (key === "") return { ok: false, error: "delete needs a key" };

    let card = lastCards.find((entry) => entry.key === key);
    if (card === undefined) {
      const value = await fullValueByKey(key);
      if (value === null || value === undefined) return { ok: false, error: "unknown session key" };
      card = value.card;
    }

    await refreshLive(ctx, [card]);

    try {
      const result = await deleteSession(card, payload?.force === true);
      // A deleted session must not keep a pin pointing at nothing.
      await prunePins([card.key]);
      return { ok: true, card, ...result };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? null };
    }
  }

  /**
   * Delete many sessions at once — one project group, across every agent.
   *
   * The caller sends the exact keys it is showing, so the batch is what the
   * person saw rather than a re-derived set that filtering could have changed.
   * Each key still goes through `deleteSession`'s own guards. A running session
   * is skipped, not fatal: a project-wide delete should remove what it can and
   * report the rest, and the caller opts into running ones explicitly.
   */
  if (op === "delete-many") {
    const keys = Array.isArray(payload?.keys)
      ? payload.keys.filter((key) => typeof key === "string" && key !== "").slice(0, MAX_BATCH_DELETE)
      : [];
    if (keys.length === 0) return { ok: false, error: "delete-many needs a non-empty keys array" };

    const force = payload?.force === true;
    await refreshLive(ctx, lastCards);
    const failures = [];
    const removed = [];
    let deleted = 0;
    let skipped = 0;

    for (const key of keys) {
      const card = lastCards.find((entry) => entry.key === key);
      if (card === undefined) {
        skipped += 1;
        failures.push({ key, error: "unknown session key" });
        continue;
      }
      if (card.running === true && !force) {
        skipped += 1;
        failures.push({ key, error: "session is running", code: "running" });
        continue;
      }
      try {
        await deleteSession(card, true);
        deleted += 1;
        removed.push(key);
      } catch (error) {
        skipped += 1;
        failures.push({ key, error: String(error?.message ?? error) });
      }
    }

    // One write for the whole batch, not one per session.
    await prunePins(removed);
    return { ok: true, requested: keys.length, deleted, skipped, failures };
  }

  /**
   * The live preview: one line per running agent, with the input it was given
   * and the output it has produced so far.
   *
   * Two sources, in priority order. An agent that registered through the hook
   * spool wins, because it is stating what it is doing rather than having it
   * inferred. Otherwise the preview is derived from the tail of the agent's own
   * store, which needs no cooperation at all.
   */
  if (op === "preview") {
    if (lastCards.length === 0) await inventory(false, ctx);
    const hooks = await readHooks();
    await refreshLive(ctx, lastCards);

    const running = lastCards.filter((card) => card.running === true);

    const previews = await mapLimit(running.slice(0, MAX_PREVIEWS), 4, async (card) => {
      const hook = hooks.get(`${card.agent}:${card.sessionId}`);
      const derived = await derivePreview(card);
      // Read in parallel: both walk the same store tail but answer different
      // questions, and the reading is cached on a byte offset between polls.
      const reading = await readStore(card);
      return {
        key: card.key,
        agent: card.agent,
        agentLabel: card.agentLabel,
        title: card.title,
        project: card.project,
        cwd: card.cwd,
        // The live view drags exactly like the list, so it carries the same fields.
        file: card.file,
        sessionId: card.sessionId,
        resumeCommand: card.resumeCommand ?? null,
        input: typeof hook?.input === "string" ? oneLine(hook.input, PREVIEW_CHARS) : derived.input,
        output: typeof hook?.output === "string" ? oneLine(hook.output, PREVIEW_CHARS) : derived.output,
        phase: typeof hook?.phase === "string" ? hook.phase : derived.output === null ? "working" : "output",
        at: toMs(hook?.at) ?? derived.at,
        source: hook === undefined ? "store" : "hook",
        surfaceId: card.live?.surfaceId ?? null,
        // Live detail: how long it has been up, what it has spent, what it waits on.
        pid: card.live?.pid ?? null,
        startedAt: card.process?.startedAt ?? null,
        elapsedMs: card.process?.startedAt == null ? null : Date.now() - card.process.startedAt,
        tokens: reading?.tokens ?? null,
        pending: reading?.pending ?? null,
      };
    });

    return {
      ok: true,
      generatedAt: Date.now(),
      runningCount: running.length,
      shown: previews.filter(Boolean).length,
      sessions: previews.filter(Boolean),
      hookPath: hooksPath(),
    };
  }

  /**
   * Start a new session in a project with a chosen agent.
   *
   * The DSH case is answered by the client, which owns the workspace registry;
   * this launches the command-line agents in a terminal at that directory.
   */
  if (op === "spawn") {
    const agent = typeof payload?.agent === "string" ? payload.agent : "";
    const cwd = typeof payload?.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : null;
    if (cwd === null) return { ok: false, error: "spawn needs an absolute cwd" };
    if (AGENT_LABELS[agent] === undefined) return { ok: false, error: `unknown agent: ${agent}` };
    if (agent === "dsh") return { ok: false, error: "a DSH session is started by the client" };
    return await spawnSession(agent, cwd);
  }

  if (op === "transcript" || op === "continue" || op === "open") {
    const value = typeof payload?.key === "string" ? await fullValueByKey(payload.key) : null;
    if (value === null || value === undefined) return { ok: false, error: "unknown session key" };

    // `open` makes a decision from live state, so refresh it before answering.
    if (op === "open") await refreshLive(ctx, [value.card]);

    if (op === "transcript") return { ok: true, markdown: transcriptMarkdown(value), card: value.card };
    if (op === "continue") {
      return {
        ok: true,
        card: value.card,
        ...(await materialize(value, payload?.destDir, payload?.currentSessionId)),
      };
    }
    return { ok: true, ...(await openOriginal(value)) };
  }

  // A stale Host is the failure this reports most often, so the message names
  // what this generation actually answers instead of just rejecting the op.
  return { ok: false, error: `unknown op: ${op}`, supported: OPS };
}

/**
 * Register the Session Hub route.
 *
 * The shared Fetch route registry belongs to the connection service, not to
 * this plugin's fiber, so a reload cannot re-register the same exact path. That
 * one case is expected and harmless — `hub.handler` above already points the
 * live route at this generation. Every other failure is real, and is rethrown
 * so the plugin's fiber reports `failed` instead of going quietly dead.
 *
 * @param ctx - Host plugin context.
 */
/**
 * Register the Session Hub route and point it at this generation.
 *
 * The registration is wrapped in an effect of *this* plugin's context, so a
 * reload disposes the old route before the new generation registers its own.
 * `ctx.connection.fetch.register` alone would not do that: its effect belongs
 * to the connection service, so the route would outlive the plugin and keep the
 * closure it was created with — leaving the first generation serving requests
 * the newest one should answer.
 *
 * The global handler slot stays as a second line of defence: a route left behind
 * by a generation that predates this (or by a connection reload) still reads the
 * newest handler rather than a dead one.
 *
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  hubState().handler = (payload) => dispatch(payload, ctx);

  ctx.effect(() => {
    let dispose = null;
    try {
      dispose = ctx.connection.fetch.register({
        path: ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let payload = {};
          try {
            payload = await request.json();
          } catch {
            payload = {};
          }
          // Read the handler at call time: this route may be older than the
          // module behind it.
          const handler = hubState().handler;
          if (handler === null) return json({ ok: false, error: "session-hub is not active" }, 503);
          try {
            return json(await handler(payload));
          } catch (error) {
            return json({ ok: false, error: String(error?.message ?? error) }, 500);
          }
        },
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes("already registered")) throw error;
      // Left behind by an older generation; the global slot covers it.
    }

    return () => {
      try {
        if (typeof dispose === "function") dispose();
      } catch {
        /* Already gone. */
      }
    };
  }, "session-hub: /api route");
}
