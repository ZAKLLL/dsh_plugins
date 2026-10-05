/**
 * dsh-session-hub — Claude Code adapter.
 *
 * One JSONL file per session under ~/.claude/projects.
 *
 * @module dsh-session-hub/sources/claude
 */

import { basename, dirname, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import {
  UNTITLED,
  accumulate,
  blocksOf,
  home,
  looksInjected,
  oneLine,
  projectOf,
  textOf,
  toMs,
  trackTool,
  handoffName,
  turnHeading,
} from "../shared.js";

/** The one place this adapter spells its own name. */
const LABEL = "Claude Code";

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
      lines.push(turnHeading("User", event.timestamp), "", body, "");
    } else if (event.type === "assistant") {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const body = textOf(blocks);
      const tools = blocks.filter((block) => block?.type === "tool_use").map((block) => block.name);
      if (body === "" && tools.length === 0) continue;
      if (assistantTitle === "" && body !== "") assistantTitle = body;
      messages += 1;
      if (body !== "") lines.push(turnHeading("Assistant", event.timestamp), "", body, "");
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

export default defineAdapter({
  id: "claude",
  /**
   * How to start this agent's ACP server.
   *
   * From the published registry, which is the authority on the recipe and the
   * version: `npx <package>` is how most adapters ship. Declared here so
   * "can this row be chatted with in the panel" is answered by a declaration
   * rather than a list in the Host that drifts.
   */
  acp: { command: "npx", args: ["-y", "--package=@agentclientprotocol/claude-agent-acp@0.85.1", "claude-agent-acp"] },
  sessionFile: (card) => ({ path: card.file, kind: "file", label: handoffName(card) }),
  label: LABEL,
  executables: ["claude"],
  spawnCommand: "claude",
  resumeCommand: (id) => `claude --resume ${id}`,
  root: () => join(home(), ".claude", "projects"),
  // Every one is creatable: Claude Code reads them when present and ignores them
  // when not, so an empty editor is how a setting gets added at all.
  configFiles: () => [
    { path: join(home(), ".claude", "settings.json"), label: "settings.json", language: "json", creatable: true },
    { path: join(home(), ".claude", "settings.local.json"), label: "settings.local.json", language: "json", creatable: true },
    { path: join(home(), ".claude", "mcp.json"), label: "mcp.json", language: "json", creatable: true },
    { path: join(home(), ".claude", "CLAUDE.md"), label: "CLAUDE.md", language: "markdown", creatable: true },
  ],
  storeKind: "jsonl",
  match: (name) => name.endsWith(".jsonl"),
  concurrency: 16,
  prefix: { start: 131072, max: 2097152, complete: (events) => hasClaudeSignal(events) },
  build: buildClaude,
  readStoreEvent(event, reading) {
    if (event.type === "assistant") {
      // The model sits on the very message that carries the usage, so the split
      // is exact rather than inferred from context.
      if (typeof event.message?.model === "string" && event.message.model !== "") {
        reading.model = event.message.model;
      }
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
  },
  readPreview(events, state) {
    let input = state.input;
    let output = state.output;
    const stamp = (value) => {
      const ms = toMs(value);
      if (ms !== null) state.at = Math.max(state.at ?? 0, ms);
    };
    for (const event of events) {
      if (event.type === "user") {
        const body = claudeUserText(textOf(event.message?.content));
        if (body !== "" && !looksInjected(body)) input = body;
      } else if (event.type === "assistant") {
        const body = textOf(event.message?.content);
        if (body !== "") output = body;
      }
      stamp(event.timestamp);
    }
    state.input = input;
    state.output = output;
  },
});
