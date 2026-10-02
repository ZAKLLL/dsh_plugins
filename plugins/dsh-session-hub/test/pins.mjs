/**
 * Pin-state test.
 *
 * Pins live in the plugin's own file (`$DSH_HOME/session-hub/state.json`), so
 * this test backs that file up, works against one throwaway fixture, and puts
 * the original back in the `finally` — a real pin set is never disturbed.
 *
 *   node test/pins.mjs
 *
 * Verified here:
 *   - a session pin and a project pin round-trip through the state file;
 *   - the pin sets survive a re-read by the Host;
 *   - pinning a project leaves session pins untouched, and the reverse;
 *   - deleting a pinned session drops its pin, so the file cannot rot;
 *   - malformed pin requests are refused.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const mod = await import("../index.js");

const STAMP = `pinselftest-${process.pid}-${Date.now()}`;
const SESSION_ID = `session-${STAMP}`;
const WORKSPACE = `/tmp/dsh-session-hub-${STAMP}`;

let route = null;
mod.apply({
  connection: { fetch: { register: (registered) => { route = registered; } } },
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  get: () => undefined,
});

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await (await route.fetch(request)).json();
}

const HOME_DIR = process.env.DSH_HOME || join(homedir(), ".dsh");
const DSH_ROOT = join(HOME_DIR, "sessions");
const PIN_DIR = join(HOME_DIR, "session-hub");
const PIN_FILE = join(PIN_DIR, "state.json");
const SESSION_DIR = join(DSH_ROOT, `-dsh-session-hub-${STAMP}`, SESSION_ID);
const SESSION_FILE = join(SESSION_DIR, "session.v4.jsonl.zstd");

let pinBackup = null;
let pinFileExisted = true;

/** A minimal but valid DSH session: one zstd frame over JSONL. */
function fixture() {
  const header = {
    type: "session",
    version: 4,
    id: SESSION_ID,
    createdAt: Date.now(),
    cwd: WORKSPACE,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  const user = { type: "user/message", seq: 2, time: Date.now(), data: { role: "user", content: [{ type: "text", text: "pin state fixture" }] } };
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(user)}\n`, "utf8"));
}

async function cleanup() {
  await rm(join(DSH_ROOT, `-dsh-session-hub-${STAMP}`), { recursive: true, force: true });
  try {
    if (pinFileExisted && pinBackup !== null) await writeFile(PIN_FILE, pinBackup, "utf8");
    else {
      await rm(PIN_FILE, { force: true });
      await rmdir(PIN_DIR).catch(() => {});
    }
  } catch {
    /* Nothing better to do at this point; the test already reported. */
  }
}

try {
  await mkdir(SESSION_DIR, { recursive: true });
  await writeFile(SESSION_FILE, fixture());
  try {
    pinBackup = await readFile(PIN_FILE, "utf8");
  } catch {
    pinFileExisted = false;
  }

  const list = await call({ op: "list", refresh: true });
  const card = list.sessions.find((session) => session.sessionId === SESSION_ID);
  assert.ok(card, "the fixture session must be listed");
  assert.equal(card.cwd, WORKSPACE);
  assert.ok(Array.isArray(list.pins?.sessions), "list must report the session pin set");
  assert.ok(Array.isArray(list.pins?.projects), "list must report the project pin set");

  // ---- pin both a session and a project -----------------------------
  const pinnedSession = await call({ op: "pin", kind: "session", id: card.key, pinned: true });
  assert.equal(pinnedSession.ok, true, `pin failed: ${pinnedSession.error}`);
  assert.ok(pinnedSession.sessions.includes(card.key), "the session pin must be recorded");

  const pinnedProject = await call({ op: "pin", kind: "project", id: WORKSPACE, pinned: true });
  assert.equal(pinnedProject.ok, true, `project pin failed: ${pinnedProject.error}`);
  assert.ok(pinnedProject.projects.includes(WORKSPACE), "the project pin must be recorded");
  assert.ok(pinnedProject.sessions.includes(card.key), "pinning a project must not disturb session pins");
  console.log("pin: session + project recorded");

  // ---- they survive a re-read, and reach the file -------------------
  const reread = await call({ op: "list" });
  assert.ok(reread.pins.sessions.includes(card.key), "the session pin must survive a re-read");
  assert.ok(reread.pins.projects.includes(WORKSPACE), "the project pin must survive a re-read");

  const onDisk = JSON.parse(await readFile(PIN_FILE, "utf8"));
  assert.ok(onDisk.sessions.includes(card.key), "the session pin must be written to disk");
  assert.ok(onDisk.projects.includes(WORKSPACE), "the project pin must be written to disk");
  assert.equal(onDisk.version, 1, "the state file must carry its version");
  console.log("pin: persisted and readable from the state file");

  // ---- unpinning one kind leaves the other alone --------------------
  const unpinnedProject = await call({ op: "pin", kind: "project", id: WORKSPACE, pinned: false });
  assert.equal(unpinnedProject.projects.includes(WORKSPACE), false, "the project pin must be gone");
  assert.ok(unpinnedProject.sessions.includes(card.key), "unpinning a project must not touch session pins");
  console.log("pin: kinds are independent");

  // ---- deleting a pinned session drops its pin ----------------------
  const deleted = await call({ op: "delete", key: card.key });
  assert.equal(deleted.ok, true, `delete failed: ${deleted.error}`);
  await assert.rejects(stat(SESSION_FILE), "the fixture must be gone");
  const afterDelete = await call({ op: "list" });
  assert.equal(afterDelete.pins.sessions.includes(card.key), false, "a deleted session must lose its pin");
  assert.equal(
    JSON.parse(await readFile(PIN_FILE, "utf8")).sessions.includes(card.key),
    false,
    "the dropped pin must reach disk",
  );
  console.log("pin: a deleted session loses its pin");

  // ---- malformed requests are refused -------------------------------
  assert.equal((await call({ op: "pin", kind: "nope", id: card.key, pinned: true })).ok, false);
  assert.equal((await call({ op: "pin", kind: "session", id: "", pinned: true })).ok, false);
  assert.equal((await call({ op: "pin", kind: "session", pinned: true })).ok, false);
  console.log("pin: malformed requests refused");

  console.log("\npin test: all assertions passed");
} finally {
  await cleanup();
}
