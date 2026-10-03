/**
 * dsh-session-hub — pi adapter.
 *
 * JSONL under ~/.pi/agent/sessions; its header is close to DSH's.
 *
 * @module dsh-session-hub/sources/pi
 */

import { basename, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import {
  UNTITLED,
  accumulate,
  home,
  looksInjected,
  oneLine,
  projectOf,
  textOf,
  toMs,
  handoffName,
  turnHeading,
} from "../shared.js";

/** The one place this adapter spells its own name. */
const LABEL = "pi";

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
      lines.push(turnHeading("User", event.timestamp), "", body, "");
    } else if (payload.role === "assistant") {
      messages += 1;
      if (assistantTitle === "") assistantTitle = body;
      lines.push(turnHeading("Assistant", event.timestamp), "", body, "");
    }
  }

  return {
    card: {
      key: `pi:${file}`,
      agent: "pi",
      agentLabel: LABEL,
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

function hasPiSignal(events) {
  for (const event of events) {
    if (event.type !== "message" || event.message?.role !== "user") continue;
    const body = textOf(event.message.content);
    if (body !== "" && !looksInjected(body)) return true;
  }
  return false;
}

export default defineAdapter({
  id: "pi",
  sessionFile: (card) => ({ path: card.file, kind: "file", label: handoffName(card) }),
  label: LABEL,
  executables: ["pi"],
  spawnCommand: "pi",
  resumeCommand: (id) => `pi --session ${id}`,
  root: () => join(home(), ".pi", "agent", "sessions"),
  configFiles: () => [
    { path: join(home(), ".pi", "agent", "settings.json"), label: "settings.json", language: "json", creatable: true },
    { path: join(home(), ".pi", "agent", "models.json"), label: "models.json", language: "json", creatable: true },
  ],
  storeKind: "jsonl",
  match: (name) => name.endsWith(".jsonl"),
  concurrency: 8,
  prefix: { start: 131072, max: 2097152, complete: (events) => hasPiSignal(events) },
  build: buildPi,
  readStoreEvent(event, reading) {
    if (event.type === "model_change") {
      // pi announces a switch; the usage that follows belongs to the new model.
      const key = [event.provider, event.modelId].filter((part) => typeof part === "string" && part !== "").join("/");
      if (key !== "") reading.model = key;
      return;
    }
    if (event.type === "message" && event.message?.role === "assistant") {
      const usage = event.message.usage;
      if (usage !== null && usage !== undefined) {
        accumulate(reading, {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          // pi states its own total; trust it over adding the parts.
          total: usage.totalTokens,
        });
      }
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
    }
    state.input = input;
    state.output = output;
  },
});
