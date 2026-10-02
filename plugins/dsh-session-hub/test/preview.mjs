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
// One DSH session with an approval ask and no decision (genuinely waiting),
// and one whose ask was decided (nothing waiting).
const PENDING_ID = `session-${STAMP}-pending`;
const RESOLVED_ID = `session-${STAMP}-resolved`;
const APPROVAL_TOOL = "plugin_manager";
// What the DSH reference resolver would hand back for the fixture.
const MENTION = "@session-selftest";
// DSH reasoning blocks carry a `text` field too, so a naive reader returns the
// model thinking out loud instead of its answer.
const REASONING_TEXT = "SELFTEST-REASONING-do-not-show";
// DSH names the model on its request header, on the very same store walk that
// finds pending approvals — one handler has to do both.
const DSH_MODEL = "selftest-provider/selftest-model";

const RUNNING_INPUT = "把最后那段日志贴给我看看";
const RUNNING_OUTPUT = "日志在这里，最后一行是超时，我准备把超时从 30s 提到 120s。";
const HOOK_INPUT = "hook 报上来的输入";
const HOOK_OUTPUT = "hook 报上来的输出";

const RUNNING_IDS = new Set([RUNNING_ID, PENDING_ID, RESOLVED_ID]);
const registry = { get: (id) => (RUNNING_IDS.has(id) ? { status: "running" } : undefined) };
let route = null;
mod.apply({
  connection: { fetch: { register: (registered) => { route = registered; } } },
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  get: (name) => {
    if (name === "agents") return registry;
    // The reference resolver is what turns a DSH session into a native mention.
    if (name === "sessionReferenceResolver") {
      return {
        remoteExportCandidates: async () => [{ sessionId: RUNNING_ID, mention: MENTION, label: "selftest session" }],
      };
    }
    return undefined;
  },
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
const PI_TOKENS = { input: 4719, output: 235, cacheRead: 1024, cacheWrite: 0, total: 5978 };
// A session that switched models: the split must show both, not just the last.
const PI_MODEL_A = 'blueai-relay-200k/glm-5.3';
const PI_MODEL_B = 'blueai-relay-200k/glm-5.4';
const PI_TOKENS_B = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, total: 1100 };
const PI_INPUT = "pi 收到的输入";
const PI_OUTPUT = "pi 目前的产出";
const PI_SCRIPT = join(PI_WORKSPACE, "pi-selftest");
let piChild = null;

let spoolBackup = null;
let spoolExisted = true;

/** One zstd frame over JSONL: a session with one human turn and one reply. */
function fixture(id, cwd, input, output, extra = []) {
  const header = { type: "session", version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard" };
  const request = { type: "request/header", seq: 1, time: Date.now(), data: { header: { config: { provider: "selftest-provider", model: "selftest-model" } } } };
  const user = { type: "user/message", seq: 2, time: Date.now(), data: { role: "user", content: [{ type: "text", text: input }] } };
  const assistant = {
    type: "assistant/message",
    seq: 3,
    time: Date.now(),
    data: {
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: REASONING_TEXT },
          { type: "text", text: output },
        ],
      },
    },
  };
  const lines = [header, request, user, assistant, ...extra].map((event) => JSON.stringify(event));
  return zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

/** An approval pair: the ask always, the decision only when it was answered. */
function approvalEvents(id, decided) {
  const asked = { type: "approval/asked", seq: 4, time: Date.now(), data: { id, toolName: APPROVAL_TOOL, callId: `call-${id}` } };
  if (!decided) return [asked];
  return [asked, { type: "approval/decided", seq: 5, time: Date.now(), data: { id } }];
}

/** One pi session: a header plus a single user/assistant pair. */
function piFixture(id, cwd, input, output) {
  return (
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
      JSON.stringify({ type: "model_change", id: "mc1", timestamp: new Date().toISOString(), provider: "blueai-relay-200k", modelId: "glm-5.3" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: input }] } }),
      JSON.stringify({
        type: "message",
        id: "m2",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: output }],
          usage: { input: PI_TOKENS.input, output: PI_TOKENS.output, cacheRead: PI_TOKENS.cacheRead, cacheWrite: PI_TOKENS.cacheWrite, totalTokens: PI_TOKENS.total },
        },
      }),
      JSON.stringify({ type: "model_change", id: "mc2", timestamp: new Date().toISOString(), provider: "blueai-relay-200k", modelId: "glm-5.4" }),
      JSON.stringify({
        type: "message",
        id: "m3",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: output }],
          usage: { input: PI_TOKENS_B.input, output: PI_TOKENS_B.output, cacheRead: PI_TOKENS_B.cacheRead, cacheWrite: PI_TOKENS_B.cacheWrite, totalTokens: PI_TOKENS_B.total },
        },
      }),
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
  for (const [id, input, output, extra] of [
    [RUNNING_ID, RUNNING_INPUT, RUNNING_OUTPUT, []],
    [IDLE_ID, "这个会话已经停了", "所以它不该出现在预览里", []],
    [PENDING_ID, "跑一下安装", "正在请求权限", approvalEvents(`${STAMP}-ask-open`, false)],
    [RESOLVED_ID, "跑一下安装", "权限已经批过了", approvalEvents(`${STAMP}-ask-done`, true)],
  ]) {
    const dir = join(SLUG, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.v4.jsonl.zstd"), fixture(id, `/tmp/${STAMP}`, input, output, extra));
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
  const pendingCard = list.sessions.find((session) => session.agent === "dsh" && session.sessionId === PENDING_ID);
  const resolvedCard = list.sessions.find((session) => session.agent === "dsh" && session.sessionId === RESOLVED_ID);
  assert.ok(pendingCard && resolvedCard, "the approval fixtures must be listed");

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
  assert.equal(
    preview.output.includes(REASONING_TEXT),
    false,
    "a preview must show what the model said, not its reasoning block",
  );
  console.log("preview: reasoning blocks are not mistaken for the answer");
  assert.ok(preview.at !== null, "the preview must carry a timestamp");
  console.log("preview: derived input and output from a running session's store");

  // ---- what a session has spent, and what it is waiting on -----------
  // An unanswered approval ask is the one "waiting" signal that is a fact
  // rather than a guess, so it must be reported exactly.
  const pendingPreview = first.sessions.find((session) => session.key === pendingCard.key);
  assert.ok(pendingPreview, "the waiting fixture must be previewed");
  assert.equal(pendingPreview.pending?.kind, "approval", "an unanswered approval ask must be reported");
  assert.equal(pendingPreview.pending.label, APPROVAL_TOOL, "and it must name the tool it wants");

  const resolvedPreview = first.sessions.find((session) => session.key === resolvedCard.key);
  assert.ok(resolvedPreview, "the answered fixture must be previewed");
  assert.equal(resolvedPreview.pending, null, "a decided approval must not read as waiting");
  console.log("preview: an unanswered approval reads as waiting, a decided one does not");

  // The model and the approval come from one store walk. They used to live in two
  // `readStoreEvent` keys on the same object, where the second silently replaced
  // the first — so this asserts the survivor did not eat the other.
  const dshUsage = await call({ op: "models", key: pendingCard.key });
  assert.equal(dshUsage.model, DSH_MODEL, "the model must be read from the request header");
  assert.equal(
    pendingPreview.pending?.kind,
    "approval",
    "and approval handling must survive alongside it",
  );

  // ---- referencing a session -----------------------------------------
  // Every agent offers this, but what the reference *is* depends on the agent:
  // a DSH session has a native mention, the rest point at their own store.
  const dshRef = await call({ op: "reference", key: card.key, currentSessionId: RUNNING_ID });
  assert.equal(dshRef.ok, true, `reference failed: ${dshRef.error}`);
  assert.equal(dshRef.kind, "mention", "a DSH session must use the native mention");
  assert.equal(dshRef.text, MENTION, "and the mention must be the resolver's own text");

  console.log(`reference: dsh → ${dshRef.text}`);

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

  // The usage numbers are summed from the store, and the duration comes from the
  // process table — neither is guessed.
  const tokens = piPreview.tokens;
  assert.ok(tokens, "a pi preview must carry token usage");
  const both = PI_TOKENS.total + PI_TOKENS_B.total;
  assert.equal(tokens.input, PI_TOKENS.input + PI_TOKENS_B.input, "input tokens must be summed from the store");
  assert.equal(tokens.output, PI_TOKENS.output + PI_TOKENS_B.output, "output tokens must be summed from the store");
  assert.equal(tokens.cacheRead, PI_TOKENS.cacheRead + PI_TOKENS_B.cacheRead, "cache reads must be counted");
  assert.equal(tokens.total, both, "the total must be the sum of the parts across both models");
  assert.ok(piPreview.startedAt > 0, "a running session must report when its process started");
  assert.ok(
    Number.isFinite(piPreview.elapsedMs) && piPreview.elapsedMs > 0,
    `a running session must report how long it has been up: ${piPreview.elapsedMs}`,
  );
  assert.ok(piPreview.pid > 0, "and the process it belongs to");
  console.log(`preview: pi tokens ${tokens.total} summed, up for ${Math.round(piPreview.elapsedMs / 1000)}s`);

  // An agent with no notion of mentions references its own store artifact
  // instead, which is what makes the action available for every agent.
  const piRef = await call({ op: "reference", key: piCard.key });
  assert.equal(piRef.ok, true, `reference failed: ${piRef.error}`);
  assert.equal(piRef.kind, "file", "an agent without mentions must reference its store");
  assert.equal(piRef.text, `@${PI_FILE}`, "and cite the session's own artifact path");
  assert.equal(piRef.path, PI_FILE);
  console.log(`reference: pi → ${piRef.text}`);

  // ---- the per-model split -------------------------------------------
  // A session that switched models reports every one of them; the last model
  // alone would read as though the whole conversation ran on it.
  const usage = await call({ op: "models", key: piCard.key });
  assert.equal(usage.ok, true, `models failed: ${usage.error}`);
  assert.equal(usage.model, PI_MODEL_B, "the model in effect is the last one announced");
  assert.ok(usage.models, "a session with usage must report its models");
  assert.deepEqual(
    Object.keys(usage.models).sort(),
    [PI_MODEL_A, PI_MODEL_B].sort(),
    "every model the session used must appear, not only the last",
  );
  assert.equal(usage.models[PI_MODEL_A].total, PI_TOKENS.total, "each model carries its own usage");
  assert.equal(usage.models[PI_MODEL_B].total, PI_TOKENS_B.total, "and the second model its own");
  assert.equal(
    Object.values(usage.models).reduce((sum, entry) => sum + entry.total, 0),
    usage.tokens.total,
    "the models must add up to the session total — the check that caught Codex counting cached input twice",
  );
  console.log(`models: ${Object.keys(usage.models).join(" + ")} = ${usage.tokens.total}`);

  console.log("\npreview test: all assertions passed");
} finally {
  await cleanup();
}
