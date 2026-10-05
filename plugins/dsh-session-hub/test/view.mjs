/**
 * View bridge test.
 *
 * The session is a recorder with the same `append` the real `Session` has, so
 * this runs without DSH. What it pins is the part that can be silently wrong:
 * the field shapes DSH requires, and `surfaceOp` — without which an event exists
 * in the log and never appears in the conversation.
 */

import { createAcpView } from "../view.js";

let checks = 0;
const problems = [];
function check(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
}

function recorder() {
  const events = [];
  return {
    events,
    append(type, data, opts) {
      events.push({ type, data, opts });
      return { type, data };
    },
    /** Surface events are the ones a person is supposed to see. */
    surface() {
      return events.filter((event) => event.opts !== undefined);
    },
    types() {
      return events.map((event) => event.type);
    },
    ofType(type) {
      return events.filter((event) => event.type === type);
    },
  };
}

const SURFACE = new Set(["user/message", "assistant/message", "tool/result"]);

/* ---- a prompt turn -------------------------------------------------- */
{
  const session = recorder();
  const view = createAcpView({ session, provider: "codex-acp", model: "gpt-6-luna" });

  view.userTurn("修一下这个");
  view.update({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先看" } } });
  view.update({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "一下代码。" } } });
  view.endTurn("end_turn");

  check(session.types().includes("turn/start"), "a turn must be opened");
  check(session.types().includes("step/start"), "and a step");
  check(session.types().includes("turn/end"), "and closed");
  const end = session.ofType("turn/end")[0];
  check(end.data.reason?.kind === "completed", `a normal end must be completed, got ${JSON.stringify(end.data.reason)}`);

  const users = session.ofType("user/message");
  check(users.length === 1, "the person's own turn must appear once");
  check(users[0].data.content?.[0]?.text === "修一下这个", "and carry what they said");
  check(users[0].data.source?.kind === "user", "with the user source");

  // The whole point of buffering: two chunks, ONE message. One message per chunk
  // would fill the conversation with fragments.
  const assistants = session.ofType("assistant/message");
  check(assistants.length === 1, `two chunks must become one message, got ${assistants.length}`);
  check(assistants[0].data.message.content?.[0]?.text === "先看一下代码。", "and the text must be whole");
  check(assistants[0].data.message.source?.provider === "codex-acp", "the provider must be recorded");
  check(assistants[0].data.message.source?.model === "gpt-6-luna", "and the model");
  check(Array.isArray(assistants[0].data.stream) && assistants[0].data.stream.length >= 3, "the stream must be recorded, so the chat can replay how it arrived");
  console.log(`  turn: ${session.events.length} events, 2 chunks → 1 message`);
}

/* ---- every message is shaped the way DSH requires ------------------- */
{
  const session = recorder();
  const view = createAcpView({ session });
  view.userTurn("hi");
  view.update({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } });
  view.endTurn("end_turn");

  // The two carry their message differently, and that is DSH's shape, not ours:
  // `user/message` IS the message, while `assistant/message` wraps it beside the
  // recorded stream.
  const carried = [
    { type: "user/message", message: session.ofType("user/message")[0].data },
    { type: "assistant/message", message: session.ofType("assistant/message")[0].data.message },
  ];
  for (const { type, message } of carried) {
    check(typeof message?.id === "string" && message.id !== "", `${type} must carry a MessageId`);
    check(Array.isArray(message?.content) && message.content.length > 0, `${type} must carry content blocks`);
    check(message?.source !== undefined && message.source !== null, `${type} must carry a source`);
    check(message?.role !== undefined, `${type} must carry a role`);
  }

  // Without this the event is in the log and invisible in the conversation.
  const surface = session.surface();
  check(surface.length > 0, "surface events must be marked");
  for (const event of surface) {
    check(SURFACE.has(event.type), `only messages are surface events here, got ${event.type}`);
    check(event.opts.surfaceOp === "append", `${event.type} must append to the conversation surface, got ${JSON.stringify(event.opts)}`);
  }
  console.log(`  shape: ${surface.length} surface events, all append`);
}

/* ---- tool calls ----------------------------------------------------- */
{
  const session = recorder();
  const view = createAcpView({ session });
  view.update({
    update: { sessionUpdate: "tool_call", toolCallId: "call-7", title: "run tests", status: "in_progress", rawInput: { cmd: "pnpm test" } },
  });
  view.update({
    update: { sessionUpdate: "tool_call_update", toolCallId: "call-7", status: "completed", content: { type: "text", text: "12 passed" } },
  });

  const calls = session.ofType("tool/call");
  check(calls.length === 1, "a tool call must be recorded");
  check(calls[0].data.callId === "call-7", "with the id the agent uses");
  check(calls[0].data.name === "run tests", "and a name a person can read");
  check(String(calls[0].data.arguments).includes("pnpm test"), "and its arguments");

  const results = session.ofType("tool/result");
  check(results.length === 1, "its result must be recorded");
  check(results[0].data.message.toolCallId === "call-7", "against the same call id");
  check(results[0].data.message.source?.kind === "tool", "with the tool source");
  check(results[0].data.message.content?.[0]?.text === "12 passed", "and the output");
  check(results[0].data.error === undefined, "a successful tool must not carry an error");
  console.log("  tool: one call, one result, joined by call id");
}

/* ---- a failed tool says so ------------------------------------------ */
{
  const session = recorder();
  const view = createAcpView({ session });
  view.update({ update: { sessionUpdate: "tool_call", toolCallId: "call-9", title: "build", status: "in_progress" } });
  view.update({ update: { sessionUpdate: "tool_call_update", toolCallId: "call-9", status: "failed", content: { type: "text", text: "boom" } } });
  const result = session.ofType("tool/result")[0];
  check(result.data.message.isError === true || result.data.error !== undefined, "a failed tool must be marked as failed");
  console.log("  tool: a failure is marked, not shown as success");
}

/* ---- cancellation --------------------------------------------------- */
{
  const session = recorder();
  const view = createAcpView({ session });
  view.userTurn("stop");
  view.update({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } });
  view.endTurn("cancelled");
  const end = session.ofType("turn/end")[0];
  check(end.data.reason?.kind === "interrupted", `a cancelled turn must be interrupted, got ${JSON.stringify(end.data.reason)}`);
  // The half answer must still be committed — dropping it would lose what the
  // agent had already said.
  check(session.ofType("assistant/message").length === 1, "a cancelled turn must keep what was already streamed");
  console.log("  cancel: interrupted, and the partial answer is kept");
}

/* ---- the protocol will grow ----------------------------------------- */
{
  const session = recorder();
  const view = createAcpView({ session });
  let threw = null;
  try {
    view.update({ update: { sessionUpdate: "some_future_update", whatever: true } });
    view.update({ update: {} });
    view.update({});
  } catch (error) {
    threw = error;
  }
  check(threw === null, `an unknown update kind must be ignored, not thrown: ${threw?.message}`);
  check(session.events.length === 0, "and must not invent events");
  console.log("  forward compatible: unknown updates are ignored");
}

console.log("");
if (problems.length > 0) {
  console.error(`view test: ${problems.length} problem(s) out of ${checks}\n`);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  process.exit(1);
}
console.log(`view test: all ${checks} assertions passed`);
