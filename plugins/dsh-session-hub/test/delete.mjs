/**
 * Delete-path test.
 *
 * The delete operation is irreversible and reaches outside the workspace, so it
 * is exercised against fixtures this test creates itself, inside the real agent
 * stores, under uniquely named paths. Everything it makes is removed in the
 * `finally`, and the Codex index is restored byte-for-byte from a backup.
 *
 *   node test/delete.mjs
 *
 * Verified here:
 *   - a listed session is really removed from its agent's store;
 *   - Codex's `session_index.jsonl` entry goes with it;
 *   - a target outside the agent's own store root is refused;
 *   - a running session is refused without `force`, and removed with it.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const mod = await import("../index.js");

const STAMP = `selftest-${process.pid}-${Date.now()}`;
const RUNNING_ID = `session-${STAMP}-running`;

/** The fake agent registry: one DSH fixture reports as live, everything else does not. */
const registry = { get: (id) => (id === RUNNING_ID ? { status: "running" } : undefined) };

let route = null;
mod.apply({
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  connection: { fetch: { register: (registered) => { route = registered; } } },
  get: (name) => (name === "agents" ? registry : undefined),
});

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await route.fetch(request);
  return await response.json();
}

const DSH_ROOT = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
const CLAUDE_ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex", "sessions");
const CODEX_INDEX = join(homedir(), ".codex", "session_index.jsonl");

const claudeDir = join(CLAUDE_ROOT, `-dsh-session-hub-${STAMP}`);
const claudeFile = join(claudeDir, `${STAMP}.jsonl`);
const codexDir = join(CODEX_ROOT, "1970", "01", "01");
const codexFile = join(codexDir, `rollout-${STAMP}.jsonl`);
const dshDir = join(DSH_ROOT, `-dsh-session-hub-${STAMP}`, RUNNING_ID);
const dshFile = join(dshDir, "session.v4.jsonl.zstd");

let indexBackup = null;
let indexExisted = true;

/** One zstd frame is enough — the reader walks concatenated frames, not requires them. */
function dshFixtureFor(id) {
  const header = {
    type: "session",
    version: 4,
    id,
    createdAt: Date.now(),
    cwd: "/tmp",
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  const user = { type: "user/message", seq: 2, time: Date.now(), data: { role: "user", content: [{ type: "text", text: "delete guard fixture" }] } };
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(user)}\n`, "utf8"));
}

async function cleanup() {
  await rm(claudeDir, { recursive: true, force: true });
  await rm(codexFile, { force: true });
  await rm(join(DSH_ROOT, `-dsh-session-hub-${STAMP}`), { recursive: true, force: true });
  await rm(join(CLAUDE_ROOT, `-dsh-session-hub-bulk-${STAMP}`), { recursive: true, force: true });
  await rm(join(DSH_ROOT, `-dsh-session-hub-bulk-${STAMP}`), { recursive: true, force: true });
  try {
    if (indexExisted && indexBackup !== null) await writeFile(CODEX_INDEX, indexBackup, "utf8");
    else if (!indexExisted) await rm(CODEX_INDEX, { force: true });
  } catch {
    /* Nothing better to do at this point; the test already reported. */
  }
}

try {
  // ---- fixtures -------------------------------------------------------
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    claudeFile,
    [
      JSON.stringify({ type: "user", sessionId: STAMP, cwd: claudeDir, timestamp: new Date().toISOString(), message: { role: "user", content: "delete path self test" } }),
      JSON.stringify({ type: "ai-title", sessionId: STAMP, aiTitle: "delete self test" }),
    ].join("\n") + "\n",
    "utf8",
  );

  await mkdir(codexDir, { recursive: true });
  await writeFile(
    codexFile,
    [
      JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { session_id: STAMP, cwd: codexDir, timestamp: new Date().toISOString() } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex delete self test" }] } }),
    ].join("\n") + "\n",
    "utf8",
  );
  try {
    indexBackup = await readFile(CODEX_INDEX, "utf8");
  } catch {
    indexExisted = false;
  }
  await writeFile(
    CODEX_INDEX,
    `${indexBackup ?? ""}${JSON.stringify({ id: STAMP, thread_name: "selftest thread name", updated_at: new Date().toISOString() })}\n`,
    "utf8",
  );

  await mkdir(dshDir, { recursive: true });
  await writeFile(dshFile, dshFixtureFor(RUNNING_ID));

  // ---- the fixtures must be listed --------------------------------
  const list = await call({ op: "list", refresh: true });
  assert.equal(list.ok, true);
  const claudeCard = list.sessions.find((s) => s.agent === "claude" && s.sessionId === STAMP);
  const codexCard = list.sessions.find((s) => s.agent === "codex" && s.sessionId === STAMP);
  const dshCard = list.sessions.find((s) => s.agent === "dsh" && s.sessionId === RUNNING_ID);
  assert.ok(claudeCard, "claude fixture must be listed");
  assert.ok(codexCard, "codex fixture must be listed");
  assert.ok(dshCard, "dsh fixture must be listed");
  assert.equal(codexCard.title, "selftest thread name", "codex thread_name must become the title");
  assert.equal(claudeCard.title, "delete self test", "claude ai-title must become the title");
  assert.equal(dshCard.running, true, "the fake registry must mark the dsh fixture live");
  console.log(`listed fixtures: claude, codex, dsh (running=${dshCard.running})`);

  // ---- guard: unknown key ------------------------------------------
  const unknown = await call({ op: "delete", key: "claude:/definitely/not/here.jsonl" });
  assert.equal(unknown.ok, false);
  console.log(`guard unknown-key: refused (${unknown.error})`);

  // ---- guard: outside the agent's own store root --------------------
  const outside = await call({ op: "delete", key: `claude:${join(homedir(), ".claude", "history.jsonl")}` });
  assert.equal(outside.ok, false, "a path outside the store root must be refused");
  assert.match(outside.error, /outside/, `expected an outside-root refusal, got: ${outside.error}`);
  assert.ok((await stat(join(homedir(), ".claude", "history.jsonl"))).isFile(), "the refused file must still exist");
  console.log(`guard outside-root: refused (${outside.error})`);

  // ---- guard: a running session needs `force` ------------------------
  const runningRefused = await call({ op: "delete", key: dshCard.key });
  assert.equal(runningRefused.ok, false, "a running session must be refused without force");
  assert.equal(runningRefused.code, "running");
  assert.ok((await stat(dshFile)).isFile(), "the refused session must still exist");
  console.log(`guard running: refused (${runningRefused.error})`);

  const runningForced = await call({ op: "delete", key: dshCard.key, force: true });
  assert.equal(runningForced.ok, true, `forced delete failed: ${runningForced.error}`);
  await assert.rejects(stat(dshFile), "the forced delete must remove the store");
  console.log("guard running: removed with force");

  // ---- the ordinary deletions ---------------------------------------
  const delClaude = await call({ op: "delete", key: claudeCard.key });
  assert.equal(delClaude.ok, true, `claude delete failed: ${delClaude.error}`);
  await assert.rejects(stat(claudeFile), "the claude session file must be gone");
  console.log("deleted claude session");

  const delCodex = await call({ op: "delete", key: codexCard.key });
  assert.equal(delCodex.ok, true, `codex delete failed: ${delCodex.error}`);
  assert.equal(delCodex.indexEntryRemoved, true, "the codex index entry must be removed");
  await assert.rejects(stat(codexFile), "the codex rollout must be gone");
  assert.ok(!(await readFile(CODEX_INDEX, "utf8")).includes(STAMP), "the codex index must no longer mention the session");
  console.log("deleted codex session and its index entry");

  // ---- and they stay gone across a rescan ---------------------------
  const after = await call({ op: "list", refresh: true });
  for (const id of [STAMP, RUNNING_ID]) {
    assert.equal(after.sessions.some((s) => s.sessionId === id), false, `${id} must not be listed after deletion`);
  }
  // The DSH session's now-empty parent directory must not resurrect a card.
  const leftovers = await readdir(join(DSH_ROOT, `-dsh-session-hub-${STAMP}`)).catch(() => []);
  assert.deepEqual(leftovers, [], "the dsh session directory must be emptied");
  console.log("rescan: deleted sessions stay gone");

  // ---- bulk delete: one project, several agents ----------------------
  // Three Claude fixtures sharing one workspace, plus a live DSH one. The live
  // one must be skipped rather than failing the batch, and removed under force.
  const bulkDir = join(CLAUDE_ROOT, `-dsh-session-hub-bulk-${STAMP}`);
  const bulkIds = [`${STAMP}-b1`, `${STAMP}-b2`, `${STAMP}-b3`];
  const bulkFiles = bulkIds.map((id) => join(bulkDir, `${id}.jsonl`));
  await mkdir(bulkDir, { recursive: true });
  for (let i = 0; i < bulkIds.length; i += 1) {
    await writeFile(
      bulkFiles[i],
      `${JSON.stringify({ type: "user", sessionId: bulkIds[i], cwd: bulkDir, timestamp: new Date().toISOString(), message: { role: "user", content: `bulk fixture ${i}` } })}\n`,
      "utf8",
    );
  }
  const bulkRunningId = `session-${STAMP}-bulk-running`;
  const bulkRunningDir = join(DSH_ROOT, `-dsh-session-hub-bulk-${STAMP}`, bulkRunningId);
  const bulkRunningFile = join(bulkRunningDir, "session.v4.jsonl.zstd");
  registry.get = (id) => (id === bulkRunningId ? { status: "running" } : undefined);
  await mkdir(bulkRunningDir, { recursive: true });
  await writeFile(bulkRunningFile, dshFixtureFor(bulkRunningId));

  const bulkList = await call({ op: "list", refresh: true });
  const bulkKeys = bulkList.sessions
    .filter((s) => bulkIds.includes(s.sessionId) || s.sessionId === bulkRunningId)
    .map((s) => s.key);
  assert.equal(bulkKeys.length, bulkIds.length + 1, "all bulk fixtures must be listed");

  const skippedLive = await call({ op: "delete-many", keys: bulkKeys });
  assert.equal(skippedLive.ok, true, `bulk delete failed: ${skippedLive.error}`);
  assert.equal(skippedLive.deleted, bulkIds.length, "the three ordinary sessions must be deleted");
  assert.equal(skippedLive.skipped, 1, "the running session must be skipped");
  assert.equal(skippedLive.failures[0].code, "running");
  for (const file of bulkFiles) await assert.rejects(stat(file), "each bulk fixture must be gone");
  assert.ok((await stat(bulkRunningFile)).isFile(), "the skipped session must survive");
  console.log(`bulk delete: ${skippedLive.deleted} deleted, ${skippedLive.skipped} skipped (running)`);

  // Re-sending the batch with `force`: the three already-deleted keys report as
  // skipped (not as errors), and the one that was held back now goes.
  const forcedLive = await call({ op: "delete-many", keys: bulkKeys, force: true });
  assert.equal(forcedLive.ok, true);
  assert.equal(forcedLive.deleted, 1, "force must delete the session that was held back");
  assert.equal(forcedLive.skipped, bulkIds.length, "already-deleted keys are reported as skipped");
  assert.equal(forcedLive.failures.filter((f) => f.code === "running").length, 0, "force must not report a running refusal");
  await assert.rejects(stat(bulkRunningFile), "the forced session must be gone");
  console.log("bulk delete: the running session went with force");

  const emptyBatch = await call({ op: "delete-many", keys: [] });
  assert.equal(emptyBatch.ok, false, "an empty batch must be refused");
  await rm(bulkDir, { recursive: true, force: true });
  await rm(join(DSH_ROOT, `-dsh-session-hub-bulk-${STAMP}`), { recursive: true, force: true });

  console.log("\ndelete test: all assertions passed");
} finally {
  await cleanup();
}
