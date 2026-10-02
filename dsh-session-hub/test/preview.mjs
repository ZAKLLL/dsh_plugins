/**
 * Live-preview test.
 *
 * Drives the `preview` operation against fixtures this test builds itself, and
 * against a hook spool it backs up and restores, so a real registration is never
 * disturbed.
 *
 *   node test/preview.mjs
 *
 * Verified here:
 *   - only running sessions appear, and a stopped one stays out;
 *   - the input and the latest output are derived from the tail of the store;
 *   - a hook report overrides the derivation and says so through `source`;
 *   - the hook sink (`hook.mjs`) writes a record the Host then reads back;
 *   - a hook record without an agent or a session is ignored, not attributed.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const mod = await import("../index.js");

const STAMP = `previewselftest-${process.pid}-${Date.now()}`;
const RUNNING_ID = `session-${STAMP}-running`;
const IDLE_ID = `session-${STAMP}-idle`;
const RUNNING_INPUT = "把最后那段日志贴给我看看";
const RUNNING_OUTPUT = "日志在这里，最后一行是超时，我准备把超时从 30s 提到 120s。";
const HOOK_INPUT = "hook 报上来的输入";
const HOOK_OUTPUT = "hook 报上来的输出";

const registry = { get: (id) => (id === RUNNING_ID ? { status: "running" } : undefined) };
let route = null;
mod.apply({
  connection: { fetch: { register: (registered) => { route = registered; } } },
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  get: (name) => (name === "agents" ? registry : undefined),
});

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await (await route.fetch(request)).json();
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const DSH_ROOT = join(DSH_HOME, "sessions");
const SPOOL_DIR = join(DSH_HOME, "session-hub");
const SPOOL = join(SPOOL_DIR, "hooks.jsonl");
const SLUG = join(DSH_ROOT, `-dsh-session-hub-${STAMP}`);

// A pi session started straight from a terminal: the process table is what has
// to find it, since nothing about pi cooperates.
const PI_ROOT = join(homedir(), ".pi", "agent", "sessions");
const PI_ID = `01a0${Date.now().toString(16).slice(-16)}`;
const PI_WORKSPACE = join(tmpdir(), `dsh-session-hub-pi-${STAMP}`);
const PI_DIR = join(PI_ROOT, `-dsh-session-hub-${STAMP}`);
const PI_FILE = join(PI_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${PI_ID}.jsonl`);
const PI_INPUT = "pi 收到的输入";
const PI_OUTPUT = "pi 目前的产出";
const PI_SCRIPT = join(PI_WORKSPACE, "pi-selftest");
let piChild = null;

let spoolBackup = null;
let spoolExisted = true;

/** One zstd frame over JSONL: a session with one human turn and one reply. */
function fixture(id, cwd, input, output) {
  const header = { type: "session", version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard" };
  const user = { type: "user/message", seq: 2, time: Date.now(), data: { role: "user", content: [{ type: "text", text: input }] } };
  const assistant = { type: "assistant/message", seq: 3, time: Date.now(), data: { message: { role: "assistant", content: [{ type: "text", text: output }] } } };
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`, "utf8"));
}

/** One pi session: a header plus a single user/assistant pair. */
function piFixture(id, cwd, input, output) {
  return (
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
      JSON.stringify({ type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: input }] } }),
      JSON.stringify({ type: "message", id: "m2", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: output }] } }),
    ].join("\n") + "\n"
  );
}

async function cleanup() {
  if (piChild !== null) {
    try {
      piChild.kill("SIGKILL");
    } catch {
      /* Already gone. */
    }
    piChild = null;
  }
  await rm(SLUG, { recursive: true, force: true });
  await rm(PI_DIR, { recursive: true, force: true });
  await rm(PI_WORKSPACE, { recursive: true, force: true });
  try {
    if (spoolExisted && spoolBackup !== null) await writeFile(SPOOL, spoolBackup, "utf8");
    else {
      await rm(SPOOL, { force: true });
      await rmdir(SPOOL_DIR).catch(() => {});
    }
  } catch {
    /* The test already reported. */
  }
}

try {
  for (const [id, input, output] of [
    [RUNNING_ID, RUNNING_INPUT, RUNNING_OUTPUT],
    [IDLE_ID, "这个会话已经停了", "所以它不该出现在预览里"],
  ]) {
    const dir = join(SLUG, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.v4.jsonl.zstd"), fixture(id, `/tmp/${STAMP}`, input, output));
  }
  try {
    spoolBackup = await readFile(SPOOL, "utf8");
  } catch {
    spoolExisted = false;
  }

  // ---- the fixture must be in the corpus ------------------------------
  const list = await call({ op: "list", refresh: true });
  assert.equal(list.ok, true, `list failed: ${list.error}`);
  const card = list.sessions.find((session) => session.agent === "dsh" && session.sessionId === RUNNING_ID);
  assert.ok(card, "the running fixture must be listed");
  assert.equal(card.cwd, `/tmp/${STAMP}`);

  // ---- the running fixture appears, the stopped one does not ----------
  // Assertions are scoped to the fixtures, not to the totals: this machine may
  // genuinely have other agents running, and the point is which sessions the
  // preview picks, not how many exist.
  const first = await call({ op: "preview" });
  assert.equal(first.ok, true, `preview failed: ${first.error}`);
  assert.ok(first.runningCount >= 1, "the running fixture must count as running");
  assert.equal(
    first.sessions.some((session) => session.title.includes("已停了")),
    false,
    "a stopped session must never be previewed",
  );

  const preview = first.sessions.find((session) => session.key === card.key);
  assert.ok(preview, "the running fixture must be previewed");
  assert.equal(preview.agent, "dsh");
  assert.equal(preview.source, "store", "with no hook registered the preview is derived");
  assert.equal(preview.input, RUNNING_INPUT, "the input must come from the store tail");
  assert.equal(preview.output, RUNNING_OUTPUT, "the latest output must come from the store tail");
  assert.ok(preview.at !== null, "the preview must carry a timestamp");
  console.log("preview: derived input and output from a running session's store");

  // ---- a hook report overrides the derivation ------------------------
  // Flags rather than stdin: async `execFile` has no `input` option (that is
  // `execFileSync`), so piping here would silently send nothing.
  const sink = join(HERE, "..", "hook.mjs");
  await run(process.execPath, [
    sink,
    "--agent", "dsh",
    "--session", RUNNING_ID,
    "--phase", "working",
    "--input", HOOK_INPUT,
    "--output", HOOK_OUTPUT,
  ]);
  // The Host caches the spool briefly; wait past that window.
  await new Promise((resolve) => setTimeout(resolve, 1700));

  const second = await call({ op: "preview" });
  const hooked = second.sessions.find((session) => session.key === preview.key);
  assert.ok(hooked, "the hooked session must still be previewed");
  assert.equal(hooked.source, "hook", "a registered report must win over the derivation");
  assert.equal(hooked.input, HOOK_INPUT);
  assert.equal(hooked.output, HOOK_OUTPUT);
  assert.equal(hooked.phase, "working", "the reported phase must survive");
  console.log("preview: a hook report overrides the derived preview");

  // ---- the sink ignores a record it cannot attribute -----------------
  const before = (await readFile(SPOOL, "utf8")).trim().split("\n").length;
  await run(process.execPath, [sink, "--phase", "start"]);
  await run(process.execPath, [sink, "--agent", "dsh"]);
  const after = (await readFile(SPOOL, "utf8")).trim().split("\n").length;
  assert.equal(after, before, "a record without an agent and session must not be written");
  console.log("preview: an unattributable report is dropped");

  // ---- an agent started straight from a terminal is found -------------
  // This is the shape the process table exists for: a real process whose name
  // matches an agent, whose command line names no session, running in the
  // fixture's workspace. Nothing about pi cooperates here.
  await mkdir(PI_DIR, { recursive: true });
  await mkdir(PI_WORKSPACE, { recursive: true });
  await writeFile(PI_FILE, piFixture(PI_ID, PI_WORKSPACE, PI_INPUT, PI_OUTPUT), "utf8");
  await writeFile(PI_SCRIPT, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
  piChild = spawn(PI_SCRIPT, [], { cwd: PI_WORKSPACE, stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const scanned = await call({ op: "list", refresh: true });
  const piCard = scanned.sessions.find((session) => session.agent === "pi" && session.sessionId === PI_ID);
  assert.ok(piCard, "the pi fixture must be listed");
  assert.equal(piCard.title, PI_INPUT, "pi records no title, so its first human message is it");
  assert.equal(piCard.running, true, "a pi started from a terminal must be found through the process table");
  assert.equal(piCard.live.source, "process", "and the evidence must be the process, not a hook record");
  console.log("preview: a terminal-started pi is detected through the process table");

  const piPreview = (await call({ op: "preview" })).sessions.find((session) => session.key === piCard.key);
  assert.ok(piPreview, "the running pi must appear in the live preview");
  assert.equal(piPreview.input, PI_INPUT, "the pi preview must read its input from the store");
  assert.equal(piPreview.output, PI_OUTPUT, "the pi preview must read its latest output from the store");
  console.log("preview: the pi preview carries its input and latest output");

  console.log("\npreview test: all assertions passed");
} finally {
  await cleanup();
}
