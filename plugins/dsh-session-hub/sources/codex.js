/**
 * dsh-session-hub — Codex adapter.
 *
 * Rollout JSONL under ~/.codex/sessions; model-generated thread names live in session_index.jsonl instead.
 *
 * @module dsh-session-hub/sources/codex
 */

import { readFileSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import {
  UNTITLED, accumulate, blocksOf, decodeZstdFrames, dshHome, home, looksInjected, num, oneLine,
  parseJsonl, projectOf, textOf, toMs, trackTool,
  handoffName,
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

export default defineAdapter({
  id: "codex",
  sessionFile: (card) => ({ path: card.file, kind: "file", label: handoffName(card) }),
  label: LABEL,
  executables: ["codex"],
  spawnCommand: "codex",
  resumeCommand: (id) => `codex resume ${id}`,
  root: () => join(home(), ".codex", "sessions"),
  storeKind: "jsonl",
  match: (name) => name.endsWith(".jsonl"),
  concurrency: 16,
  prefix: { start: 131072, max: 2097152, complete: (events) => hasCodexSignal(events) },
  build: buildCodex,
  readStoreEvent(event, reading) {
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
    after: () => removeCodexIndexEntry(card.sessionId),
  }),
});
