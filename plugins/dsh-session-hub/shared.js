/**
 * dsh-session-hub — helpers shared by the Host machinery and every agent adapter.
 *
 * Nothing here knows which agent it is serving. The moment a function needs to
 * ask "which agent is this?", it belongs in an adapter under `./sources/`
 * instead — see `./sources/adapter.js` for that contract.
 *
 * @module dsh-session-hub/shared
 */

import zlib from "node:zlib";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/** A session whose store holds no human text at all. */
export const UNTITLED = "(untitled)";

/** Upper bound on one bulk delete, so a runaway payload cannot walk the disk. */

/** Accept epoch ms, epoch seconds, or an ISO/parseable string. */
export function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function oneLine(text, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The concatenated `text` of a content payload, tolerating a plain string. */
/**
 * Block types that carry a model's private reasoning rather than its answer.
 *
 * This matters most for DSH, whose `reasoning` blocks also use a `text` field —
 * so a naive "any block with text" reader returns the model thinking out loud
 * instead of what it actually said. Measured on one machine's DSH logs:
 * 905 reasoning blocks against 386 text blocks, so reasoning was the bulk of
 * every preview, every transcript, and every title fallback.
 *
 * Claude and pi spell theirs `thinking`, with the body in a `thinking` field
 * that this reader already skipped by accident; naming them here makes the
 * intent explicit rather than incidental.
 */

/**
 * Block types that carry a model's private reasoning rather than its answer.
 *
 * This matters most for DSH, whose `reasoning` blocks also use a `text` field —
 * so a naive "any block with text" reader returns the model thinking out loud
 * instead of what it actually said. Measured on one machine's DSH logs:
 * 905 reasoning blocks against 386 text blocks, so reasoning was the bulk of
 * every preview, every transcript, and every title fallback.
 *
 * Claude and pi spell theirs `thinking`, with the body in a `thinking` field
 * that this reader already skipped by accident; naming them here makes the
 * intent explicit rather than incidental.
 */
export const REASONING_BLOCK_TYPES = new Set(["reasoning", "thinking", "redacted_thinking", "analysis", "thought"]);

/**
 * The visible text of a content-block list.
 *
 * A block counts when it carries a `text` string and is not a reasoning block;
 * a block with no `type` at all still counts, so simpler shapes keep working.
 */

/**
 * The visible text of a content-block list.
 *
 * A block counts when it carries a `text` string and is not a reasoning block;
 * a block with no `type` at all still counts, so simpler shapes keep working.
 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block.text === "string" && !REASONING_BLOCK_TYPES.has(block.type)) parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** Absolute project path → its last segment, for compact display. */

/** Absolute project path → its last segment, for compact display. */
export function projectOf(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  const trimmed = cwd.replace(/[/\\]+$/, "");
  return basename(trimmed) || trimmed;
}

/** Run `worker` over `items` with a bounded number of in-flight promises. */

/** Parse JSONL, skipping anything that is not a complete JSON record. */
export function parseJsonl(text) {
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

/**
 * Decode a Zstandard file made of **concatenated frames**.
 *
 * DSH appends one frame per flush and Node's `zstdDecompressSync` stops after
 * the first, so frames are located by magic number. A magic number occurring
 * inside compressed payload is harmless: the slice ending there fails to
 * decode and the next candidate boundary is tried instead.
 */
export function decodeZstdFrames(buffer) {
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
export function looksInjected(text) {
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

export function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function blocksOf(content) {
  return Array.isArray(content) ? content : [];
}

/** Add one turn's usage onto the running total. */

export const home = () => homedir();

export const dshHome = () => process.env.DSH_HOME || join(home(), ".dsh");

export function accumulate(reading, parts) {
  const current = reading.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  current.input += num(parts.input);
  current.output += num(parts.output);
  current.cacheRead += num(parts.cacheRead);
  current.cacheWrite += num(parts.cacheWrite);
  current.total = current.input + current.output + current.cacheRead + current.cacheWrite;
  reading.tokens = current;
}

/** Track one tool call by id, so a call that never finished stays visible. */

/** Track one tool call by id, so a call that never finished stays visible. */
export function trackTool(reading, id, name, present) {
  if (typeof id !== "string" || id === "") return;
  if (present) reading.tools.set(id, typeof name === "string" ? name : null);
  else reading.tools.delete(id);
}

/** Fold one store event into a reading. Each dialect reports different things. */
