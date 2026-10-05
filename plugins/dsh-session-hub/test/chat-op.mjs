/**
 * The `chat` op: opening, prompting and stopping an ACP conversation.
 *
 * The ACP server is faked (`test/fake-acp.mjs`) and so is the Host's session
 * store, so the whole op runs in-process with no network and no real agent. What
 * it pins is the op's contract: where the conversation renders, which id the
 * agent knows it by, and the two cases it must refuse.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The plugin keeps its own files under this; a scratch directory keeps the test
// from reading the person's real pins and environment choice.
process.env.DSH_SESSION_HUB_HOME = await mkdtemp(join(tmpdir(), "dsh-session-hub-chatop-"));
// The one seam that makes this testable without npx: documented as a real
// feature (a locally installed server) and used here as the fake.
process.env.DSH_SESSION_HUB_ACP = JSON.stringify([process.execPath, join(HERE, "fake-acp.mjs")]);

let checks = 0;
const problems = [];
function check(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
}

/** A stand-in for DSH's session store. */
const created = [];
const fakeSessions = {
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
    created.push({ options, session });
    return session;
  },
};

const mod = await import("../index.js");
let route = null;
mod.apply({
  connection: { fetch: { register: (r) => (route = r) } },
  effect: (cb) => {
    const dispose = cb();
    return () => dispose?.();
  },
  get: (name) => (name === "sessions" ? fakeSessions : undefined),
});

const call = async (payload) =>
  (
    await route.fetch(
      new Request("http://127.0.0.1/api/session-hub", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    )
  ).json();

const list = await call({ op: "list", refresh: true });
const codex = list.sessions.find((session) => session.agent === "codex");
check(codex !== undefined, "the corpus must have a codex session to chat with");

/* ---- opening -------------------------------------------------------- */
const opened = await call({ op: "chat", action: "open", key: codex.key });
check(opened.ok === true, `opening must succeed: ${JSON.stringify(opened).slice(0, 200)}`);
check(typeof opened.sessionId === "string" && opened.sessionId !== "", "it must name the session the conversation renders in");
check(opened.acpSessionId === codex.sessionId, "continuing a row must keep the agent's own session id");
check(opened.agent === "codex", "and say which agent is answering");
check(String(opened.command).includes("acp"), "and report the command it started");

const made = created[0];
check(created.length === 1, "exactly one view session must be created");
// Without this the row in the session list is an anonymous chat.
check(made.options?.meta?.agentPreset === "codex", "the view must record which agent it came from");
check(made.options?.meta?.cwd === codex.cwd, "and which workspace it belongs to");
console.log(`  open: view session ${opened.sessionId}, agent session ${opened.acpSessionId}`);

/* ---- a turn --------------------------------------------------------- */
const sent = await call({ op: "chat", action: "prompt", key: codex.key, text: "hello there" });
check(sent.ok === true, `a prompt must be accepted: ${JSON.stringify(sent).slice(0, 200)}`);
check(sent.stopReason === "end_turn", `and report how the turn ended, got ${JSON.stringify(sent.stopReason)}`);

const view = made.session;
check(view.ofType("user/message").length === 1, "the person's words must land in the view");
check(view.ofType("user/message")[0].data.content[0].text === "hello there", "and be what they typed");
// Two chunks from the fake; one message is the buffering in view.js.
check(view.ofType("assistant/message").length === 1, "and the agent's answer must be one message");
check(view.ofType("turn/start").length === 1 && view.ofType("turn/end").length === 1, "one turn, opened and closed");
console.log(`  prompt: ${view.events.length} events in the view`);

/* ---- stopping ------------------------------------------------------- */
const stopped = await call({ op: "chat", action: "stop", key: codex.key });
check(stopped.ok === true && stopped.stopped === true, "stopping an open conversation must report it");
const again = await call({ op: "chat", action: "stop", key: codex.key });
check(again.ok === true && again.stopped === false, "and stopping it twice must be harmless");

/* ---- prompting a conversation that is closed ------------------------ */
const orphan = await call({ op: "chat", action: "prompt", key: codex.key, text: "anyone there?" });
check(orphan.ok === false, "prompting a closed conversation must fail, not silently do nothing");
console.log(`  stop: reported, idempotent, and a closed conversation refuses`);

/* ---- the menu the client renders ------------------------------------ */
// Ways are derived from declarations, so the panel never decides for itself and
// never hardcodes a list.
{
  const withServer = list.sessions.filter((session) => (session.ways ?? []).some((way) => way.id === "chat"));
  check(withServer.length > 0, "an agent with an ACP server must offer the chat way");
  for (const session of list.sessions) {
    check(Array.isArray(session.ways), "every card must carry its ways");
    check(
      session.ways.some((way) => way.id === "terminal"),
      `${session.agent}: a terminal way must exist for every agent, since it is the default plan`,
    );
    check(
      !(session.ways.some((way) => way.id === "chat") && session.agent === "dsh"),
      "dsh has no ACP server, so it must not offer a chat",
    );
  }
  const codexWays = (codex.ways ?? []).map((way) => way.id);
  check(codexWays.includes("app"), `codex declares a deep link, so its ways must include it: ${codexWays}`);
  console.log(`  ways: ${codexWays.join(" · ")}`);
}

/* ---- choosing a way, rather than falling through -------------------- */
{
  // `chat` is its own op, not an openPlan step — asking `open` for it must be
  // refused, and the refusal must list what there actually is.
  const refused = await call({ op: "open", key: codex.key, via: "chat" });
  check(refused.ok === false, "a way that is not an openPlan step must be refused");
  check(/via chat/.test(String(refused.error)), `and name it: ${refused.error}`);
  check(Array.isArray(refused.ways) && refused.ways.length > 0, "and report the ways that do exist");
  console.log(`  via: an impossible way is refused, with the real ones listed`);
}

/* ---- the two refusals ----------------------------------------------- */
const unknown = await call({ op: "chat", action: "open", key: "no-such-session" });
check(unknown.ok === false && /unknown session/.test(unknown.error), `an unknown key must be refused: ${unknown.error}`);

// `dsh` has no ACP server — that is a fact about the agent, and the message has
// to say so rather than failing somewhere further in.
const dshCard = list.sessions.find((session) => session.agent === "dsh");
if (dshCard !== undefined) {
  const noServer = await call({ op: "chat", action: "open", key: dshCard.key });
  check(noServer.ok === false, "an agent with no ACP server must be refused");
  check(/no ACP server/.test(String(noServer.error)), `and say why: ${noServer.error}`);
  console.log(`  refusal: agent without a server → ${noServer.error}`);
}
check(created.length === 1, "a refused open must not create a session");

console.log("");
if (problems.length > 0) {
  console.error(`chat op test: ${problems.length} problem(s) out of ${checks}\n`);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  process.exit(1);
}
console.log(`chat op test: all ${checks} assertions passed`);
