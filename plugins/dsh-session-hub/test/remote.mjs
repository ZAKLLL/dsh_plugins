/**
 * Remote store and environment-probe test.
 *
 * The whole remote half of this plugin normally needs another machine. This test
 * supplies one: a fake `ssh` on `PATH` that runs the "remote" script on this
 * machine, with a `stat` shim translating the one GNU call the store makes. That
 * turns the part of the code that is hardest to reason about — quoting, batching,
 * NUL-framed records, the bracketed probe — into something that actually runs in
 * CI, rather than something that is merely hoped correct until a host is up.
 *
 * It then goes one step further and puts a *synthetic* remote home behind the
 * Host's environment switcher, asserting that a Claude session living only in
 * that directory is listed as a remote session with the right title — while none
 * of this machine's sessions appear.
 *
 *   node test/remote.mjs
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";

const execFileAsync = promisify(execFile);

import { shq, bracketed, unwrapBracketed, sshExec } from "../ssh.js";
import { createRemoteStore, parseGnuStatTime, parseRemoteStat } from "../store.js";
import { createRemoteHost, localHost, parseProcesses } from "../host.js";
import { probeEnvironment } from "../environments.js";

let checks = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  checks += 1;
}
function equal(actual, expected, message) {
  check(actual === expected, `${message} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`);
}

/* ---------------------------------------------------------------- *
 * A remote machine, standing in for itself
 * ---------------------------------------------------------------- */

const scratch = await mkdtemp(join(tmpdir(), "dsh-session-hub-remote-"));
const remoteHome = join(scratch, "remote-home");
const binDir = join(scratch, "bin");
const gnuBin = join(scratch, "gnubin");

await mkdir(join(remoteHome, ".claude", "projects", "-home-zakl-proj-alpha"), { recursive: true });
await mkdir(gnuBin, { recursive: true });
await mkdir(binDir, { recursive: true });

const CLAUDE_FILE = join(remoteHome, ".claude", "projects", "-home-zakl-proj-alpha", "remote-session-1.jsonl");
await writeFile(
  CLAUDE_FILE,
  [
    JSON.stringify({
      type: "user",
      sessionId: "remote-session-1",
      cwd: "/home/zakl/proj/alpha",
      timestamp: "2026-01-02T03:04:05.000Z",
      message: { content: [{ type: "text", text: "remote hello world" }] },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "remote-session-1",
      cwd: "/home/zakl/proj/alpha",
      timestamp: "2026-01-02T03:04:06.000Z",
      message: {
        model: "claude-sonnet-4",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: "remote reply" }],
      },
    }),
    "",
  ].join("\n"),
  "utf8",
);

// A second store, to prove the batching handles more than one file.
const CLAUDE_FILE_2 = join(remoteHome, ".claude", "projects", "-home-zakl-proj-alpha", "remote-session-2.jsonl");
await writeFile(
  CLAUDE_FILE_2,
  `${JSON.stringify({
    type: "user",
    sessionId: "remote-session-2",
    cwd: "/home/zakl/proj/alpha",
    timestamp: "2026-01-03T03:04:05.000Z",
    message: { content: [{ type: "text", text: "second remote session" }] },
  })}\n`,
  "utf8",
);

// A store that is not Claude, so the remote walk has to filter by matcher.
await writeFile(join(remoteHome, ".claude", "projects", "-home-zakl-proj-alpha", "notes.txt"), "not a session\n", "utf8");

await writeFile(
  join(gnuBin, "stat"),
  `#!/bin/sh
# GNU \`stat -c '%s|%y|%w'\` on macOS, so the remote store's stat script can run.
if [ "$1" != "-c" ]; then exec /usr/bin/stat "$@"; fi
fmt="$2"; shift 2
[ "$1" = "--" ] && shift
if [ "$fmt" != "%s|%y|%w" ]; then
  echo "fake stat: unsupported format: $fmt" >&2
  exit 1
fi
status=0
for p in "$@"; do
  if [ ! -e "$p" ]; then
    echo "stat: $p: No such file or directory" >&2
    status=1
    continue
  fi
  size=$(/usr/bin/stat -f '%z' "$p")
  mtime="$(/usr/bin/stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$p")$(/usr/bin/stat -f '%Sm' -t '%z' "$p")"
  birth="$(/usr/bin/stat -f '%SB' -t '%Y-%m-%d %H:%M:%S' "$p")$(/usr/bin/stat -f '%SB' -t '%z' "$p")"
  printf '%s|%s|%s\\n' "$size" "$mtime" "$birth"
done
exit $status
`,
  "utf8",
);
await chmod(join(gnuBin, "stat"), 0o755);

// The process table, but only when asked for it. It stands in for the far
// machine's processes, so the liveness path can be exercised without one.
await writeFile(
  join(gnuBin, "ps"),
  `#!/bin/sh
if [ -n "$FAKE_PS_FILE" ] && [ -f "$FAKE_PS_FILE" ]; then
  cat "$FAKE_PS_FILE"
  exit 0
fi
exec /bin/ps "$@"
`,
  "utf8",
);
await chmod(join(gnuBin, "ps"), 0o755);

await writeFile(
  join(binDir, "ssh"),
  `#!/bin/sh
# A stand-in for ssh: run the remote command on this machine.
if [ -n "$FAKE_SSH_LOG" ]; then
  { printf 'argc=%s\\n' "$#"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } >> "$FAKE_SSH_LOG"
fi
# A dry run only records the argv — used to check that the string handed to a
# terminal parses the way it was built, without executing an interactive shell.
[ -n "$FAKE_SSH_DRY" ] && exit 0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { echo "fake ssh: no command given" >&2; exit 255; }
alias_name="$1"; shift
[ -n "$FAKE_SSH_HOME" ] && HOME="$FAKE_SSH_HOME" && export HOME
[ -n "$FAKE_SSH_BIN" ] && PATH="$FAKE_SSH_BIN:$PATH" && export PATH
exec sh -c "$1"
`,
  "utf8",
);
await chmod(join(binDir, "ssh"), 0o755);

process.env.FAKE_SSH_HOME = remoteHome;
process.env.FAKE_SSH_BIN = gnuBin;
process.env.PATH = `${binDir}:${process.env.PATH}`;

/* ---------------------------------------------------------------- *
 * 1. Pure helpers
 * ---------------------------------------------------------------- */

equal(shq("plain"), "'plain'", "a simple word is single-quoted");
equal(shq("a b"), "'a b'", "a space stays one word");
equal(shq("it's"), "'it'\\''s'", "an embedded quote is escaped, not left to close the string");
equal(shq("$(rm -rf /)"), "'$(rm -rf /)'", "a command substitution is neutralised");
equal(shq("a\nb"), "'a\nb'", "a newline survives as one word");

equal(parseGnuStatTime("2026-01-02 03:04:05.123456789 +0800"), Date.parse("2026-01-01T19:04:05.123Z"), "nanoseconds and a +0800 offset");
equal(parseGnuStatTime("2026-01-02 03:04:05 -0500"), Date.parse("2026-01-02T08:04:05.000Z"), "a negative offset");
equal(parseGnuStatTime("2026-01-02 03:04:05"), Date.parse("2026-01-02T03:04:05.000Z"), "a missing offset reads as UTC");
equal(parseGnuStatTime("-"), null, "a birth time that does not exist is not a date");
equal(parseGnuStatTime("garbage"), null, "garbage is not a date");

const stat = parseRemoteStat("1234|2026-01-02 03:04:05.500000000 +0800|2026-01-01 00:00:00.000000000 +0800");
equal(stat.size, 1234, "the size is read");
equal(stat.mtimeMs, Date.parse("2026-01-01T19:04:05.500Z"), "the mtime keeps its milliseconds");
equal(stat.birthtimeMs, Date.parse("2025-12-31T16:00:00.000Z"), "the birth time is read");
equal(parseRemoteStat("1234|2026-01-02 03:04:05 +0800|-").birthtimeMs, undefined, "an absent birth time stays absent");
equal(parseRemoteStat(""), null, "an empty stat line is not a stat");

const framed = bracketed("printf 'payload\\n'");
equal(unwrapBracketed(framed.mark, `Welcome to the machine\n${framed.mark}\npayload\n${framed.mark}\nbye`), "payload", "rc noise around the payload is discarded");
equal(unwrapBracketed(framed.mark, "no sentinels here"), null, "output without sentinels is not an answer");

/* ---------------------------------------------------------------- *
 * 2. The ssh invocation shape
 * ---------------------------------------------------------------- */

const log = join(scratch, "ssh.log");
process.env.FAKE_SSH_LOG = log;
const ugly = `echo "a b" 'c d' | cat`;
await sshExec("some-host", ugly);
const logged = await readFile(log, "utf8");
const argv = logged
  .split("\n")
  .filter((line) => line.startsWith("arg="))
  .map((line) => line.slice(4));
// Asserted as a *property*, not a count: options come first, then the host, then
// one command word. The count is not fixed — connection multiplexing adds three
// `-o` pairs, and a test that pinned the number would break every time an
// unrelated option was added.
equal(argv[argv.length - 2], "some-host", "the host is the argument immediately before the command");
equal(argv[argv.length - 1], `sh -c ${shq(ugly)}`, "the script travels quoted into a single remote word");
equal(
  argv.filter((argument) => argument.includes("echo")).length,
  1,
  "the script must appear exactly once, not split into several argv words",
);
check(
  argv.includes("ControlMaster=auto") && argv.some((argument) => argument.startsWith("ControlPath=")),
  "calls are multiplexed — without it every question pays a full handshake, which was the 47-second scan",
);
delete process.env.FAKE_SSH_LOG;

/* ---------------------------------------------------------------- *
 * 3. The remote store, operation by operation
 * ---------------------------------------------------------------- */

const store = createRemoteStore({ alias: "fake", id: "fake" });

const walked = await store.walk(join(remoteHome, ".claude", "projects"), (_path, name) => name.endsWith(".jsonl"), {});
equal(walked.length, 2, `the walk must find the two sessions, not notes.txt: ${JSON.stringify(walked)}`);
check(walked.every((path) => path.endsWith(".jsonl")), "the matcher must be applied to every path");

const nothing = await store.walk(join(remoteHome, "does-not-exist"), () => true, {});
equal(nothing.length, 0, "a missing root is an empty inventory, not an exception");

const one = await store.stat(CLAUDE_FILE);
check(one.size > 0, "stat must report a size");
check(one.mtimeMs > Date.parse("2026-01-01"), "stat must report a plausible mtime");

const many = await store.statMany([CLAUDE_FILE, CLAUDE_FILE_2, join(remoteHome, "missing")]);
equal(many.size, 3, "statMany must answer for every path asked");
check(many.get(CLAUDE_FILE).size === one.size, "batched stat must agree with the single stat");
equal(many.get(join(remoteHome, "missing")), null, "a missing file is reported as absent, not thrown over");

const head = await store.readHead(CLAUDE_FILE, 65536);
equal(head.filled, false, "a head larger than the file is not filled");
check(head.text.includes("remote hello world"), "the head must carry the file's text");

const shortHead = await store.readHead(CLAUDE_FILE, 64);
equal(shortHead.filled, true, "a head smaller than the file is filled");
equal(shortHead.text.length, 64, "a filled head is exactly the cap");

const heads = await store.readHeads([
  { path: CLAUDE_FILE, bytes: 65536 },
  { path: CLAUDE_FILE_2, bytes: 65536 },
  { path: join(remoteHome, "missing"), bytes: 1024 },
]);
equal(heads.size, 2, "a missing file is omitted from a batched read");
check(heads.get(CLAUDE_FILE).text.includes("remote hello world"), "a batched head carries its own file");
check(heads.get(CLAUDE_FILE_2).text.includes("second remote session"), "each batched head is its own file, not the first one");
equal(heads.get(CLAUDE_FILE).filled, false, "a batched head reports its own fill state");

const full = await store.readFile(CLAUDE_FILE);
equal(full.toString("utf8"), await readFile(CLAUDE_FILE, "utf8"), "readFile must be byte-exact");

const fromZero = await store.readAt(CLAUDE_FILE, 0, 10);
equal(fromZero.toString("utf8"), full.subarray(0, 10).toString("utf8"), "readAt at offset zero");
const fromMiddle = await store.readAt(CLAUDE_FILE, 5, 10);
equal(fromMiddle.toString("utf8"), full.subarray(5, 15).toString("utf8"), "readAt from an offset");

const tail = await store.readTail(CLAUDE_FILE, 32);
equal(tail.fromStart, false, "a tail of a longer file does not start at zero");
equal(tail.buffer.toString("utf8"), full.subarray(full.length - 32).toString("utf8"), "the tail is the end of the file");
const wholeTail = await store.readTail(CLAUDE_FILE, 10 * 1024 * 1024);
equal(wholeTail.fromStart, true, "a tail larger than the file starts at zero");
equal(wholeTail.buffer.length, full.length, "a whole-file tail is the whole file");

const outside = join(remoteHome, "sub", "dir", "written.txt");
await store.writeText(outside, "written over ssh\n");
equal(await readFile(outside, "utf8"), "written over ssh\n", "writeText creates the parent and lands the bytes");
// The awkward body: quotes, substitutions and a trailing newline must round-trip.
const nasty = "key: 'quoted'\ncmd: $(whoami) `id` \"dq\" \\back\n\n";
await store.writeText(outside, nasty);
equal(await readFile(outside, "utf8"), nasty, "a body with quotes and substitutions is written literally");

const removable = join(remoteHome, "to-remove.txt");
await writeFile(removable, "x", "utf8");
await store.remove(removable, { recursive: false });
equal(await readFile(removable, "utf8").catch(() => null), null, "remove deletes the file");

const missingStat = await store.stat(join(remoteHome, "missing")).then(() => null, (error) => error);
check(missingStat instanceof Error, "stat on a missing file rejects, so callers can catch it");

/* ---------------------------------------------------------------- *
 * 3b. Using a machine: commands, the process table, a working directory
 * ---------------------------------------------------------------- */

/**
 * The half that is about the *other* machine.
 *
 * `store` covers bytes; a host also has to run a command over there and report
 * what is running there. That second part is what turns the green dot, the
 * "focus the window it is already in" path, and the delete guard's "this session
 * is still running" from local-only into things that mean something on a remote
 * session — so it is worth exercising through the fake ssh, where the "remote"
 * process table is this machine's.
 */
equal(parseProcesses("  1 04-08:26:09 /sbin/launchd\n").length, 1, "a plain ps line parses");
const parsedRow = parseProcesses("  492       08:00 /System/Library/x.app/Contents/MacOS/x -t 15")[0];
equal(parsedRow.pid, 492, "the pid is read");
equal(parsedRow.etime, "08:00", "the elapsed-time field is read");
equal(parsedRow.executable, "x", "the executable is taken as a basename, because a shebang script reports sh");
equal(parsedRow.args, "-t 15", "and the arguments are everything after it");
equal(parseProcesses("garbage\n\n").length, 0, "anything that is not a process row is dropped");

const remoteHost = createRemoteHost({ alias: "fake", id: "fake", label: "Fake remote" });
const remoteProcesses = await remoteHost.processes();
check(remoteProcesses.length > 0, "a remote machine must be able to report its process table");
check(
  remoteProcesses.every((row) => Number.isInteger(row.pid) && row.pid > 0),
  "and every row must carry a real pid",
);
check(
  remoteProcesses.some((row) => row.executable === "node" || row.args.includes("node")),
  "this machine is running node, and the fake remote runs here",
);

const remoteCwd = await remoteHost.cwdOf(process.pid);
equal(remoteCwd, process.cwd(), "a process's directory can be asked of the far side");
equal(await remoteHost.cwdOf(999999), null, "and a pid that is not there is null, not an error");

// The local host answers the same two questions without any ssh at all.
equal(await localHost.cwdOf(process.pid), process.cwd(), "the local host reads its own /proc or lsof");
check((await localHost.processes()).length > 0, "and its own process table");

/* ---------------------------------------------------------------- *
 * 4. The probe
 * ---------------------------------------------------------------- */
await mkdir(join(remoteHome, ".codex", "sessions"), { recursive: true });
const probe = await probeEnvironment({ id: "fake", kind: "remote", alias: "fake", label: "Fake" }, { force: true });
check(probe.reachable === true, `the probe must succeed: ${probe.error}`);
equal(probe.home, remoteHome, "the probe reads $HOME from the far side");
check(probe.agents.includes("claude"), `the probe must find the claude store: ${JSON.stringify(probe.agents)}`);
check(probe.agents.includes("codex"), "the probe must find the codex store");
check(!probe.agents.includes("pi"), "the probe must not invent a store that is not there");

/* ---------------------------------------------------------------- *
 * 5. Dialects that need a *second* file
 * ---------------------------------------------------------------- */

/**
 * Codex and Gemini both interpret a rollout with the help of a sibling file —
 * Codex's thread-name index, Gemini's `.project_root`. `build` is synchronous,
 * so those reads go through the adapter's `hydrate(store)` hook. This is the
 * half that would silently read *this* machine if the hook were missing, so the
 * fixtures are built to tell the two apart: the index name differs from the
 * first-message fallback, and the project root differs from the directory name.
 */
const CODEX_ROLLOUT = join(remoteHome, ".codex", "sessions", "2026", "02", "01", "rollout-remote-1.jsonl");
await mkdir(join(remoteHome, ".codex", "sessions", "2026", "02", "01"), { recursive: true });
await writeFile(
  CODEX_ROLLOUT,
  [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "remote-codex-1", cwd: "/home/zakl/proj/beta", timestamp: "2026-02-01T00:00:00.000Z" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "REMOTE_CODEX_FALLBACK" }] },
    }),
    "",
  ].join("\n"),
  "utf8",
);
await writeFile(
  join(remoteHome, ".codex", "session_index.jsonl"),
  `${JSON.stringify({ id: "remote-codex-1", thread_name: "REMOTE_CODEX_THREAD_NAME", updated_at: "2026-02-01T00:00:02.000Z" })}\n`,
  "utf8",
);

const GEMINI_CHAT = join(remoteHome, ".gemini", "tmp", "beta-project", "chats", "session-remote-1.jsonl");
await mkdir(join(remoteHome, ".gemini", "tmp", "beta-project", "chats"), { recursive: true });
await writeFile(
  GEMINI_CHAT,
  [
    JSON.stringify({
      sessionId: "remote-gemini-1",
      startTime: "2026-02-01T00:00:00.000Z",
      lastUpdated: "2026-02-01T00:00:02.000Z",
      kind: "main",
    }),
    JSON.stringify({
      $set: {
        messages: [
          {
            id: "m1",
            timestamp: "2026-02-01T00:00:01.000Z",
            type: "user",
            content: [{ text: "remote gemini question" }],
          },
        ],
      },
    }),
    "",
  ].join("\n"),
  "utf8",
);
// The project root lives two directories up, in the one file Gemini mirrors it
// into — and it is deliberately not the directory's own name (`beta-project`).
await writeFile(join(remoteHome, ".gemini", "tmp", "beta-project", ".project_root"), "/home/zakl/proj/gamma\n", "utf8");

// DSH's store is concatenated zstd frames, so its adapter is the one that cannot
// be handed parsed events — the engine must read the bytes through the active
// store. Before that was true, this session read *this* machine's disk and threw
// ENOENT, which no fixture on this machine could have caught.
const DSH_STORE = join(remoteHome, ".dsh", "sessions", "-home-zakl-proj-delta", "remote-dsh-1", "session.v4.jsonl.zstd");
await mkdir(dirname(DSH_STORE), { recursive: true });
const dshText = [
  // The header's fields sit at the top level, not under `data` — copied from a
  // real store rather than guessed.
  JSON.stringify({
    type: "session",
    version: 4,
    id: "remote-dsh-1",
    createdAt: 1772323200000,
    cwd: "/home/zakl/proj/delta",
    isSeeded: false,
  }),
  JSON.stringify({ type: "session/title", time: 1772323200000, data: { title: "REMOTE_DSH_TITLE" } }),
  JSON.stringify({
    type: "user/message",
    time: 1772323201000,
    data: { role: "user", content: [{ text: "remote dsh question" }] },
  }),
  "",
].join("\n");
// Two frames, because concatenation is the shape that matters here: a single
// frame would decode with a plain `zstdDecompressSync` and hide the difference.
const encoded = Buffer.from(dshText, "utf8");
const cut = Math.floor(encoded.length / 2);
await writeFile(
  DSH_STORE,
  Buffer.concat([zstdCompressSync(encoded.subarray(0, cut)), zstdCompressSync(encoded.subarray(cut))]),
);

/* ---------------------------------------------------------------- *
 * 6. Through the Host: a remote inventory
 * ---------------------------------------------------------------- */

process.env.DSH_HOME = join(scratch, "local-dsh");
await mkdir(process.env.DSH_HOME, { recursive: true });

const mod = await import("../index.js");
let route = null;
mod.apply(
  {
    effect: (callback) => {
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    connection: { fetch: { register: (registered) => { route = registered; } } },
  },
  { environments: [{ id: "fake", alias: "fake", label: "Fake remote", home: remoteHome, dshHome: join(remoteHome, ".dsh") }] },
);

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

const switched = await call({ op: "environment", action: "set", id: "fake" });
check(switched.body.ok === true, `the switch must answer: ${JSON.stringify(switched.body).slice(0, 300)}`);
check(switched.body.active.reachable === true, `the fake remote must be reachable: ${JSON.stringify(switched.body.active)}`);

const remote = await call({ op: "list" });
check(remote.body.ok === true, `the remote list must work: ${JSON.stringify(remote.body).slice(0, 400)}`);
const remoteSessions = remote.body.sessions;
check(
  remoteSessions.length === 5,
  `exactly the five remote sessions must be listed: ${JSON.stringify(remoteSessions.map((s) => s.key))}`,
);
check(!remoteSessions.some((card) => card.file.startsWith("/Users/")), "no local session may appear as remote");

const first = remoteSessions.find((card) => card.sessionId === "remote-session-1");
check(first !== undefined, "the synthetic remote session must be found by its own id");
equal(first.title, "remote hello world", "the adapter parsed the remote store into a title");
equal(first.project, "alpha", "the remote cwd became the project");
equal(first.cwd, "/home/zakl/proj/alpha", "the remote path is reported as written");

// The two dialects whose title / cwd comes from a sibling file.
const codex = remoteSessions.find((card) => card.agent === "codex");
check(codex !== undefined, "the remote codex session must be listed");
equal(codex.title, "REMOTE_CODEX_THREAD_NAME", "the codex title must come from the remote index, not the first message");
check(codex.title !== "REMOTE_CODEX_FALLBACK", "and specifically not from the rollout's own text");
equal(codex.cwd, "/home/zakl/proj/beta", "the codex cwd comes from the rollout itself");

const gemini = remoteSessions.find((card) => card.agent === "gemini");
check(gemini !== undefined, "the remote gemini session must be listed");
equal(gemini.cwd, "/home/zakl/proj/gamma", "the gemini cwd must come from the remote .project_root");
check(gemini.cwd !== "beta-project", "and not from the directory's own name");
equal(gemini.title, "remote gemini question", "the gemini store parsed into a title");

// The zstd-framed dialect, whose bytes the engine must fetch and hand over.
const dsh = remoteSessions.find((card) => card.agent === "dsh");
check(dsh !== undefined, "the remote dsh session must be listed — not thrown over as a missing file");
equal(dsh.title, "REMOTE_DSH_TITLE", "the frames store decoded, which needs the remote bytes and both frames");
equal(dsh.cwd, "/home/zakl/proj/delta", "the dsh header's cwd survived the round trip");
equal(dsh.messages, 1, "and its turns were parsed");

// The config viewer reads the remote machine's files through the same store.
const remoteConfig = await call({ op: "config", action: "list" });
check(remoteConfig.body.ok === true, "config listing must work on the remote");
check(remoteConfig.body.environment.id === "fake", "the config response names the remote environment");
const remoteClaude = remoteConfig.body.agents.find((group) => group.agent === "claude");
check(
  remoteClaude.files.every((file) => file.path.startsWith(remoteHome)),
  "remote config paths must point at the remote home, not this machine's",
);

/* ---------------------------------------------------------------- *
 * 7. One-click open on another machine
 * ---------------------------------------------------------------- */

/**
 * The string a terminal is asked to run.
 *
 * Its whole risk is quoting, and no amount of reading the string tells you
 * whether a shell will parse it back the way it was built — so it is handed to
 * `sh` and the fake `ssh` reports what it actually received. This is the same
 * technique the remote-launcher plugin uses, for the same reason: the nested
 * `$SHELL -lic` and a `cwd` that may contain a space are exactly where a
 * hand-built command goes wrong.
 */
const openLog = join(scratch, "open-ssh.log");
await writeFile(openLog, "", "utf8");
process.env.FAKE_SSH_LOG = openLog;
process.env.FAKE_SSH_DRY = "1";
const invocation = mod.__test.remoteInvocation(
  { alias: "some-host", label: "Some Host" },
  "/home/zakl/proj/with space",
  "claude --resume abc",
);
await execFileAsync("sh", ["-c", invocation]);
const openArgs = (await readFile(openLog, "utf8"))
  .split("\n")
  .filter((line) => line.startsWith("arg="))
  .map((line) => line.slice(4));
equal(openArgs.length, 3, `ssh must receive exactly three arguments: ${JSON.stringify(openArgs)}`);
equal(openArgs[0], "-t", "a tty is requested, so the agent can run interactively");
equal(openArgs[1], "some-host", "the alias is its own argument");
check(openArgs[2].includes("/home/zakl/proj/with space"), "the remote cwd survives as one path");
check(openArgs[2].includes("$SHELL") && openArgs[2].includes("-lic"), "the agent is looked up by an interactive shell");
check(openArgs[2].includes("claude --resume abc"), "and the resume command is intact");
check(openArgs[2].startsWith("exec"), "the interactive shell replaces the ssh session, so the tty is the agent's");
delete process.env.FAKE_SSH_LOG;
delete process.env.FAKE_SSH_DRY;

// A session with no stored cwd still opens: it just starts in the remote home.
const noCwd = mod.__test.remoteInvocation({ alias: "some-host", label: "Some Host" }, null, "codex resume x");
check(!noCwd.includes("cd "), "a session with no cwd must not try to enter one");

// A DSH session on another machine belongs to that machine's DSH. Opening it
// through this machine's workspace registry would look like a local session.
const remoteDsh = remoteSessions.find((card) => card.agent === "dsh");
const opened = await call({ op: "open", key: remoteDsh.key });
check(opened.body.ok === true, `the open op must answer: ${JSON.stringify(opened.body)}`);
equal(opened.body.kind, "manual", "a remote DSH session is not opened through this machine");
equal(opened.body.command, null, "and no local command is offered for it");
check(
  /belongs to that machine/.test(opened.body.reason ?? ""),
  `the reason must be specific: ${opened.body.reason}`,
);
check(
  !/uiWorkspace|workspace registry|unavailable/.test(opened.body.reason ?? ""),
  "and must not blame a missing local service, which is what a generic failure would say",
);

// Starting a fresh DSH session there is refused for the same reason — the
// alternative is registering a local workspace pointed at a remote path.
const spawned = await call({ op: "spawn", agent: "dsh", cwd: "/home/zakl/proj/delta" });
check(spawned.body.ok === false, "starting a DSH session on another machine must be refused");
check(
  /cannot be started on/.test(spawned.body.error ?? ""),
  `and must name the machine rather than the client: ${spawned.body.error}`,
);

/* ---------------------------------------------------------------- *
 * 8. Deleting on another machine needs an explicit go-ahead
 * ---------------------------------------------------------------- */

/**
 * Liveness here is this machine's process table and cmux's records, and neither
 * can see a process on the far side. Left unguarded, the "is it still running"
 * check would simply stop firing exactly where a mistake is hardest to notice —
 * so the deletion is refused until the caller says it knows.
 *
 * `delete-many` is the one that matters most: its loop passes `force` for every
 * key (the running ones were already filtered above), so a per-session check
 * would never be reached and the whole batch would sail through.
 */
const codexCard = remoteSessions.find((card) => card.agent === "codex");
const refusedDelete = await call({ op: "delete", key: codexCard.key });
check(refusedDelete.body.ok === false, "a remote delete must be refused without an explicit go-ahead");
equal(refusedDelete.body.code, "liveness-unknown", "and must say which guard it is");
check(/still running on/.test(refusedDelete.body.error ?? ""), `naming the machine: ${refusedDelete.body.error}`);

const refusedBatch = await call({ op: "delete-many", keys: [codexCard.key] });
check(refusedBatch.body.ok === false, "a remote batch delete must be refused too");
equal(refusedBatch.body.code, "liveness-unknown", "with the same reason");
check(
  refusedBatch.body.deleted === undefined,
  "and must not have deleted anything before refusing — the batch loop forces each key",
);

// The refusal must not be a dead end: saying "I know" gets through, and it really
// does delete the remote file rather than a local one.
check(await readFile(CODEX_ROLLOUT, "utf8").then(() => true, () => false), "the fixture must still be there");
const forced = await call({ op: "delete", key: codexCard.key, force: true });
check(forced.body.ok === true, `an acknowledged remote delete must go through: ${JSON.stringify(forced.body)}`);
equal(forced.body.target, CODEX_ROLLOUT, "and must name the remote path it removed");
check(await readFile(CODEX_ROLLOUT, "utf8").then(() => false, () => true), "the remote store is gone");
check(
  await readFile(join(remoteHome, ".codex", "session_index.jsonl"), "utf8").then((text) => !text.includes("remote-codex-1"), () => false),
  "and the remote thread-name index was tidied through the same store",
);

const backLocal = await call({ op: "environment", action: "set", id: "local" });
check(backLocal.body.ok === true, "switching back must answer");
const local = await call({ op: "list" });
check(local.body.ok === true, "the local list must work after switching back");
check(!local.body.sessions.some((card) => card.agent === "claude" && card.file === CLAUDE_FILE), "the remote session must be gone once local is active");

/* ---------------------------------------------------------------- *
 * 9. Liveness over there, and what it means for deleting
 * ---------------------------------------------------------------- */

/**
 * The green dot used to be local-only: liveness came from *this* machine's
 * process table, so a remote session could never be seen running. It now comes
 * from whichever machine the panel is pointed at.
 *
 * This is asserted with a synthetic process table rather than a real one,
 * because the property under test is the whole chain — read the table over
 * there, parse the argv, match the session id, refuse to delete a live log —
 * and a fixture can state all four links exactly. The row is deliberately in the
 * shebang form (`/bin/sh /tmp/gemini …`), which is the case that needs the
 * *first argument* examined rather than the executable.
 */
// The previous section deliberately ends on `local`, so this one has to go back
// out before it can observe anything over there.
const toRemote = await call({ op: "environment", action: "set", id: "fake" });
check(toRemote.body.ok === true, "the fake machine must be selectable again");

const psFile = join(scratch, "remote-ps.txt");
await writeFile(psFile, "  4242 00:30 /bin/sh /tmp/gemini --resume remote-gemini-1\n", "utf8");
process.env.FAKE_PS_FILE = psFile;

const live = await call({ op: "list", refresh: true });
check(live.body.ok === true, "the list must still work with a process table");
const liveGemini = (live.body.sessions ?? []).find((card) => card.agent === "gemini");
check(liveGemini !== undefined, "the gemini fixture must still be listed");
check(liveGemini.running === true, "a session whose agent is running on the other machine must show as running");
equal(liveGemini.live?.pid, 4242, "with the pid the other machine reported");
check(live.body.runningCount >= 1, "and it must be counted");

// A session we *saw* running gets the plain refusal, not the cautious one: the
// answer is not in doubt, so the caller is told the same thing as locally.
const liveDelete = await call({ op: "delete", key: liveGemini.key });
check(liveDelete.body.ok === false, "deleting a running remote session must be refused");
equal(liveDelete.body.code, "running", "as running, not as unknown — the evidence is there");
check(!/cannot be sure/.test(liveDelete.body.error ?? ""), `and the message must not hedge: ${liveDelete.body.error}`);

// With the table empty again it is back to "cannot be sure", which is the whole
// reason the acknowledged path exists.
await writeFile(psFile, "", "utf8");
const quiet = await call({ op: "list", refresh: true });
const quietGemini = (quiet.body.sessions ?? []).find((card) => card.agent === "gemini");
check(quietGemini.running === false, "an empty process table means nothing is seen running");
const cautious = await call({ op: "delete", key: quietGemini.key });
equal(cautious.body.code, "liveness-unknown", "and then the refusal says it cannot be sure");
delete process.env.FAKE_PS_FILE;

// Leave the panel where the rest of the suite expects it.
const homeAgain = await call({ op: "environment", action: "set", id: "local" });
check(homeAgain.body.ok === true, "and back to this machine");

await rm(scratch, { recursive: true, force: true });
console.log(`remote: all ${checks} assertions passed`);
