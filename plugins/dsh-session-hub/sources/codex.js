/**
 * dsh-session-hub — Codex adapter.
 *
 * Rollout JSONL under ~/.codex/sessions; model-generated thread names live in session_index.jsonl instead.
 *
 * @module dsh-session-hub/sources/codex
 */

import { basename, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import {
  UNTITLED,
  attribute,
  home,
  looksInjected,
  num,
  oneLine,
  projectOf,
  textOf,
  toMs,
  trackTool,
  handoffName,
  compactionHeading,
  turnHeading,
} from "../shared.js";

/** The one place this adapter spells its own name. */
const LABEL = "Codex";

/**
 * Codex writes its model-generated thread names to its own index rather than
 * into the rollout file:
 *
 *   ~/.codex/session_index.jsonl
 *   {"id":"<session id>","thread_name":"编写 SkillStudio 使用说明","updated_at":"…"}
 *
 * This is the closest thing Codex has to an AI title, and it beats anything
 * derived from the first message. It is read once per scan — through the active
 * store, via `hydrateCodex` below, so a remote environment gets the remote
 * index rather than this machine's.
 */
const codexIndex = { at: 0, stamp: null, value: null };

/** The index is a sibling of the stores, so it follows the environment too. */
function codexIndexPath() {
  return join(home(), ".codex", "session_index.jsonl");
}

/**
 * Read the thread-name index through the **active store**.
 *
 * `build` is synchronous, so this cannot happen inside it — and reading it with
 * `node:fs` would read this machine while the panel is pointed at another one,
 * leaving every remote Codex session entitled `(untitled)`. It is called once
 * per source per scan, invalidated by mtime + size, and does nothing when the
 * index has not changed.
 *
 * @param {{store: object}} input
 */
async function hydrateCodex({ store }) {
  const path = codexIndexPath();
  let stats = null;
  try {
    stats = await store.stat(path);
  } catch {
    /* Codex may not be installed, or may keep no index. */
  }

  const stamp = stats === null ? null : `${stats.mtimeMs}:${stats.size}`;
  if (codexIndex.value !== null && codexIndex.stamp === stamp && Date.now() - codexIndex.at < 5000) return;

  const names = new Map();
  if (stamp !== null) {
    let text = "";
    try {
      text = (await store.readFile(path)).toString("utf8");
    } catch {
      text = "";
    }
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
  }

  codexIndex.value = names;
  codexIndex.stamp = stamp;
  codexIndex.at = Date.now();
}

/**
 * The index as `hydrateCodex` last saw it.
 *
 * Synchronous by necessity: `buildCodex` runs inside a synchronous contract and
 * only wants a map lookup. An empty map means "no index", which is what Codex
 * with no index looks like anyway.
 */
function codexThreadNames() {
  return codexIndex.value ?? new Map();
}

function codexUserText(payload) {
  const body = textOf(payload?.content);
  return looksInjected(body) ? "" : body;
}

function buildCodex(file, stats, events, truncated) {
  const meta = events.find((event) => event.type === "session_meta")?.payload ?? {};

  // `id` is this thread's own identity; `session_id` is the **root** session, and
  // for a subagent thread it equals the parent. Keying on `session_id` therefore
  // folds every subagent onto its root: measured here, that put 63 threads in one
  // group and gave them all the root's name, while the thread's own id groups
  // them correctly (at most 4 segments per id, which is the resume/compaction
  // case). It is also the id `codex resume` takes.
  const threadId = meta.id ?? meta.session_id ?? basename(file, ".jsonl");
  const parentId = typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null;
  const isSubagent = meta.thread_source === "subagent" || meta.source?.subagent !== undefined;
  const sessionId = threadId;
  const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
  const created = toMs(meta.timestamp) ?? Math.round(stats.birthtimeMs ?? 0) ?? null;

  const lines = [];
  let title = "";
  let assistantTitle = "";
  let messages = 0;

  for (const event of events) {
    // Compaction is its own event, outside the response items, and it carries
    // the summary the context was replaced with.
    if (event.type === "compacted") {
      const summary = typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
      if (summary !== "") lines.push(compactionHeading(event.timestamp, null), "", summary, "");
      continue;
    }
    if (event.type !== "response_item") continue;
    const payload = event.payload ?? {};
    if (payload.type !== "message") continue;

    if (payload.role === "user") {
      const body = codexUserText(payload);
      if (body === "") continue;
      messages += 1;
      if (title === "") title = oneLine(body, 140);
      lines.push(turnHeading("User", event.timestamp), "", body, "");
    } else if (payload.role === "assistant") {
      const body = textOf(payload.content);
      if (body === "") continue;
      if (assistantTitle === "") assistantTitle = body;
      messages += 1;
      lines.push(turnHeading("Assistant", event.timestamp), "", body, "");
    }
  }

  return {
    card: {
      key: `codex:${file}`,
      agent: "codex",
      agentLabel: LABEL,
      sessionId,
      title: codexThreadNames().get(sessionId) ?? (title || oneLine(assistantTitle, 140) || UNTITLED),
      cwd,
      project: projectOf(cwd),
      createdAt: created,
      updatedAt: Math.round(stats.mtimeMs ?? created ?? 0) || null,
      bytes: stats.size ?? 0,
      messages,
      partial: truncated,
      subagent: isSubagent,
      parentSessionId: parentId !== null && parentId !== threadId ? parentId : null,
      depth: 0,
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

/**
 * Codex keeps its model-generated thread names in its own index, so removing a
 * rollout without removing its entry leaves the name behind for a session that
 * no longer exists. Rewritten through a temp file so an interrupted write
 * cannot truncate the index — which is why the store has a `move`.
 *
 * Through the store rather than `node:fs`, so deleting a session on another
 * machine tidies *that* machine's index. Reading the local one there would find
 * nothing and quietly report "no entry removed".
 */
async function removeCodexIndexEntry(sessionId, store) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const path = codexIndexPath();
  let text;
  try {
    text = (await store.readFile(path)).toString("utf8");
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
  await store.writeText(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  await store.move(temporary, path);
  // The cache is now a fact about a file that no longer exists.
  codexIndex.value = null;
  codexIndex.stamp = null;
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

export default defineAdapter({
  id: "codex",
  /**
   * How to start this agent's ACP server.
   *
   * From the published registry, which is the authority on the recipe and the
   * version: `npx <package>` is how most adapters ship. Declared here so
   * "can this row be chatted with in the panel" is answered by a declaration
   * rather than a list in the Host that drifts.
   */
  acp: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@2.1.1"] },
  /**
   * The Codex desktop app registers `codex://` and builds thread links from a
   * `codex://threads/` prefix.
   *
   * Only `codex://threads/new` is provably constructed by this CLI and its
   * app-server protocol carries `thread/resume`, but the id form itself is
   * inferred rather than confirmed. That is exactly why it is the first *step*
   * instead of the only one: a URL nothing handles falls through to the
   * terminal, which is what a machine without the app gets.
   *
   * `codex app` is deliberately absent — it fetches an installer when the app is
   * missing, and opening a session must not start a download.
   */
  openPlan: (card) => [
    ...(typeof card.sessionId === "string" && card.sessionId !== ""
      ? [{ kind: "app", url: `codex://threads/${card.sessionId}`, label: "Codex" }]
      : []),
    { kind: "terminal" },
  ],
  sessionFile: (card) => ({ path: card.file, kind: "file", label: handoffName(card) }),
  label: LABEL,
  executables: ["codex"],
  spawnCommand: "codex",
  resumeCommand: (id) => `codex resume ${id}`,
  root: () => join(home(), ".codex", "sessions"),
  configFiles: () => [
    { path: join(home(), ".codex", "config.toml"), label: "config.toml", language: "toml", creatable: true },
    { path: join(home(), ".codex", "AGENTS.md"), label: "AGENTS.md", language: "markdown", creatable: true },
  ],
  storeKind: "jsonl",
  match: (name) => name.endsWith(".jsonl"),
  concurrency: 16,
  prefix: { start: 131072, max: 2097152, complete: (events) => hasCodexSignal(events) },
  // The thread-name index has to be fetched through the active store before the
  // synchronous `build` can consult it.
  hydrate: hydrateCodex,
  build: buildCodex,
  readStoreEvent(event, reading) {
    const payload = event.payload ?? {};

    // The model name rides on context events, not on `session_meta` — that one
    // only says `model_provider: "custom"` — so it has to be tracked as the
    // store is walked, and the last one seen is the model in effect.
    if (typeof payload.model === "string" && payload.model !== "") reading.model = payload.model;

    if (event.type === "event_msg" && payload.type === "token_count") {
      // Codex reports a running total, so the session figure replaces rather
      // than adds. The per-model split cannot do that: attributing a cumulative
      // total to the current model would bill every earlier model's tokens to
      // the last one, so the split takes the difference between two readings.
      const total = payload.info?.total_token_usage ?? {};
      const seen = {
        input: num(total.input_tokens),
        output: num(total.output_tokens) + num(total.reasoning_output_tokens),
        cacheRead: num(total.cached_input_tokens),
        cacheWrite: num(total.cache_write_input_tokens),
        total: num(total.total_tokens),
      };
      const previous = reading.codexSeen ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      attribute(reading, {
        input: Math.max(0, seen.input - previous.input),
        output: Math.max(0, seen.output - previous.output),
        cacheRead: Math.max(0, seen.cacheRead - previous.cacheRead),
        cacheWrite: Math.max(0, seen.cacheWrite - previous.cacheWrite),
        // Carried through, because it is not the sum of the four above.
        total: Math.max(0, seen.total - previous.total),
      });
      reading.codexSeen = seen;
      reading.tokens = { ...seen };
    } else if (payload.type === "function_call") {
      trackTool(reading, payload.call_id, payload.name, true);
    } else if (payload.type === "function_call_output") {
      trackTool(reading, payload.call_id, null, false);
    }
    return;
  },
  readPreview(events, state) {
    let input = state.input;
    let output = state.output;
    const stamp = (value) => {
      const ms = toMs(value);
      if (ms !== null) state.at = Math.max(state.at ?? 0, ms);
    };
    for (const event of events) {
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
    state.input = input;
    state.output = output;
  },
  deletePlan: (card) => ({
    target: card.file,
    recursive: false,
    after: (store) => removeCodexIndexEntry(card.sessionId, store),
  }),
});
