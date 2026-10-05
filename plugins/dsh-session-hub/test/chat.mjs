/**
 * Chat glue test: a real protocol conversation driving a fake DSH session.
 *
 * The agent is the fake ACP server that `test/acp.mjs` uses, and the session is a
 * recorder with the same `append` the real `Session` has — so the whole path from
 * "open this conversation" to "a message lands in the view" runs without DSH and
 * without a network.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { connectAcp } from "../acp.js";
import { openAcpChat } from "../chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-acp.mjs");

let checks = 0;
const problems = [];
function check(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
}

/** A stand-in for DSH's session store. */
function fakeSessions() {
  const created = [];
  return {
    created,
    create(id, options) {
      const events = [];
      const session = {
        id: id ?? `session-${created.length + 1}`,
        header: { id: id ?? `session-${created.length + 1}`, ...(options?.meta ?? {}) },
        events,
        append(type, data, opts) {
          events.push({ type, data, opts });
          return { type, data };
        },
        ofType(type) {
          return events.filter((event) => event.type === type);
        },
      };
      created.push({ id, options, session });
      return session;
    },
  };
}

const agentFor = (sessionId, options = {}) =>
  connectAcp({
    command: process.execPath,
    args: [FAKE],
    cwd: HERE,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...options,
  });

/* ---- continuing an existing conversation ---------------------------- */
{
  const sessions = fakeSessions();
  const acp = agentFor();
  const chat = await openAcpChat({
    sessions,
    acp,
    cwd: "/tmp/selftest-workspace",
    sessionId: "existing-session-1",
    provider: "codex-acp",
    model: "gpt-6-luna",
    preset: "codex",
  });

  const made = sessions.created[0];
  check(sessions.created.length === 1, "opening a chat must create exactly one session");
  check(made.options?.meta?.cwd === "/tmp/selftest-workspace", "the session must record its workspace");
  // Without this a row shows an anonymous chat instead of saying which agent it is.
  check(made.options?.meta?.agentPreset === "codex", "and which agent it came from");
  check(chat.acpSessionId === "existing-session-1", "a resumed conversation keeps the native id");

  const result = await chat.prompt("hello");
  check(result.stopReason === "end_turn", `a turn must finish, got ${JSON.stringify(result)}`);

  const session = made.session;
  const users = session.ofType("user/message");
  check(users.length === 1, "the person's words must appear in the view");
  check(users[0].data.content?.[0]?.text === "hello", "and be what they actually said");

  // The fake streams two chunks; one message is the whole point of the buffering
  // in view.js.
  const answers = session.ofType("assistant/message");
  check(answers.length === 1, `streamed chunks must become one message, got ${answers.length}`);
  // The fake streams two chunks; the view must carry BOTH, joined — not just the
  // last one, which is the failure mode of appending per chunk.
  check(
    answers[0].data.message.content?.[0]?.text === "thinking…you said: hello",
    `the answer must be the joined chunks, got ${JSON.stringify(answers[0].data.message.content?.[0]?.text)}`,
  );
  check(answers[0].data.message.source?.provider === "codex-acp", "attributed to the agent that answered");

  check(session.ofType("turn/start").length === 1, "one turn must be opened");
  check(session.ofType("turn/end").length === 1, "and closed");
  console.log(`  resume: ${session.events.length} events in the view, one turn asked and answered`);

  chat.stop();
  chat.stop(); // idempotent: a second stop must not throw
  console.log("  stop: idempotent");
}

/* ---- starting a fresh conversation ---------------------------------- */
{
  const sessions = fakeSessions();
  const acp = agentFor();
  const chat = await openAcpChat({ sessions, acp, cwd: "/tmp/selftest-workspace", provider: "pi-acp" });

  check(chat.acpSessionId !== null, "a new conversation must learn its id from the agent");
  check(sessions.created[0].options?.meta?.agentPreset === undefined, "no preset when none was given");
  await chat.prompt("hello");
  check(sessions.created[0].session.ofType("assistant/message").length === 1, "and it must answer too");
  console.log(`  new: agent minted ${chat.acpSessionId}`);
  chat.stop();
}

/* ---- a conversation that never opens -------------------------------- */
{
  const sessions = fakeSessions();
  const errors = [];
  // Nonsense executable: the agent is gone before the handshake.
  const acp = connectAcp({ command: "/nonexistent/acp-server", args: [], cwd: HERE, timeoutMs: 800 });
  let threw = null;
  try {
    await openAcpChat({
      sessions,
      acp,
      cwd: "/tmp/selftest-workspace",
      sessionId: "existing-1",
      onError: (error) => errors.push(error),
    });
  } catch (error) {
    threw = error;
  }
  check(threw !== null, "an agent that cannot start must fail the open, not pretend to succeed");
  check(errors.length === 1, "and the caller's error hook must hear about it");
  console.log("  failure: opening reports, and does not leave a half-built chat");
}

console.log("");
if (problems.length > 0) {
  console.error(`chat test: ${problems.length} problem(s) out of ${checks}\n`);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  process.exit(1);
}
console.log(`chat test: all ${checks} assertions passed`);
