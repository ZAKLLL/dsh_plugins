#!/usr/bin/env node
/**
 * Session Hub hook sink.
 *
 * Any coding agent that can run a command can register with Session Hub by
 * appending one JSON line here. The plugin reads the spool and shows what the
 * agent reports on top of whatever it can derive from the agent's own store.
 *
 *   node hook.mjs --agent claude --session "$SESSION_ID" --phase output \
 *                 --input "the prompt" --output "the latest answer"
 *
 *   echo '{"agent":"codex","sessionId":"…","phase":"working"}' | node hook.mjs
 *
 * Flags win over the stdin object; `at` defaults to now. It never fails loudly:
 * a hook runs inside another product's turn, and a broken preview must never
 * break the agent that reported to it.
 *
 * Wiring examples live in the plugin README.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SPOOL = process.env.DSH_SESSION_HUB_HOOKS || join(DSH_HOME, "session-hub", "hooks.jsonl");

/** `--flag value` pairs; a flag with no value becomes `true`. */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = true;
      continue;
    }
    out[name] = next;
    index += 1;
  }
  return out;
}

/**
 * The flag names this sink understands, and the record field each fills.
 */
const FIELDS = {
  agent: "agent",
  session: "sessionId",
  sessionId: "sessionId",
  phase: "phase",
  input: "input",
  output: "output",
  cwd: "cwd",
  title: "title",
};

/**
 * Field names other products already use, so their own hook payload can be piped
 * straight in without a translation step. Claude Code, for instance, sends
 * `{ session_id, prompt, hook_event_name, … }` to a `UserPromptSubmit` hook.
 */
const ALIASES = {
  session_id: "sessionId",
  prompt: "input",
  hook_event_name: "phase",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let inline = {};
  if (process.stdin.isTTY !== true) {
    try {
      const raw = readFileSync(0, "utf8").trim();
      if (raw.startsWith("{")) inline = JSON.parse(raw);
    } catch {
      /* No stdin, or not JSON — flags alone are fine. */
    }
  }

  const record = { at: Date.now() };
  for (const [key, value] of Object.entries(inline)) {
    if (value === undefined || value === null || typeof value === "object") continue;
    record[ALIASES[key] ?? key] = value;
  }
  for (const [flag, field] of Object.entries(FIELDS)) {
    const value = args[flag];
    if (typeof value === "string" && value !== "") record[field] = value;
  }
  if (typeof args.at === "string" && args.at !== "") record.at = Number(args.at) || Date.now();

  // Without an agent and a session there is nothing to attribute the report to.
  if (typeof record.agent !== "string" || typeof record.sessionId !== "string") return;

  await mkdir(dirname(SPOOL), { recursive: true });
  // One `appendFile` per record: the write is a single O_APPEND, so concurrent
  // hooks interleave whole lines rather than halves of them.
  await appendFile(SPOOL, `${JSON.stringify(record)}\n`, "utf8");
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
