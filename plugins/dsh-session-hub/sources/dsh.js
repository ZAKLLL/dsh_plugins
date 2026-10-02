/**
 * dsh-session-hub — DSH adapter.
 *
 * Zstandard in concatenated frames, then JSONL. Its store is not byte-addressable, so it is decoded whole.
 *
 * @module dsh-session-hub/sources/dsh
 */

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import {
  UNTITLED, accumulate, blocksOf, decodeZstdFrames, dshHome, home, looksInjected, num, oneLine,
  parseJsonl, projectOf, textOf, toMs, trackTool,
  handoffName,
  turnHeading,
} from "../shared.js";

/** The one place this adapter spells its own name. */
const LABEL = "DSH";

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
      lines.push(turnHeading("User", event.time), "", body, "");
    } else if (event.type === "assistant/message") {
      const body = textOf(event.data?.message?.content);
      if (body === "") continue;
      if (assistantTitle === "") assistantTitle = body;
      messages += 1;
      lines.push(turnHeading("Assistant", event.time), "", body, "");
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
      agentLabel: LABEL,
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

export default defineAdapter({
  id: "dsh",
  sessionFile: (card) => ({ path: dirname(card.file), kind: "directory", label: handoffName(card) }),
  label: LABEL,
  executables: [],
  spawnCommand: null,
  // A DSH session is opened in the DSH UI, not by launching anything.
  clientOwned: true,
  resumeCommand: () => null,
  root: () => join(dshHome(), "sessions"),
  storeKind: "frames",
  // Liveness comes from the in-process agent registry, not the process table:
  // a DSH agent IS this process.
  liveness: "registry",
  match: (name) => name.endsWith(".jsonl.zstd"),
  concurrency: 4,
  build: buildDsh,
  /**
   * Two things come off a DSH store: the model in effect, and what is waiting.
   *
   * The model is named on every request header, so the last one seen wins. Its
   * `assistant/attempt` stream does carry `usage` chunks, but every one of them
   * is zero on this machine — the provider reports none — and their semantics
   * (per attempt or cumulative) cannot be read off zeros. So no tokens are taken
   * from them: guessing would put a number on screen that nothing measured.
   */
  readStoreEvent(event, reading) {
    if (event.type === "request/header") {
      const config = event.data?.header?.config;
      const key = [config?.provider, config?.model].filter((part) => typeof part === "string" && part !== "").join("/");
      if (key !== "") reading.model = key;
      return;
    }

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
  },
  readPreview(events, state) {
    let input = state.input;
    let output = state.output;
    const stamp = (value) => {
      const ms = toMs(value);
      if (ms !== null) state.at = Math.max(state.at ?? 0, ms);
    };
    for (const event of events) {
      if (event.type === "user/message") {
        const body = textOf(event.data?.content);
        if (body !== "" && !looksInjected(body)) input = body;
      } else if (event.type === "assistant/message") {
        const body = textOf(event.data?.message?.content);
        if (body !== "") output = body;
      }
      stamp(event.time);
    }
    state.input = input;
    state.output = output;
  },
  deletePlan: (card) => ({ target: dirname(card.file), recursive: true }),
});
