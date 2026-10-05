/**
 * ACP client core test.
 *
 * The agent is faked (`test/fake-acp.mjs`), so this asserts the client's own
 * behaviour — the handshake it sends, the order it delivers updates in, and what
 * it does with a request it cannot answer. Those are the parts that decide
 * whether a real agent hangs, so they are worth pinning without one.
 *
 * Nothing here touches the network or a real agent: `spawnChild` is the default
 * child_process, `command` is this machine's own node.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { connectAcp, PROTOCOL_VERSION } from "../acp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-acp.mjs");

let checks = 0;
const problems = [];
function check(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
}

const start = (options = {}) =>
  connectAcp({
    command: process.execPath,
    args: [FAKE],
    cwd: HERE,
    ...options,
  });

/* ---- the handshake -------------------------------------------------- */
{
  const acp = start();
  const handshake = await acp.initialize({ name: "selftest", version: "1.0.0" });
  check(handshake.protocolVersion === PROTOCOL_VERSION, `the client must ask for protocol v1, got ${handshake.protocolVersion}`);
  check(handshake.agentCapabilities?.loadSession === true, "the agent's capabilities must come back intact");
  console.log("  handshake: protocol v1 negotiated");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- continuing an existing session --------------------------------- */
{
  const acp = start();
  await acp.initialize();
  const loaded = await acp.loadSession("existing-session-1", "/tmp/selftest-workspace");
  check(loaded.loaded === true, "session/load must be answered");
  check(loaded.sessionId === "existing-session-1", "the agent must be told which session to load");
  check(loaded.cwd === "/tmp/selftest-workspace", "and in which directory");
  console.log("  loadSession: an existing session can be continued");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- streaming, and the order it arrives in ------------------------- */
{
  const acp = start();
  await acp.initialize();
  await acp.newSession("/tmp/selftest-workspace");

  const seen = [];
  acp.onUpdate((params) => seen.push(params.update?.content?.text ?? ""));
  const result = await acp.prompt("new-1", "hello");

  check(result.stopReason === "end_turn", `a prompt must resolve with a stop reason, got ${JSON.stringify(result)}`);
  check(seen.length === 2, `both updates must be delivered, got ${seen.length}`);
  check(seen[0] === "thinking…", `updates must arrive in order, got ${JSON.stringify(seen)}`);
  check(seen[1] === "you said: hello", "and carry what the agent said");
  console.log(`  prompt: ${seen.length} streamed updates, then the stop reason`);
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- permission: answered when there is an answerer ----------------- */
{
  const asked = [];
  const acp = start({
    askPermission: async (request) => {
      asked.push(request);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    },
  });
  await acp.initialize();
  const result = await acp.prompt("new-1", "permission");

  check(asked.length === 1, "a permission request must reach the answerer");
  check(asked[0].toolCall?.toolCallId === "call-1", "carrying the tool call it is about");
  check(Array.isArray(asked[0].options) && asked[0].options.length === 2, "and the options the agent offers");
  check(result.answer?.result?.outcome?.optionId === "allow", "the chosen option must go back to the agent");
  console.log("  permission: the answerer decides, and the answer returns");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- permission: refused when there is none ------------------------- */
{
  // The whole point: an unanswered permission prompt must never become an
  // approval. Defaulting to "allow" here would remove the only thing standing
  // between an agent and the machine.
  const acp = start();
  await acp.initialize();
  const result = await acp.prompt("new-1", "permission");
  const outcome = result.answer?.result?.outcome;
  check(outcome?.outcome === "cancelled", `without an answerer it must be cancelled, got ${JSON.stringify(outcome)}`);
  console.log("  permission: with no answerer it is cancelled, never allowed");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- a request the client cannot honour is still answered ----------- */
{
  const acp = start();
  await acp.initialize();
  const result = await acp.prompt("new-1", "unknown-request");
  // Left unanswered, the agent waits forever and the session looks hung.
  check(result.answer?.error?.code === -32601, `an unimplemented request must be answered, got ${JSON.stringify(result.answer)}`);
  check(String(result.answer?.error?.message ?? "").includes("fs/read_text_file"), "and must name what it could not do");
  console.log("  unknown request: answered with an error, so the agent does not wait");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- a request that never answers must not hang its caller ---------- */
{
  // Measured against a real server: `session/load` on an agent that wants
  // authentication returned neither a result nor an error. Without a deadline
  // the caller waits forever, and a person sees a frozen panel.
  const acp = start({ timeoutMs: 600 });
  await acp.initialize();
  let rejected = null;
  try {
    await acp.prompt("new-1", "no-answer");
  } catch (error) {
    rejected = error;
  }
  check(rejected !== null, "a request that never answers must reject");
  check(/did not answer within/.test(String(rejected?.message)), `and say why: ${rejected?.message}`);
  console.log("  deadline: an unanswered request rejects instead of hanging");
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ---- a dead agent must not hang its caller -------------------------- */
{
  const acp = start();
  await acp.initialize();
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 250));

  let rejected = null;
  try {
    await acp.prompt("new-1", "hello");
  } catch (error) {
    rejected = error;
  }
  check(rejected !== null, "a request after the agent is gone must reject, not hang");
  console.log("  shutdown: a request against a dead agent rejects");
}

console.log("");
if (problems.length > 0) {
  console.error(`acp test: ${problems.length} problem(s) out of ${checks}\n`);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  process.exit(1);
}
console.log(`acp test: all ${checks} assertions passed`);
