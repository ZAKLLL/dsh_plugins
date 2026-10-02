/**
 * Host-half smoke test.
 *
 * Drives `index.js` exactly the way the Cordis loader does — call `apply(ctx)`,
 * capture the Fetch route it registers, then send real `Request`s through it —
 * and asserts the inventory, the transcripts and the failure paths.
 *
 *   node test/smoke.mjs
 *
 * It reads the real session stores on this machine, so it is a live check
 * rather than a fixture test. Exit code 0 means every assertion held.
 */

import assert from "node:assert/strict";

const mod = await import("../index.js");

let route = null;
mod.apply({
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  connection: {
    fetch: {
      register: (registered) => {
        route = registered;
      },
    },
  },
});

assert.ok(route !== null, "apply() must register a Fetch route");
assert.equal(route.path, "/api/session-hub");
assert.deepEqual(route.methods, ["POST"]);

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

const started = Date.now();
const list = await call({ op: "list", refresh: true });
const elapsed = Date.now() - started;

assert.equal(list.status, 200);
assert.equal(list.body.ok, true, `list failed: ${JSON.stringify(list.body).slice(0, 300)}`);
assert.ok(Array.isArray(list.body.sessions), "sessions must be an array");
assert.ok(list.body.sessions.length > 0, "expected at least one session on this machine");

console.log(`list: ${list.body.sessions.length} sessions in ${elapsed}ms`);
console.log(`  cmux CLI: ${list.body.cmux === true ? "found" : "not found"}   running: ${list.body.runningCount}`);
for (const source of list.body.sources) {
  console.log(`  ${source.id.padEnd(7)} ${source.parsed}/${source.total}  skipped=${source.skipped}  ${source.root}`);
  assert.equal(
    source.parsed + source.skipped,
    source.total,
    `${source.id} must account for every value it found`,
  );
}

// A workspace named after a bare UUID is a tool's disposable scratch directory,
// not a project: leaving those in turned one tool's runs into 17 fake projects.
// The rule is asserted here so a future change cannot quietly let them back.
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const card of list.body.sessions) {
  const name = typeof card.cwd === "string" ? card.cwd.replace(/\/+$/, "").split("/").pop() : "";
  assert.ok(
    !UUID_ONLY.test(name),
    `a scratch workspace must not be listed as a project: ${card.cwd}`,
  );
}

// Every card must carry the fields the panel renders.
for (const card of list.body.sessions) {
  assert.equal(typeof card.key, "string");
  assert.ok(
    ["dsh", "claude", "codex", "gemini", "pi", "opencode"].includes(card.agent),
    `unknown agent ${card.agent}`,
  );
  assert.equal(typeof card.title, "string");
  assert.ok(card.title.length > 0, `empty title for ${card.key}`);
  assert.equal(typeof card.file, "string");
  assert.equal(typeof card.partial, "boolean");
  assert.equal(typeof card.messages, "number");
  assert.equal(typeof card.running, "boolean", `running must be boolean for ${card.key}`);
  assert.equal(typeof card.subagent, "boolean", `subagent must be boolean for ${card.key}`);
  assert.ok(card.parentKey === null || typeof card.parentKey === "string", `parentKey must be null or a key for ${card.key}`);
  assert.equal(typeof card.depth, "number");
  assert.ok(card.live === null || card.live === undefined || typeof card.live === "object");
}

// A nested session must point at a session that really is in the corpus, and a
// subagent must never be left dangling — the tree would silently lose it.
const cardKeys = new Set(list.body.sessions.map((session) => session.key));
for (const card of list.body.sessions) {
  if (card.parentKey !== null) {
    assert.ok(cardKeys.has(card.parentKey), `dangling parentKey on ${card.key} -> ${card.parentKey}`);
    assert.notEqual(card.parentKey, card.key, "a session must not parent itself");
  }
  if (card.subagent) assert.notEqual(card.parentKey, null, `subagent ${card.key} has no resolvable parent`);
}
const nested = list.body.sessions.filter((session) => session.parentKey !== null);
console.log(`  nesting: ${nested.length} sessions linked to a parent`);

// Live state: the lightweight poll must cover every card the list returned.
const status = await call({ op: "status" });
assert.equal(status.body.ok, true, "status failed");
assert.equal(typeof status.body.running, "object");
for (const card of list.body.sessions) {
  assert.equal(typeof status.body.running[card.key], "boolean", `status missing ${card.key}`);
}
assert.equal(
  Object.values(status.body.running).filter(Boolean).length,
  status.body.runningCount,
  "runningCount must agree with the running map",
);
console.log(`  status: ${status.body.runningCount} running of ${Object.keys(status.body.running).length}`);

// A live session must never be claimed without evidence: DSH reads the agent
// registry, everything else needs cmux to report a live pid.
for (const card of list.body.sessions) {
  if (card.running !== true) continue;
  assert.ok(card.live.source !== null, `running ${card.key} must name its evidence source`);
}

// Newest first.
for (let index = 1; index < list.body.sessions.length; index += 1) {
  const previous = list.body.sessions[index - 1].updatedAt ?? 0;
  const current = list.body.sessions[index].updatedAt ?? 0;
  assert.ok(previous >= current, "sessions must be sorted newest first");
}

// One transcript per agent that has sessions, and it must reach the whole file.
const agents = [...new Set(list.body.sessions.map((session) => session.agent))];
for (const agent of agents) {
  const card = list.body.sessions.find((session) => session.agent === agent);
  const transcript = await call({ op: "transcript", key: card.key });
  assert.equal(transcript.body.ok, true, `transcript failed for ${agent}`);

  const markdown = transcript.body.markdown;
  assert.ok(markdown.startsWith("# Session: "), "transcript must open with a title");
  assert.ok(markdown.includes(`- **agent**: ${card.agentLabel}`), "transcript must name its agent");
  assert.ok(markdown.includes(`- **raw store**: \`${card.file}\``), "transcript must cite its raw store");

  // The reader splits that same body back into turns, and it must split on
  // exactly the headings the adapters emit — people write markdown in their
  // prompts, so a `## 场景路由` heading is part of a message, not a boundary.
  const turns = await call({ op: "messages", key: card.key });
  assert.equal(turns.body.ok, true, `messages failed for ${agent}`);
  const usersAsTurns = turns.body.messages.filter((message) => message.role === "user").length;
  assert.equal(
    usersAsTurns,
    (markdown.match(/^## User$/gm) ?? []).length,
    `${agent}: every "## User" heading must become exactly one turn`,
  );
  assert.equal(
    turns.body.messages.filter((message) => message.role === "assistant").length,
    (markdown.match(/^## Assistant$/gm) ?? []).length,
    `${agent}: every "## Assistant" heading must become exactly one turn`,
  );
  assert.ok(turns.body.total >= usersAsTurns, "the total must count every turn");

  const users = (markdown.match(/^## User$/gm) ?? []).length;
  const assistants = (markdown.match(/^## Assistant$/gm) ?? []).length;
  assert.ok(users + assistants > 0, `transcript for ${agent} rendered no messages`);
  console.log(`  ${agent.padEnd(7)} partial=${String(card.partial).padEnd(5)} ${String(markdown.length).padStart(8)} chars  user=${users} assistant=${assistants}`);
}

// The prefix read must still yield a usable card for a file it did not finish.
const truncated = list.body.sessions.find((session) => session.partial === true);
if (truncated !== undefined) {
  assert.ok(truncated.title.length > 0, "a partially read session still needs a title");
  assert.ok(truncated.cwd !== null || truncated.project === null, "a partially read session keeps whatever cwd it saw");
}

// `continue` must land the transcript inside the asking session's workspace.
const dshSession = list.body.sessions.find((session) => session.agent === "dsh" && session.cwd !== null);
if (dshSession !== undefined) {
  const result = await call({
    op: "continue",
    key: dshSession.key,
    currentSessionId: dshSession.sessionId,
  });
  assert.equal(result.body.ok, true, "continue failed");
  assert.equal(result.body.inWorkspace, true, "continue must resolve the live workspace");
  assert.ok(result.body.path.startsWith(dshSession.cwd), `transcript must land under ${dshSession.cwd}`);
  assert.ok(result.body.prompt.includes(result.body.relative), "prompt must name the attached file");
  console.log(`  continue -> ${result.body.relative}`);
}

// Failure paths answer with a structured error, never a throw.
const unknownKey = await call({ op: "transcript", key: "nope:missing" });
assert.equal(unknownKey.status, 200);
assert.equal(unknownKey.body.ok, false);

const unknownOp = await call({ op: "bogus" });
assert.equal(unknownOp.body.ok, false);
assert.match(unknownOp.body.error, /unknown op/);

// A second apply() must not throw on the already-registered route. (The full
// two-module-instance reload scenario lives in `reload.mjs`, which needs a
// process where nothing has registered yet.)
mod.apply({
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  connection: {
    fetch: {
      register: () => {
        throw new Error('connection: exact Fetch route "/api/session-hub" is already registered');
      },
    },
  },
});

console.log("\nsmoke: all assertions passed");
