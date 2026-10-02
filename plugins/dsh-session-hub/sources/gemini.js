/**
 * dsh-session-hub — Gemini CLI adapter.
 *
 * Chat JSONL under ~/.gemini/tmp; messages arrive as $set patches.
 *
 * @module dsh-session-hub/sources/gemini
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
const LABEL = "Gemini CLI";

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
      agentLabel: LABEL,
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

export default defineAdapter({
  id: "gemini",
  sessionFile: (card) => ({ path: card.file, kind: "file", label: handoffName(card) }),
  label: LABEL,
  executables: ["gemini"],
  spawnCommand: "gemini",
  resumeCommand: (id) => `gemini --resume ${id}`,
  root: () => join(home(), ".gemini", "tmp"),
  storeKind: "jsonl",
  match: (name) => name.endsWith(".jsonl"),
  concurrency: 8,
  prefix: { start: 131072, max: 2097152, complete: (events) => hasGeminiSignal(events) },
  build: buildGemini,
  /**
   * Gemini records the model and that turn's usage on the same `gemini` event.
   *
   * The usage is per turn — `input` is the whole context sent on that turn, and
   * it grows as the conversation does (measured here: 11,947 → 12,638 → 12,924)
   * — so summing the turns gives the billable total. Its own `total` already
   * includes the cached and thinking counts, so that figure is carried through
   * rather than recomputed.
   */
  readStoreEvent(event, reading) {
    if (event.type !== "gemini") return;
    if (typeof event.model === "string" && event.model !== "") reading.model = event.model;
    const tokens = event.tokens;
    if (tokens === null || tokens === undefined) return;
    accumulate(reading, {
      input: tokens.input,
      output: num(tokens.output) + num(tokens.thoughts),
      cacheRead: tokens.cached,
      total: tokens.total,
    });
  },
  readPreview(events, state) {
    let input = state.input;
    let output = state.output;
    const stamp = (value) => {
      const ms = toMs(value);
      if (ms !== null) state.at = Math.max(state.at ?? 0, ms);
    };
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
    state.input = input;
    state.output = output;
  },
});
