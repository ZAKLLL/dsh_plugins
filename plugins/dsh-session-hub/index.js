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
import { environmentOps } from "./ops/environment.js";
import { opRegistry } from "./ops/op.js";
import dshSource from "./sources/dsh.js";
import claudeSource from "./sources/claude.js";
import codexSource from "./sources/codex.js";
import geminiSource from "./sources/gemini.js";
import piSource from "./sources/pi.js";
import opencodeSource from "./sources/opencode.js";
import {
  dshHome,
  decodeZstdFrames,
  localHome,
  sessionHubHome,
  oneLine,
  parseJsonl,
  setEnvironmentScope,
  toMs,
} from "./shared.js";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createRemoteHost, localHost, parseProcesses } from "./host.js";
import { localStore } from "./store.js";

import {
  LOCAL_ENVIRONMENT,
  environmentStatePath,
  findEnvironment,
  isHostAlias,
  mergeEnvironments,
  normalizeEnvironments,
  probeEnvironment,
  readActiveId,
  readEnvironmentState,
  readSshHosts,
  resolveHomes,
  writeActiveId,
  writeEnvironmentState,
} from "./environments.js";

const execFileAsync = promisify(execFile);

/**
 * The byte source every session-store read goes through.
 *
 * Swapped by the environment switcher. It is module state rather than a
 * parameter on every call because the adapters are what read stores, and an
 * adapter must stay a pure description of one dialect — handing it a store
 * argument would push environment plumbing into all six of them.
 */
let active = localHost.store;

/**
 * The machine the panel is pointed at, as something that can be *used*.
 *
 * `store` above is the byte half of this; a host adds the two things bytes do
 * not cover — running a command over there, and phrasing a command for a
 * terminal here. Both are swapped together, by `activateEnvironment`, so the two
 * can never disagree about which machine they are describing.
 */
let activeHost = localHost;

/** The host the active environment is. */
function host() {
  return activeHost;
}

/** The store the active environment reads through. */
function store() {
  return activeHost.store;
}

/** Point every later store read at another machine (or back at this one). */
export function setStore(next) {
  // Kept for the tests, which exercise the store seam on its own. A bare store
  // is wrapped in the local host so nothing downstream sees a half-swapped pair.
  activeHost = next === undefined || next === null ? localHost : { ...localHost, store: next };
  clearEnvironmentCaches();
}

/** Adopt a machine wholesale: its bytes and its commands together. */
export function setHost(next) {
  activeHost = next ?? localHost;
  clearEnvironmentCaches();
}

/**
 * Forget everything derived from the previous environment's bytes.
 *
 * Nothing here is keyed by environment, and it does not need to be: the caches
 * are keyed by absolute store path, and two machines do not share one. Clearing
 * is about the *listing*, which is a single global — without this, switching
 * environments would show the previous machine's sessions until the next
 * refresh, which is exactly the "present local data as remote" failure the
 * switcher must not make.
 */
function clearEnvironmentCaches() {
  // The process table is per machine, so it goes with the rest: a stale one
  // would answer for the machine that was left.
  scanStats.clear();
  processCache.hostId = null;
  processCache.value = [];
  processCache.at = 0;
  cache.clear();
  modelTailCache.clear();
  previewCache.clear();
  storeReadings.clear();
  lastCards = [];
}

/** The Cordis service this plugin requires to publish a browser route. */
export const inject = ["connection"];

/** The one exact Fetch route the client talks to; every call is a POST with an `op`. */
const ROUTE = "/api/session-hub";

const MAX_BATCH_DELETE = 2000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

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
function walk(root, match, options) {
  return store().walk(root, match, options);
}

/**
 * Read at most `bytes` from the head of a file, looping over short reads.
 *
 * @returns {{ text: string, filled: boolean }} `filled` is false when the file
 * ended before the cap, which is how callers detect they saw the whole file.
 */
function readHead(path, bytes) {
  return store().readHead(path, bytes);
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


const PROCESS_TTL_MS = 2000;
/**
 * The last process table, and which machine it came from.
 *
 * Keyed by host: two machines have two process tables, and a cache that did not
 * say which one it held would show the previous machine's agents as this one's
 * running sessions — the same misattribution the switch itself must not make.
 */
const processCache = { hostId: null, at: 0, value: [] };

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

/**
 * The working directory of a live process, which is how a fresh run is matched.
 *
 * Asked of the machine the process is on — `/proc` on Linux, `lsof` elsewhere —
 * because a remote agent's directory is not knowable from here.
 */
async function cwdOf(pid) {
  try {
    return await host().cwdOf(pid);
  } catch {
    /* Denied, gone, or a machine that stopped answering between the calls. */
    return null;
  }
}

/**
 * The `code` CLI that hands a directory to VS Code.
 *
 * PATH first — that is where a person puts it — then the standard locations,
 * because a Host started from Finder does not inherit a login shell's PATH.
 */
let editorCliPath;
function resolveEditorCli() {
  if (editorCliPath !== undefined) return editorCliPath;
  const candidates = [];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "") candidates.push(join(dir, "code"));
  }
  candidates.push("/usr/local/bin/code", "/opt/homebrew/bin/code");
  candidates.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
  editorCliPath =
    candidates.find((candidate) => {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null;
  return editorCliPath;
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

/**
 * Every live agent process on the active machine, refreshed on a short interval.
 *
 * The process table is asked of whatever machine the panel is pointed at, so a
 * remote agent is as visible as a local one — which is what makes the green dot,
 * the "focus the window it is already in" path, and the delete guard's "this
 * session is still running" all mean something over there.
 */
async function scanAgentProcesses() {
  const now = Date.now();
  const machine = host();
  if (processCache.hostId === machine.id && now - processCache.at < PROCESS_TTL_MS) return processCache.value;

  const found = [];
  try {
    for (const row of await machine.processes()) {
      const elapsed = parseEtime(row.etime);

      // The executable, and the script it may hand off to: macOS reports a
      // shebang script as `/bin/sh /path/to/agent`, and a wrapper as
      // `node /path/to/claude-wrapper`, so the executable alone is `sh` or
      // `node` and matches nothing. Only the *first* argument is considered, so
      // a later argument that merely mentions an agent name is not a match.
      const argv = row.args.split(/\s+/).filter(Boolean);
      const names = [row.executable, argv[0] === undefined ? null : basename(argv[0])];
      const agent = SOURCES.find((source) =>
        source.executables.some((name) => names.some((candidate) => candidate !== null && namesAgent(candidate, name))),
      )?.id;
      if (agent === undefined) continue;

      found.push({
        agent,
        pid: row.pid,
        args: row.args,
        sessionId: sessionIdFromArgs(row.args),
        cwd: null,
        // How long the process has been up, straight from the process table.
        startedAt: elapsed === null ? null : now - elapsed * 1000,
      });
    }
  } catch {
    /* No process table — the other two sources still work. */
  }

  // Only a process that could not name its session needs a directory lookup.
  await mapLimit(found, 4, async (entry) => {
    if (entry.sessionId === null) entry.cwd = await cwdOf(entry.pid);
    return entry;
  });

  processCache.hostId = machine.id;
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
  // An agent that runs inside this process reports its own status; one that runs
  // as a separate program has to be found in the process table.
  if (adapterOf(card.agent)?.liveness === "registry") {
    // `ctx.get` is the optional-service lookup the runtime itself uses, so an
    // absent registry degrades to "unknown" instead of throwing.
    const registry = ctx?.get?.("agents");
    const agent = registry?.get?.(card.sessionId);
    const status = typeof agent?.status === "string" ? agent.status : null;
    return { running: status === "running", source: status === null ? null : card.agent, lifecycle: status };
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

/* ------------------------------------------------------------------ *
 * The agent registry
 * ------------------------------------------------------------------ */

/**
 * Every agent this plugin knows, in the order the panel lists them.
 *
 * The machinery below never branches on an agent id: everything specific to a
 * single agent lives behind these adapters (see `./sources/adapter.js`). Adding
 * an agent means adding a module, not editing a branch here.
 */
const SOURCES = [dshSource, claudeSource, codexSource, geminiSource, piSource, opencodeSource];

/** One adapter by id, or null when the id is unknown. */
function adapterOf(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}
async function parseValue(source, file, stats, { full }) {
  // A dialect that needs a second file to interpret the first fetches it here,
  // through the same store, because `build` is synchronous.
  if (typeof source.hydrate === "function") await source.hydrate({ store: store(), files: [file] });
  // A frames store is not byte-addressable, so the whole file is read — but read
  // *here*, through the active store, and handed over. The one adapter with such
  // a store used to read it itself, which read this machine while the panel was
  // pointed at another one.
  if (source.storeKind === "frames") {
    return source.build(file, stats, await store().readFile(file));
  }
  if (source.prefix === undefined) {
    return source.build(file, stats);
  }
  if (full) {
    return source.build(file, stats, parseJsonl((await store().readFile(file)).toString("utf8")), false);
  }
  const { events, truncated } = await readPrefix(file, source.prefix);
  return source.build(file, stats, events, truncated);
}

/** File → parsed value, invalidated by mtime + size. */
const cache = new Map();

/**
 * Stats this scan already fetched, so a later read does not ssh again.
 *
 * The batched `statMany` is one round trip for a whole source; asking per card
 * afterwards throws that away. Measured against a real machine: the per-card
 * re-stat was most of a 3.9-second warm list, because a round trip was paid once
 * per card for a number the scan already had.
 *
 * Cleared at the start of every inventory, so this is strictly "what this pass
 * knows" — never a stale answer handed to a later request.
 */
const scanStats = new Map();

/** The listing path: cached, prefix-based, cheap. */
async function cachedCard(source, file, force) {
  let stats;
  try {
    stats = await store().stat(file);
  } catch {
    return null;
  }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const hit = cache.get(file);
  if (!force && hit !== undefined && hit.stamp === stamp) return hit.value;

  scanStats.set(file, stats);
  const value = await parseValue(source, file, stats, { full: false });
  cache.set(file, { stamp, value });
  return value;
}

/**
 * The listing path for a whole source's files.
 *
 * Off a local disk this is the same parallel per-file parse it has always been.
 * Across an ssh connection it is a handful of *batched* round trips instead: one
 * `stat` call for the set, then one prefix read for every file that still needs
 * one, repeated only for the files whose first prefix was not enough. A
 * per-file scan of a few thousand rollouts is a few thousand round trips, which
 * is minutes; this is seconds.
 *
 * The two paths must agree exactly — they differ only in how many `read` calls
 * it takes to learn the same bytes — so a store that cannot batch falls through
 * to `cachedCard` unchanged.
 */
async function cachedCards(source, files, force) {
  const canBatch =
    source.prefix !== undefined &&
    typeof store().statMany === "function" &&
    typeof store().readHeads === "function";
  if (!canBatch) {
    return await mapLimit(files, source.concurrency, (file) => cachedCard(source, file, force));
  }

  // One hydration for the whole source, not one per file: Codex's index is
  // shared by every rollout, and Gemini's project roots are fetched in a batch.
  if (typeof source.hydrate === "function") await source.hydrate({ store: store(), files });

  const values = new Map();
  const stats = await store().statMany(files);
  for (const [file, stat] of stats) {
    if (stat !== null && stat !== undefined) scanStats.set(file, stat);
  }
  const pending = [];
  for (const file of files) {
    const stat = stats.get(file);
    if (stat === undefined || stat === null) {
      values.set(file, null);
      continue;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(file);
    if (!force && hit !== undefined && hit.stamp === stamp) {
      values.set(file, hit.value);
      continue;
    }
    pending.push({ file, stat, stamp });
  }

  const { start, max, complete } = source.prefix;
  let size = start;
  let waiting = pending;
  while (waiting.length > 0) {
    const heads = await store().readHeads(waiting.map(({ file }) => ({ path: file, bytes: size })));
    const again = [];
    for (const entry of waiting) {
      const head = heads.get(entry.file);
      if (head === undefined) {
        values.set(entry.file, null);
        continue;
      }
      const truncated = head.filled;
      const text = truncated ? dropPartialLine(head.text) : head.text;
      const events = parseJsonl(text);
      // The same stopping rule `readPrefix` uses, so a file stops growing at
      // exactly the point it would have stopped at on a local disk.
      if (!truncated || size >= max || complete(events)) {
        const value = source.build(entry.file, entry.stat, events, truncated);
        cache.set(entry.file, { stamp: entry.stamp, value });
        values.set(entry.file, value);
      } else {
        again.push(entry);
      }
    }
    if (again.length === 0) break;
    size = Math.min(size * 4, max);
    waiting = again;
  }

  return files.map((file) => values.get(file) ?? null);
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

/**
 * The last part of a session's store, as text.
 *
 * The cut lands on a real boundary, not a byte count: JSONL is trimmed back to
 * the first whole line, and a DSH store is concatenated zstd frames whose
 * decoder finds them by magic, so a cut inside one simply yields nothing from it.
 */
async function readStoreTail(card, bytes) {
  // The same tail reader the live preview uses — one place that knows how to
  // take the end off a file.
  const { buffer, fromStart } = await readTail(card.file, bytes);
  if (adapterOf(card.agent)?.storeKind === "frames") {
    return decodeZstdFrames(buffer).toString("utf8");
  }
  const text = buffer.toString("utf8");
  if (fromStart) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak < 0 ? "" : text.slice(firstBreak + 1);
}

/**
 * The first part of a store, for a marker that only ever appears early.
 *
 * A dialect can name its model once, near the start: pi records a
 * `model_change`, and a Codex session that ends with a large tool output pushes
 * its `turn_context` far from the end. The tail is still tried first, because
 * only the tail says which model is *current*.
 */
async function readStoreHead(card, bytes) {
  const slice = await store().readAt(card.file, 0, bytes);
  if (adapterOf(card.agent)?.storeKind === "frames") return decodeZstdFrames(slice).toString("utf8");
  const text = slice.toString("utf8");
  const lastBreak = text.lastIndexOf("\n");
  return lastBreak < 0 ? text : text.slice(0, lastBreak);
}

/** file -> { stamp, model }, so a scan only pays for files that changed. */
const modelTailCache = new Map();

/**
 * The model a session last used, taken from the end of its store.
 *
 * Naming the model on every row means touching every store, so this reads only
 * the tail: the answer sits at the end, and walking whole stores would mean
 * reading hundreds of megabytes on every scan (one Codex session here is 16MB).
 * Cached by size and mtime, so a refresh is free until a session changes.
 *
 * The tail is widened once on a miss, because a store can end with a large tool
 * output that pushes the model marker out of the first window.
 *
 * Only `reading.model` is taken. The token figures a tail read produces would be
 * meaningless without the history before them — Codex derives its per-model
 * split from differences between running totals — so they are discarded rather
 * than shown as if they were the session's usage.
 */
async function modelFromTail(card) {
  const adapter = adapterOf(card.agent);
  if (adapter?.readStoreEvent === undefined || typeof card.file !== "string") return null;

  let stats = scanStats.get(card.file) ?? null;
  if (stats === null) {
    try {
      stats = await store().stat(card.file);
    } catch {
      return null;
    }
  }
  const stamp = `${stats.size}:${Math.round(stats.mtimeMs)}`;
  const cached = modelTailCache.get(card.file);
  if (cached !== undefined && cached.stamp === stamp) return cached.model;

  const windows = adapter.storeKind === "frames" ? [262144, 2097152] : [32768, 262144];
  // Tail first — it is the one that says which model is current — then the head,
  // for a dialect that named the model once and never again.
  const readers = [
    ...windows.map((bytes) => () => readStoreTail(card, bytes)),
    // 128KB is enough: a `model_change` or a first `turn_context` is in the
    // opening turns, and reading more for the rare miss costs every row.
    () => readStoreHead(card, 131072),
  ];
  for (const read of readers) {
    let text;
    try {
      text = await read(card, 0);
    } catch {
      continue;
    }
    const reading = freshReading();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // One event shape this adapter does not expect must not cost the whole row
      // its model.
      try {
        adapter.readStoreEvent(event, reading);
      } catch {
        continue;
      }
    }
    if (typeof reading.model === "string" && reading.model !== "") {
      modelTailCache.set(card.file, { stamp, model: reading.model });
      return reading.model;
    }
  }

  modelTailCache.set(card.file, { stamp, model: null });
  return null;
}

async function inventory(force, ctx) {
  const cards = [];
  const sources = [];
  // A pass's stats are its own: keeping them would answer a later request with a
  // file's previous size.
  scanStats.clear();

  /**
   * Every source is gathered at once.
   *
   * They are independent by construction, and when the panel is pointed at
   * another machine each one costs at least a round trip just to *walk* — six
   * sequential `find`s were most of a three-second remote scan. `mapLimit`
   * preserves the order the panel lists agents in, and turns one broken store
   * into a missing source rather than a failed scan.
   */
  const gathered = await mapLimit(SOURCES, SOURCES.length, async (source) => {
    const root = source.root();
    // A source that owns a non-file store answers with its own list.
    const values =
      typeof source.list === "function"
        ? await source.list(force)
        : await cachedCards(source, await walk(root, (_path, name) => source.match(name)), force);
    return { source, root, values };
  });

  for (const entry of gathered) {
    if (entry === null) continue;
    const { source, root, values } = entry;
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
    sources.push({ id: source.id, label: source.label, root, total: values.length, parsed, skipped });
  }

  // The model lives at the end of a store, which `build` never sees — it reads
  // the head for the title and cwd. So it is filled in here, once, in parallel.
  await mapLimit(cards, 8, async (card) => {
    card.model = await modelFromTail(card);
    return null;
  });

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
      stats = await store().stat(rest);
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
  const value = await cachedCard(adapterOf("dsh"), match, false);
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

/** How many turns one preview may carry; the oldest are dropped beyond it. */
const MAX_PREVIEW_MESSAGES = 600;

/**
 * Split a normalized transcript body back into its turns.
 *
 * The body is the one thing every adapter produces, and they all mark a turn
 * with exactly `## User` or `## Assistant` on its own line — so this needs no
 * per-agent code. Only those exact words count: people write markdown in their
 * prompts, and a heading like `## 场景路由` is part of a message, not a boundary.
 */
function messagesFrom(body) {
  const messages = [];
  let role = null;
  let at = null;
  let collapsed = null;
  let lines = [];
  const flush = () => {
    if (role === null) return;
    const text = lines.join("\n").trim();
    if (text !== "") messages.push({ role, text, at, collapsed });
    lines = [];
  };
  for (const line of String(body ?? "").split("\n")) {
    // The adapters write `## User · 2026-10-02 15:04`, and a compaction reads
    // `## Compacted · 2026-10-02 15:04 · 12491 tokens`. Both stamps are optional
    // so a dialect that records neither still parses.
    const heading = /^## (User|Assistant|Compacted)(?: · ([^·]+?))?(?: · (\d+) tokens)?$/.exec(line.trim());
    if (heading !== null) {
      flush();
      role = heading[1] === "User" ? "user" : heading[1] === "Assistant" ? "assistant" : "compacted";
      at = heading[2] ?? null;
      collapsed = heading[3] === undefined ? null : Number(heading[3]);
      continue;
    }
    if (role !== null) lines.push(line);
  }
  flush();
  return messages;
}

/**
 * Turn a path into DSH's own `@` file reference.
 *
 * Mirrors `formatFileMention` from the reference plugin exactly: a path the
 * grammar cannot represent (a quote, a control character) has no mention, and a
 * path with whitespace has to be quoted.
 */
function fileMention(path) {
  const text = String(path ?? "");
  if (text === "" || /[\u0000-\u001f\u007f-\u009f"]/u.test(text)) return null;
  return /\s/u.test(text) ? `@"${text}"` : `@${text}`;
}

/** The store root one agent owns; nothing outside it is ever touched. */
function rootOf(agent) {
  return SOURCES.find((source) => source.id === agent)?.root() ?? null;
}

async function deleteSession(card, force) {
  const source = SOURCES.find((entry) => entry.id === card.agent);
  if (source === undefined) throw new Error(`no store known for agent ${card.agent}`);

  /**
   * On another machine the running check cannot be performed at all.
   *
   * Liveness here is this machine's process table plus cmux's records, and
   * neither can see a process on the far side. Left alone, the guard would
   * simply stop working exactly where a mistake is hardest to notice: the card
   * would look idle, the delete would succeed, and a live agent's log would be
   * gone. Silence is the one wrong answer, so the deletion is refused until the
   * caller says — explicitly — that it knows liveness was not checked.
   */
  const remote = activeRemote();
  if (remote !== null && force !== true) {
    // Liveness over there is real but weaker: it is the remote process table,
    // and a process is only matched when it names its session or its working
    // directory does. So "not seen" is not the same as "not running", and the
    // caller has to say it knows that. A session we *did* see running gets the
    // same plain refusal as a local one, because there the answer is not in
    // doubt at all.
    const seen = card.running === true;
    const error = new Error(
      seen
        ? "session is running"
        : `cannot be sure this session is not still running on ${remote.label} — its agent is only visible there when it names the session`,
    );
    error.code = seen ? "running" : "liveness-unknown";
    throw error;
  }

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

  // The adapter says what to remove and what bookkeeping that implies; the
  // fence below is what keeps a wrong path from ever reaching `rm`.
  const plan = source.deletePlan !== undefined ? source.deletePlan(card) : { target: card.file, recursive: false };
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  if (!plan.target.startsWith(normalizedRoot)) {
    throw new Error(`refusing to delete ${plan.target}: outside ${normalizedRoot}`);
  }

  await store().remove(plan.target, { recursive: plan.recursive });

  // The adapter's bookkeeping runs through the same store the removal did: the
  // index it tidies is a sibling of the store, and on a remote environment it
  // lives on that machine rather than this one.
  const indexEntryRemoved = plan.after !== undefined ? await plan.after(store()) : false;
  cache.delete(card.file);
  previewCache.delete(card.file);
  lastCards = lastCards.filter((entry) => entry.key !== card.key);
  return { target: plan.target, indexEntryRemoved };
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
  // Pins are this plugin's own preference, not a session store, so they stay on
  // this machine even while the panel is pointed at another one.
  return join(sessionHubHome(), "state.json");
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
async function readTail(file, bytes, stats) {
  return store().readTail(file, bytes, stats);
}

/**
 * The same tail read, pinned to this machine.
 *
 * The hook spool is a file *this* Host's agents append to, so it must never be
 * read through a remote environment — a remote machine's hooks are its own.
 */
async function readTailLocal(file, bytes) {
  return localStore.readTail(file, bytes);
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
  // Same reasoning as the pins: agents *here* append to this spool, and reading
  // a remote machine's spool would attribute its hooks to local sessions.
  return join(sessionHubHome(), "hooks.jsonl");
}

const hookCache = { at: 0, value: null };

async function readHooks() {
  const now = Date.now();
  if (hookCache.value !== null && now - hookCache.at < 1500) return hookCache.value;

  const hooks = new Map();
  try {
    const { buffer, fromStart } = await readTailLocal(hooksPath(), 512 * 1024);
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

/**
 * Fold a store tail into the live preview's IN/OUT.
 *
 * Which events matter, and how a model's reasoning block differs from its
 * answer, is the owning adapter's business; this only supplies the accumulator.
 */
function previewFrom(agent, events) {
  const state = { input: null, output: null, at: null };
  adapterOf(agent)?.readPreview?.(events, state);
  return state;
}
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
    /** The model in effect, set by whichever adapter can tell. */
    model: null,
    /** Model → usage, so a session that switched models shows both. */
    models: new Map(),
    /** Codex reports running totals, so its per-model split needs the previous one. */
    codexSeen: null,
    asked: new Set(),
    decided: new Set(),
    approvalTools: new Map(),
    tools: new Map(),
  };
}

/**
 * Fold one store event into a running session's token total and waiting set.
 *
 * An adapter that records neither simply has no `readStoreEvent`, and the
 * reading stays empty rather than being guessed at.
 */
function readEvent(agent, event, reading) {
  adapterOf(agent)?.readStoreEvent?.(event, reading);
}
function summariseReading(reading) {
  // A Map cannot survive JSON, and an empty one means "this dialect records no
  // model name" rather than "no models were used".
  const models = reading.models.size === 0 ? null : Object.fromEntries(reading.models);

  // An approval is a fact, a live tool call is an inference: the fact wins.
  const waiting = [...reading.asked].filter((id) => !reading.decided.has(id));
  const pending =
    waiting.length > 0
      ? { kind: "approval", label: reading.approvalTools.get(waiting[0]) ?? null, count: waiting.length }
      : reading.tools.size > 0
        ? { kind: "tool", label: [...reading.tools.values()][0] ?? null, count: reading.tools.size }
        : null;

  // The current model is reported separately: a dialect can name its model
  // without recording any usage for it, and that name is still worth showing.
  const model = typeof reading.model === "string" && reading.model !== "" ? reading.model : null;
  return { tokens: reading.tokens, model, models, pending };
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
    stats = await store().stat(card.file);
  } catch {
    return null;
  }

  // Only a store of concatenated frames cannot be read from a byte offset.
  if (adapterOf(card.agent)?.storeKind === "frames") {
    const stamp = `${stats.mtimeMs}:${stats.size}`;
    if (reading.stamped !== stamp) {
      try {
        const text = decodeZstdFrames(await store().readFile(card.file)).toString("utf8");
        for (const event of parseJsonl(text)) readEvent(card.agent, event, reading);
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
    try {
      const buffer = await store().readAt(card.file, reading.offset, length);
      if (buffer.length <= 0) break;
      reading.offset += buffer.length;

      const text = reading.carry + buffer.toString("utf8");
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
    stats = await store().stat(card.file);
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
    if (adapterOf(card.agent)?.storeKind === "frames") {
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

/** The command that reopens a session in its own agent, or null when unknown. */
function resumeCommandFor(card) {
  const id = card.sessionId;
  if (typeof id !== "string" || id === "") return null;
  return adapterOf(card.agent)?.resumeCommand(id) ?? null;
}
async function launchInTerminal(cwd, command, title) {
  const cli = resolveCmuxCli();
  if (cli !== null) {
    const openWorkspace = () =>
      execFileAsync(
        cli,
        ["new-workspace", "--cwd", cwd, "--command", command, "--name", oneLine(title, 40), "--focus", "true"],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );

    try {
      await openWorkspace();
      return { kind: "cmux", command, terminal: "cmux" };
    } catch {
      // cmux can only be *told* things while it is running: of its whole command
      // set only the bare `cmux <path>` form launches the app. So a closed cmux
      // used to mean every open silently landed in Terminal.app instead. Start
      // it and try once more before falling back.
      try {
        // By bundle id, not by name: `open -a cmux` resolves an app *file*, which
        // is a different and weaker lookup than the identity the system has.
        await execFileAsync("open", ["-b", "com.cmuxterm.app"], { timeout: 10000, maxBuffer: 1024 * 1024 });
        if (await waitForCmuxSocket()) {
          await openWorkspace();
          return { kind: "cmux", command, terminal: "cmux" };
        }
      } catch {
        /* Genuinely unavailable — the terminal below is the fallback. */
      }
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
/** Where cmux listens, in the order its own CLI reports them. */
const CMUX_SOCKETS = [".local/state/cmux/cmux.sock", "/tmp/cmux.sock"];

/**
 * Wait until cmux is listening, or give up.
 *
 * Waiting on the socket rather than on a fixed delay: how long an app takes to
 * come up is not something to guess at, and the socket is exactly what the next
 * command needs — it is the difference between "launched" and "usable".
 */
async function waitForCmuxSocket(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of CMUX_SOCKETS) {
      try {
        accessSync(candidate.startsWith("/") ? candidate : join(localHome(), candidate), fsConstants.F_OK);
        return true;
      } catch {
        /* Not listening yet. */
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Wake a session in a terminal: focus it when it is already running, otherwise
 * open a new one there.
 *
 * This is a transport, not an intent — every dialect that runs as a command ends
 * up here, which is why it is Host machinery rather than something each adapter
 * repeats.
 *
 * @returns {Promise<object|null>} Null when no resume command is known.
 */
async function openInTerminal(card) {
  const cli = resolveCmuxCli();

  // A session cmux is already running gets *focused*, not resumed. Launching a
  // second copy of a live session is the one outcome nobody wants: it either
  // fights over the same store or quietly forks the conversation.
  if (cli !== null) {
    const records = await readCmuxSessions(false);
    const row = records.get(`${card.agent}:${card.sessionId}`);
    const live = row !== undefined && (row.stored_pid_exists === true || pidAlive(row.pid));
    const workspaceId = typeof row?.workspace_id === "string" && row.workspace_id !== "" ? row.workspace_id : null;
    if (live && workspaceId !== null) {
      try {
        await execFileAsync(cli, ["select-workspace", "--workspace", workspaceId], { timeout: 15000, maxBuffer: 1024 * 1024 });
        return { kind: "focus", sessionId: card.sessionId, command: null, terminal: "cmux", workspaceId };
      } catch {
        /* Falling through launches a fresh one, which is still better than nothing. */
      }
    }
  }

  const command = card.resumeCommand ?? resumeCommandFor(card);
  if (command === null) {
    return { kind: "manual", sessionId: card.sessionId, command: null, reason: "no resume command known" };
  }

  const cwd = typeof card.cwd === "string" && card.cwd !== "" ? card.cwd : localHome();
  const launched = await launchInTerminal(cwd, command, `${card.agentLabel} · ${card.title}`);
  return { ...launched, sessionId: card.sessionId };
}

/**
 * Walk an adapter's open plan, best step first.
 *
 * The plan is the adapter's; the transports below are the Host's. A step that
 * cannot be honoured — a deep link nothing registers, a terminal that refuses to
 * open — falls through to the next, and the default plan is a single terminal
 * step, so a dialect only has to say something when it has more than one option.
 */
async function openOriginal(value, options) {
  const { card } = value;
  const adapter = adapterOf(card.agent);

  const remote = activeRemote();
  if (remote !== null) return await openOnRemote(card, adapter, remote, options);

  if (adapter?.clientOwned === true) {
    return { kind: "dsh", sessionId: card.sessionId, command: null, terminal: null };
  }

  const plan = adapter?.openPlan?.(card) ?? [{ kind: "terminal" }];
  for (const step of plan) {
    if (step.kind === "app") {
      if (typeof step.url !== "string" || step.url === "") continue;
      try {
        await execFileAsync("open", [step.url], { timeout: 10000, maxBuffer: 1024 * 1024 });
        return { kind: "desktop", sessionId: card.sessionId, command: `open ${step.url}`, terminal: step.label ?? "the app" };
      } catch {
        /* Nothing handles the scheme: the next step is the point of a plan. */
      }
      continue;
    }
    if (step.kind === "terminal") {
      const opened = await openInTerminal(card);
      if (opened !== null) return opened;
    }
  }

  return { kind: "manual", sessionId: card.sessionId, command: null, reason: "no way to open this session on this machine" };
}

/**
 * Start a brand-new session in a project, with the agent the caller picked.
 *
 * DSH sessions are started through the client (they belong to the workspace
 * registry, not to a shell), so this handles the command-line agents only.
 */
async function spawnSession(agent, cwd, { launch = false } = {}) {
  const target = adapterOf(agent);
  const command = target?.spawnCommand ?? null;
  if (command === null) {
    return { ok: false, error: `no way to start a ${agent} session from here` };
  }

  // Where the project is decides where the agent starts and how the terminal
  // here must be asked to start it. On this machine that is simply the project
  // directory and the bare command; on another one it is an `ssh -t` that enters
  // the directory over there.
  const machine = host();
  const { cwd: start, command: invocation } = machine.invocation(command, { cwd });
  const suffix = machine.kind === "remote" ? ` · ${machine.label}` : "";
  const label = `${target.label} · ${basename(cwd)}${suffix}`;

  // Same contract as `open`: on another machine the command goes back to the
  // client, which types it into this window's terminal tab; `launch: true` opens
  // a window instead, for a build whose terminal tab cannot be driven.
  if (machine.kind === "remote" && !launch) {
    return { ok: true, agent, cwd, command: invocation, cwd_start: start, remote: machine.id, label, kind: "terminal-command" };
  }

  const launched = await launchInTerminal(start, invocation, label);
  return {
    ok: true,
    agent,
    cwd,
    command: invocation,
    ...(machine.kind === "remote" ? { remote: machine.id } : {}),
    ...launched,
  };
}

/* ------------------------------------------------------------------ *
 * Environments — which machine's sessions these are
 * ------------------------------------------------------------------ */

/**
 * What this generation is currently pointed at.
 *
 * Module state, not per-request: an environment is a property of the panel, and
 * the adapters answer "where do your stores live" from it. The probe and the
 * last failure are kept beside the choice so the client can say *why* a machine
 * is not showing anything, instead of showing nothing.
 */
const environmentState = {
  /** Environments this plugin's own config declares, plus `local`. */
  base: [LOCAL_ENVIRONMENT],
  baseProblems: [],
  /** The person's own list, read from this plugin's state file. */
  saved: [],
  /** The catalogue after every source that declares a machine is folded in. */
  list: [LOCAL_ENVIRONMENT],
  problems: [],
  activeId: LOCAL_ENVIRONMENT.id,
  probe: null,
  error: null,
  restoring: null,
  /** The live log of reaching an environment, or null when nothing is happening. */
  progress: null,
};

/**
 * Machines another plugin publishes, when one does.
 *
 * This plugin owns the machine list itself — `~/.ssh/config`, its `environments`
 * config and what was added from the panel — so this exists only so a plugin
 * that knows about other machines can hand them over. It is a compatibility
 * path, not the source of truth.
 *
 * `ctx.get` rather than `inject`: declaring `remoteHosts` as a hard dependency
 * would make this plugin refuse to activate in a composition where nobody
 * publishes it, which is far too strong a demand for a list this optional. It is
 * the same accessor the keep-alive uses for the timer.
 */
function publishedHosts(ctx) {
  const service = typeof ctx?.get === "function" ? ctx.get("remoteHosts") : undefined;
  if (service === undefined || service === null) return [];
  if (Array.isArray(service)) return service;
  try {
    const listed = typeof service.list === "function" ? service.list() : [];
    return Array.isArray(listed) ? listed : [];
  } catch {
    // A provider that throws must not take the whole panel with it; the
    // machines this plugin knows on its own still answer.
    return [];
  }
}

/**
 * Recompute the catalogue from both places a machine can be declared.
 *
 * Recomputed rather than frozen at activation, because the two sources do not
 * arrive together: `remoteHosts` is published by another plugin's fiber, and a
 * generation that read it once too early would show a short list forever.
 */
async function refreshEnvironmentList(ctx) {
  const state = await readEnvironmentState();
  environmentState.saved = state.hosts;
  environmentState.list = mergeEnvironments(environmentState.base, publishedHosts(ctx), state.hosts);
  environmentState.problems = environmentState.baseProblems;
  return environmentState.list;
}

/**
 * Every machine the panel could switch to, and where each one was declared.
 *
 * Three sources are merged for the switcher, so the manager has to show all
 * three: a person who cannot see that an alias came from `~/.ssh/config` will
 * wonder why deleting it does nothing to it.
 */
async function hostCandidates(ctx) {
  const [sshHosts, state] = await Promise.all([readSshHosts(), readEnvironmentState()]);
  const saved = new Map(state.hosts.map((host) => [host.alias, host]));
  const published = new Map(publishedHosts(ctx).map((host) => [host.alias, host]));
  const configured = new Map(
    environmentState.base.filter((entry) => entry.kind === "remote").map((entry) => [entry.alias, entry]),
  );
  const inCatalogue = new Set(environmentState.list.map((entry) => entry.id));

  const rows = new Map();
  const add = (alias, row) => {
    if (typeof alias !== "string" || alias === "") return;
    // The first writer wins, in the same order the catalogue merges: a machine
    // named by two sources must be described by the one that decides.
    if (rows.has(alias)) return;
    rows.set(alias, row);
  };

  for (const [alias, host] of configured) {
    add(alias, { alias, label: host.label, source: "config", home: host.home ?? null, dshHome: host.dshHome ?? null });
  }
  for (const [alias, host] of saved) {
    add(alias, {
      alias,
      label: host.label,
      source: "saved",
      home: host.home ?? null,
      dshHome: host.dshHome ?? null,
      enabled: host.enabled !== false,
    });
  }
  for (const [alias, host] of published) {
    add(alias, {
      alias,
      label: host.label,
      source: "published",
      home: host.home ?? null,
      dshHome: host.dshHome ?? null,
    });
  }
  for (const host of sshHosts) {
    add(host.alias, {
      alias: host.alias,
      label: host.alias,
      source: "ssh",
      hostName: host.hostName,
      user: host.user,
      port: host.port,
      home: null,
      dshHome: null,
    });
  }

  return [...rows.values()].map((row) => ({
    ...row,
    // What the switcher would show. A saved `enabled: false` is exactly the
    // difference between "not an environment" and "not known at all".
    enabled: row.enabled === undefined ? true : row.enabled,
    isEnvironment: inCatalogue.has(row.alias),
  }));
}

/**
 * The active environment, when it is a machine other than this one.
 *
 * The launch transports ask this. Opening a session means something different on
 * another machine, but *what* differs is a transport detail — an adapter still
 * only says which command resumes its dialect.
 */
function activeRemote() {
  if (environmentState.activeId === LOCAL_ENVIRONMENT.id) return null;
  const environment = findEnvironment(environmentState.list, environmentState.activeId);
  return environment !== null && environment.kind === "remote" ? environment : null;
}

/**
 * Open a session that lives on another machine.
 *
 * The desktop deep links and the cmux focus path are deliberately skipped: both
 * are about apps running *here*, and feeding a remote session's id to a local
 * deep link opens the wrong thing or nothing at all. A terminal running `ssh -t`
 * is the one transport that means the same thing on both sides.
 */
async function openOnRemote(card, adapter, environment, { launch = false } = {}) {
  if (adapter?.clientOwned === true) {
    return {
      kind: "manual",
      sessionId: card.sessionId,
      command: null,
      remote: environment.id,
      reason: `a DSH session on ${environment.label} belongs to that machine's own DSH`,
    };
  }

  const command = card.resumeCommand ?? resumeCommandFor(card);
  if (command === null) {
    return {
      kind: "manual",
      sessionId: card.sessionId,
      command: null,
      remote: environment.id,
      reason: `no resume command is known for a ${card.agent} session`,
    };
  }

  // The host decides where a local terminal starts and what it runs there: for a
  // remote machine that is this machine's home plus an `ssh -t` carrying the
  // command, because the session's `cwd` is a path on the far side.
  const { cwd, command: invocation } = host().invocation(command, { cwd: card.cwd });

  /**
   * Hand the command back instead of opening a window, unless asked to open one.
   *
   * A remote session is best opened in this window's **own terminal tab** — the
   * one the person already has, rather than a new cmux workspace or Terminal.app
   * window. But typing into that tab is the *client's* job: the tab and the
   * terminal view live in the browser. So the default answer is the command, and
   * `launch: true` is the fallback for a build whose Sidebar terminal cannot be
   * driven.
   */
  if (!launch) {
    return {
      kind: "terminal-command",
      sessionId: card.sessionId,
      command: invocation,
      cwd,
      remote: environment.id,
      label: `${card.agentLabel} · ${card.title} · ${environment.label}`,
    };
  }

  const launched = await launchInTerminal(cwd, invocation, `${card.agentLabel} · ${card.title} · ${environment.label}`);
  return { ...launched, sessionId: card.sessionId, remote: environment.id };
}

/**
 * Adopt an environment: scope the homes, swap the store, drop the caches.
 *
 * The order matters. The homes are scoped even when the probe failed — as long
 * as they are known — because a store that cannot be read must fail *as that
 * machine*. Letting the scope fall back to this machine would run this machine's
 * paths through the remote store, or worse, read this machine's files while the
 * panel claims to show another one.
 */
/**
 * Record one step of reaching an environment, for the panel to print.
 *
 * Reaching another machine is a handful of steps that each take seconds, and a
 * switch that shows nothing for twelve of them reads as a freeze. These are the
 * same lines that would go to a terminal — the point is that the person can see
 * *why* it is taking that long, not merely that it is.
 */
function progressStep(level, text) {
  const progress = environmentState.progress;
  if (progress === null) return;
  progress.steps.push({ at: Date.now(), level, text });
  // A probe that retries must not grow this without bound.
  if (progress.steps.length > 80) progress.steps.splice(0, progress.steps.length - 80);
}

/** Start a fresh progress log for `environment`, ending whatever came before. */
function progressBegin(environment) {
  environmentState.progress = {
    id: environment.id,
    alias: environment.alias,
    label: environment.label,
    kind: environment.kind,
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
  };
}

/**
 * Point the plugin at an environment.
 *
 * Switching is two different things wearing one hat: **the person's choice**,
 * which is instant, and **whether that machine answers**, which is a network
 * fact that can take twelve seconds. Making the choice wait on the fact is what
 * made a click feel like a freeze — against a machine behind a dead tunnel the
 * panel simply stopped responding until SSH gave up.
 *
 * So a deliberate switch applies immediately on what the catalogue already
 * knows (each entry carries its own `home`/`dshHome`), and the probe runs
 * afterwards to confirm it. `wait` is for the callers that genuinely cannot
 * proceed without an answer: restoring the remembered environment before the
 * first store read, and the explicit "test this machine" action.
 */
async function activateEnvironment(id, { force = false, wait = true } = {}) {
  const environment = findEnvironment(environmentState.list, id) ?? LOCAL_ENVIRONMENT;
  environmentState.activeId = environment.id;

  progressBegin(environment);
  progressStep("info", `ssh ${environment.alias}`);

  if (environment.kind === "local") {
    progressStep("ok", "this machine — nothing to connect to");
    environmentState.progress.finishedAt = Date.now();
    setEnvironmentScope(null);
    setHost(localHost);
    environmentState.probe = null;
    environmentState.error = null;
    return environmentState;
  }

  const settle = async () => {
    progressStep("info", "probing over ssh…");
    const probe = await probeEnvironment(environment, { force });

    // This can run in the background, so by the time it answers the person may
    // have switched again. A late probe must never land on top of the newer
    // choice — that would silently move every path back to the machine they
    // just left.
    if (environmentState.activeId !== environment.id) return environmentState;

    const homes = resolveHomes(environment, probe);
    environmentState.probe = probe;
    setEnvironmentScope(homes);
    // One object for both halves: bytes and commands follow the same environment.
    setHost(createRemoteHost({ id: environment.id, label: environment.label, alias: environment.alias }));
    environmentState.error =
      probe.reachable && homes !== null ? null : probe.error ?? `cannot resolve $HOME on ${environment.alias}`;
    if (probe.reachable && homes !== null) {
      progressStep("ok", `connected · home=${homes.home} · dsh=${homes.dshHome}`);
      progressStep("info", `agents found: ${Array.isArray(probe.agents) && probe.agents.length > 0 ? probe.agents.join(", ") : "none"}`);
    } else {
      progressStep("error", environmentState.error);
    }
    environmentState.progress.finishedAt = Date.now();
    return environmentState;
  };

  if (wait) return settle();

  const homes = resolveHomes(environment, null);
  if (homes === null) {
    // Nothing in the catalogue says where its `sessions/` live, so there is
    // nothing to point at until the probe answers — say so rather than guess.
    setEnvironmentScope(null);
    setHost(localHost);
    environmentState.probe = null;
    environmentState.error = `resolving ${environment.alias}…`;
  } else {
    setEnvironmentScope(homes);
    setHost(createRemoteHost({ id: environment.id, label: environment.label, alias: environment.alias }));
    environmentState.probe = null;
    environmentState.error = null;
  }

  // Deliberately not awaited: the click has already landed, and this only
  // refines it. A rejection here must not become an unhandled one.
  void settle().catch((error) => {
    progressStep("error", String(error?.message ?? error));
    environmentState.progress.finishedAt = Date.now();
  });
  return environmentState;
}

/** Restore the remembered environment once, before the first store read. */
function ensureEnvironment(ctx) {
  if (environmentState.restoring === null) {
    environmentState.restoring = (async () => {
      // The catalogue is recomputed *before* the remembered choice is resolved:
      // the saved id may name a machine that only a published list knows about, or
      // one the person added from the panel, and resolving it against a stale
      // list would silently land on `local`.
      await refreshEnvironmentList(ctx);
      const saved = await readActiveId();
      if (saved !== environmentState.activeId) await activateEnvironment(saved);
      return environmentState;
    })();
  }
  return environmentState.restoring;
}

/** The active environment as the client sees it, including whether it is usable. */
function describeEnvironment() {
  const environment = findEnvironment(environmentState.list, environmentState.activeId) ?? LOCAL_ENVIRONMENT;
  const probe = environmentState.probe;
  return {
    id: environment.id,
    kind: environment.kind,
    label: environment.label,
    alias: environment.alias ?? null,
    reachable: environment.kind === "local" ? true : probe?.reachable === true && environmentState.error === null,
    error: environmentState.error,
    home: environment.home ?? probe?.home ?? null,
    dshHome: environment.dshHome ?? probe?.dshHome ?? null,
    agents: probe?.agents ?? null,
    at: probe?.at ?? null,
  };
}

/** Every environment the client may switch between. */
function environmentCatalogue() {
  return environmentState.list.map((environment) => ({
    id: environment.id,
    kind: environment.kind,
    label: environment.label,
    alias: environment.alias ?? null,
    // Where it was declared. The manager needs it — a person who cannot see that
    // an alias came from `~/.ssh/config` will wonder why "forget" does nothing.
    source: environment.source ?? (environment.kind === "local" ? "local" : "config"),
  }));
}

/**
 * Refuse a store-reading operation while the active environment is unusable.
 *
 * This is what makes the switcher honest. Without it, selecting an unreachable
 * machine would run this machine's adapters against paths that do not exist
 * here and answer "no sessions" — a connection failure presented as an empty
 * machine. Local data is never shown as remote, and broken is never shown as
 * empty.
 */
function environmentGuard() {
  if (environmentState.activeId === LOCAL_ENVIRONMENT.id) return null;
  if (environmentState.error === null) return null;
  return { ok: false, error: environmentState.error, environment: describeEnvironment() };
}

/** Operations that read a session store, and so need a usable environment. */
const STORE_OPS = new Set([
  "list",
  "status",
  "preview",
  "models",
  "messages",
  "transcript",
  "continue",
  "open",
  "reference",
  "delete",
  "delete-many",
  "config",
]);

/* ------------------------------------------------------------------ *
 * Agent configuration files
 * ------------------------------------------------------------------ */

/** One config file's declaration for an agent, or null when it declares none. */
function declaredConfigFiles(agent) {
  const source = adapterOf(agent);
  if (source === null || typeof source.configFiles !== "function") return null;
  const files = source.configFiles();
  return Array.isArray(files) ? files : [];
}

/**
 * The fence around a config read or write.
 *
 * Exactly the paths the adapter declared, matched as whole strings — not as
 * prefixes, and not resolved. A viewer that accepted a path from the browser
 * would be an arbitrary-file read and write on this machine *and*, once an
 * environment is remote, on another one. The adapter names its own config files;
 * nothing else is reachable.
 */
function fencedConfigPath(agent, path) {
  const files = declaredConfigFiles(agent);
  if (files === null) return { ok: false, error: `unknown agent: ${agent}` };
  if (typeof path !== "string" || path === "") return { ok: false, error: "config needs a path" };
  const hit = files.find((file) => file.path === path);
  if (hit === undefined) return { ok: false, error: `${path} is not a declared config file for ${agent}` };
  return { ok: true, file: hit };
}

/** Big enough for a real config, far too small for a runaway file. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

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
/**
 * Ops that have moved into their own module, by name.
 *
 * A migration seam, not a second dispatch: everything still reaches `dispatch`,
 * and each handler is checked against the same contract the adapters use. The
 * rest of the chain below is what has not moved yet.
 */
const REGISTRY = opRegistry([...environmentOps]);

/**
 * What an op module is allowed to reach for.
 *
 * The ops were part of this file once, so they used its internals as free
 * variables. Handing them over explicitly is what makes the boundary real: the
 * list below is the surface, and `test/imports.mjs` fails the moment a module
 * calls something that is not on it.
 */
const HOST_SERVICES = {
  LOCAL_ENVIRONMENT,
  MAX_CONFIG_BYTES,
  SOURCES,
  environmentState,
  activateEnvironment,
  declaredConfigFiles,
  describeEnvironment,
  environmentCatalogue,
  environmentStatePath,
  fencedConfigPath,
  findEnvironment,
  hostCandidates,
  isHostAlias,
  mapLimit,
  probeEnvironment,
  readEnvironmentState,
  refreshEnvironmentList,
  store,
  writeActiveId,
  writeEnvironmentState,
};

const OPS = ["list", "status", "preview", "pin", "transcript", "messages", "models", "vscode", "continue", "reference", "open", "spawn", "delete", "delete-many"];

async function dispatch(payload, ctx) {
  const op = typeof payload?.op === "string" ? payload.op : "list";

  await ensureEnvironment(ctx);

  const registered = REGISTRY.get(op);
  if (registered !== undefined) {
    // The storage guard is applied here rather than inside each module, so a
    // handler cannot forget it — the same reason the flag is part of the contract.
    if (registered.store) {
      const refused = environmentGuard();
      if (refused !== null) return refused;
    }
    return registered.handle(payload, ctx, HOST_SERVICES);
  }

  /**
   * Which machine the panel is looking at, and the switch itself.
   *
   * Switching is host-side state rather than a query parameter: the adapters
   * answer "where is your store" from the active environment, so it has to be
   * one answer for the whole Host, not a per-request override.
   */

  if (STORE_OPS.has(op)) {
    const refused = environmentGuard();
    if (refused !== null) return refused;
  }

  /**
   * The agents' own configuration files, read and written in place.
   *
   * This is the one operation that writes into a store's neighbourhood, so it is
   * fenced twice: the path must be one the adapter declared, and the previous
   * body is copied aside before the new one lands. The environment switcher
   * makes the same call edit `/home/zakl/.claude/settings.json` over there
   * instead of `~/.claude/settings.json` here, because the adapter derives the
   * path from `home()` like everything else.
   */

  /**
   * The machines the panel can switch to, and the way to change that list.
   *
   * Deliberately **not** behind the reachability guard, unlike every other op:
   * this is how a person gets out of an environment that cannot be reached, so
   * it has to work precisely when that one does not. It reads no session store —
   * only `~/.ssh/config`, this plugin's state file, and the `remoteHosts`
   * service.
   */

  if (op === "list") {
    const { cards, sources, runningCount, cmux, pins } = await inventory(payload?.refresh === true, ctx);
    return {
      ok: true,
      generatedAt: Date.now(),
      cmux,
      cmuxPath: resolveCmuxCli(),
      agents: SOURCES.map((source) => ({ id: source.id, label: source.label })),
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

    // The same refusal as a single delete, stated once for the batch. It has to
    // be here rather than left to `deleteSession`: the loop below passes `force`
    // for every key (the running ones were already skipped above), so the
    // per-session check would never be reached.
    const batchRemote = activeRemote();
    const force = payload?.force === true;
    if (batchRemote !== null && !force) {
      return {
        ok: false,
        code: "liveness-unknown",
        error: `cannot tell whether these sessions are still running on ${batchRemote.label} — deleting a live session's log can break it`,
      };
    }

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
        model: reading?.model ?? null,
        models: reading?.models ?? null,
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
   * Which models a session used, and what each one spent.
   *
   * Answered from the same store walk that produces the token total, so the two
   * can never disagree. A session that switched models reports every model it
   * used, not just the last one — the last one alone would read as though the
   * whole conversation ran on it.
   */
  if (op === "models") {
    const key = typeof payload?.key === "string" ? payload.key : "";
    const card = lastCards.find((entry) => entry.key === key);
    if (card === undefined) return { ok: false, error: "unknown session key" };

    const reading = await readStore(card);
    if (reading === null) return { ok: false, error: "this session has no readable store" };
    return {
      ok: true,
      key: card.key,
      sessionId: card.sessionId,
      agent: card.agent,
      agentLabel: card.agentLabel,
      title: card.title,
      model: reading.model,
      models: reading.models,
      tokens: reading.tokens,
    };
  }

  /**
   * Open a project directory in VS Code.
   *
   * A plain detached spawn, not a terminal launch: `code` hands the path to a
   * running window, so there is no shell and no window left behind it.
   */
  if (op === "vscode") {
    const cwd = typeof payload?.cwd === "string" && payload.cwd.startsWith("/") ? payload.cwd : null;
    if (cwd === null) return { ok: false, error: "vscode needs an absolute cwd" };
    const cli = resolveEditorCli();
    if (cli === null) return { ok: false, error: "the code CLI was not found" };
    try {
      spawn(cli, [cwd], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, cwd, editor: "code", cli };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * One session's turns, for the reader.
   *
   * This is the same normalized body the transcript renders, split back apart —
   * a reader wants the turns, not a markdown document.
   */
  if (op === "messages") {
    const value = await fullValueByKey(payload?.key);
    if (value === null || value === undefined) return { ok: false, error: "unknown session key" };

    const all = messagesFrom(value.body);
    const truncated = all.length > MAX_PREVIEW_MESSAGES;
    const messages = truncated ? all.slice(all.length - MAX_PREVIEW_MESSAGES) : all;
    // The same walk that answers tokens, so the reader can name the model it is
    // showing without a second request.
    const reading = await readStore(value.card);
    return {
      ok: true,
      model: reading?.model ?? null,
      models: reading?.models ?? null,
      key: value.card.key,
      sessionId: value.card.sessionId,
      agent: value.card.agent,
      agentLabel: value.card.agentLabel,
      title: value.card.title,
      cwd: value.card.cwd,
      updatedAt: value.card.updatedAt,
      total: all.length,
      truncated,
      messages,
    };
  }

  /**
   * The text that references one session inside a prompt draft.
   *
   * A DSH session has a native mention, so it gets that — the very chip the `@`
   * picker would insert. Every other agent has no such notion, so the reference
   * points at the session's own store artifact through the same `@` file
   * grammar. An artifact that is not a file is dumped first when the adapter
   * knows how, and reported as un-referenceable when it does not.
   */
  if (op === "reference") {
    const key = typeof payload?.key === "string" ? payload.key : "";
    const card = lastCards.find((entry) => entry.key === key);
    if (card === undefined) return { ok: false, error: "unknown session key" };

    const source = adapterOf(card.agent);
    if (source === null) return { ok: false, error: `unknown agent: ${card.agent}` };
    const artifact = source.sessionFile(card);

    if (card.agent === "dsh") {
      const currentId = typeof payload?.currentSessionId === "string" ? payload.currentSessionId : "";
      const owner = currentId === "" ? undefined : ctx?.get?.("agents")?.get?.(currentId);
      const resolver = ctx?.get?.("sessionReferenceResolver");
      if (owner !== undefined && resolver !== undefined) {
        try {
          const found = await resolver.remoteExportCandidates(owner, card.sessionId ?? card.title ?? "", undefined);
          const list = Array.isArray(found) ? found : [];
          const hit = list.find((entry) => entry?.sessionId === card.sessionId) ?? list[0] ?? null;
          if (typeof hit?.mention === "string" && hit.mention !== "") {
            return { ok: true, kind: "mention", text: hit.mention, label: hit.label ?? card.title, path: null };
          }
        } catch {
          /* No live resolver, or no retained session: fall through to the store. */
        }
      }
    }

    let path = artifact.path;
    if (artifact.kind !== "file") {
      if (typeof source.handoff !== "function") {
        return { ok: true, kind: "none", text: null, label: artifact.label, path, reason: "no readable artifact" };
      }
      const dumped = await source.handoff(card, { dir: join(tmpdir(), "dsh-session-hub-reference") });
      path = dumped.path;
    }

    const text = fileMention(path);
    if (text === null) {
      return { ok: true, kind: "none", text: null, label: artifact.label, path, reason: "path is not representable as a reference" };
    }
    return { ok: true, kind: "file", text, label: basename(path), path };
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
    const target = adapterOf(agent);
    if (target === null) return { ok: false, error: `unknown agent: ${agent}` };
    if (target.spawnCommand === null) {
      const remote = activeRemote();
      return {
        ok: false,
        error:
          remote !== null
            ? `a ${target.label} session cannot be started on ${remote.label} from here — that machine's own DSH owns its workspaces`
            : `a ${target.label} session is started by the client`,
      };
    }
    return await spawnSession(agent, cwd, { launch: payload?.launch === true });
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
    return { ok: true, ...(await openOriginal(value, { launch: payload?.launch === true })) };
  }

  // A stale Host is the failure this reports most often, so the message names
  // what this generation actually answers instead of just rejecting the op.
  // Both halves: an op that has moved must still be listed, or a stale client
  // would be told a name it already uses is unknown.
  return { ok: false, error: `unknown op: ${op}`, supported: [...REGISTRY.keys(), ...OPS] };
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
export function apply(ctx, config) {
  // Every generation starts on this machine and re-reads the remembered choice
  // on its first request. A reload must not inherit a store that pointed at a
  // machine this generation has not probed.
  const { environments, problems } = normalizeEnvironments(config);
  environmentState.base = environments;
  environmentState.baseProblems = problems;
  environmentState.activeId = LOCAL_ENVIRONMENT.id;
  environmentState.probe = null;
  environmentState.error = null;
  environmentState.restoring = null;
  setEnvironmentScope(null);
  setHost(localHost);
  // The catalogue is filled on the first request, not here: machines come from
  // other plugins' fibers (which may not have run yet) and from this plugin's
  // own state file (which is a disk read). Applying is synchronous.
  environmentState.saved = [];
  environmentState.list = [LOCAL_ENVIRONMENT];

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

/**
 * Pure helpers, exported so a test can reach them without a Host.
 *
 * `remoteInvocation` decides the exact string a terminal will run, and its whole
 * risk is quoting — which is only observable by handing the string to a shell
 * and looking at what `ssh` received. Going through the `open` op instead would
 * launch a real terminal window.
 */
export const __test = {
  /** The phrasing a remote host produces, built the way `activateEnvironment` builds it. */
  remoteInvocation: (environment, cwd, command) =>
    createRemoteHost({ id: environment.id, label: environment.label, alias: environment.alias }).invocation(command, {
      cwd,
    }).command,
  parseProcesses,
};
