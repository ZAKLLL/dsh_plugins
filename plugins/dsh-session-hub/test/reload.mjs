/**
 * Reload test.
 *
 * `ctx.connection.fetch.register` is owned by the connection service's own
 * context, so the route outlives this plugin's fiber and keeps the closure it
 * was created with. If the mutable dispatch target lived in module scope, a
 * reload would build a fresh object the surviving route never reads — the first
 * generation would keep serving, and every operation added later would answer
 * `unknown op` while the client had already moved on.
 *
 * This runs in its own process because it needs a `globalThis` where nothing
 * has registered the route yet.
 *
 *   node test/reload.mjs
 *
 * Two cache-busted imports are two module instances sharing one `globalThis`,
 * which is exactly what a reload produces in the running process.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


/**
 * Keep this plugin's own files out of the real ones.
 *
 * The environment file remembers which machine the panel is pointed at, and this
 * test reads the real session stores on purpose. Pointing both at the same place
 * made the suite depend on the person's last switch: the day a remote host
 * became a saved environment, `list` began failing on a dead tunnel instead of on
 * what was being tested. Only pins, the hook spool and the chosen environment
 * move — `sessions/` stays real.
 */
process.env.DSH_SESSION_HUB_HOME = await mkdtemp(join(tmpdir(), "dsh-session-hub-state-"));

const generationOne = await import("../index.js?generation=1");
const generationTwo = await import("../index.js?generation=2");
assert.notEqual(generationOne, generationTwo, "cache-busted imports must be distinct module instances");

async function call(route, payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await (await route.fetch(request)).json();
}

// ---- generation one registers the route -----------------------------
let routeOne = null;
generationOne.apply({
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  connection: { fetch: { register: (registered) => { routeOne = registered; } } },
  get: () => undefined,
});
assert.ok(routeOne !== null, "the first generation must register the route");
assert.equal(routeOne.path, "/api/session-hub");

const list = await call(routeOne, { op: "list" });
assert.equal(list.ok, true, `list failed: ${list.error}`);
const card = list.sessions.find((session) => session.agent === "dsh");
assert.ok(card, "a DSH session is needed to make the swapped context observable");
console.log(`generation one registered the route; ${list.sessions.length} sessions visible`);

// ---- generation two cannot register, so it must take over in place ---
let secondAttempted = false;
generationTwo.apply({
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  connection: {
    fetch: {
      register: () => {
        secondAttempted = true;
        throw new Error('connection: exact Fetch route "/api/session-hub" is already registered');
      },
    },
  },
  // A different registry, so which context is answering is directly observable.
  get: (name) =>
    name === "agents"
      ? { get: (id) => (id === card.sessionId ? { status: "running" } : undefined) }
      : undefined,
});
assert.equal(secondAttempted, true, "the second generation must attempt the route and be refused");

// ---- the surviving route must now dispatch to generation two --------
const status = await call(routeOne, { op: "status" });
assert.equal(status.ok, true, `status failed: ${status.error}`);
assert.equal(
  status.running[card.key],
  true,
  "generation one's route must dispatch to the newest generation's handler",
);
console.log("generation one's surviving route answers through generation two's context");

// Every operation the newest generation knows must be reachable through the
// route the first generation created — this is the symptom that was reported.
for (const op of ["pin", "preview", "status", "delete-many"]) {
  const result = await call(routeOne, { op });
  assert.doesNotMatch(
    String(result.error ?? ""),
    /unknown op/,
    `the newest generation's "${op}" must be reachable through the surviving route`,
  );
}
console.log("pin, preview, status and delete-many are all reachable through the surviving route");

console.log("\nreload test: all assertions passed");
