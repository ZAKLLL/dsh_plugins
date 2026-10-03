/**
 * dsh-remote-agent — the Host half.
 *
 * Manages coding agents that live on OTHER machines, from this DSH install.
 * Two shapes, because remote agents come in two shapes:
 *
 *   web   a remote `dsh web` server, reached through an SSH port-forward, with
 *         its authorization token harvested from the server's own log so the
 *         browser opens already signed in.
 *   tty   a remote CLI agent (codex, …) that has no web UI at all. This half
 *         only composes the `ssh -t` command; the Client half opens it in this
 *         window's terminal.
 *
 * ---------------------------------------------------------------------------
 * The one non-obvious constraint: the local port must equal the remote port.
 *
 * `dsh web` binds 127.0.0.1 and mints an auth cookie whose `authority` field is
 * literally `127.0.0.1:<port>`. A forward that retargets the local end — say
 * `-L 8080:127.0.0.1:19391` — hands the browser a token issued for a different
 * authority, and every request after the first 401s in a loop. There is a
 * `--trusted-host` flag on the remote server that could paper over this, but
 * making the two ports equal is the whole fix and costs nothing. So `port` is
 * one number, and `ensureTunnel` refuses to invent a different local one.
 *
 * Everything that reaches a shell is built here, never by the model and never
 * by interpolating a payload: `execFile` receives an argument array, and the
 * one place a string must become a remote shell command it is single-quoted by
 * `shq`. Host aliases, agent ids and paths are validated against conservative
 * patterns at config time, so a bad config row is dropped rather than executed.
 *
 * Remote state is kept on the remote (`$HOME/.dsh-remote-agent/<agent>.{pid,log}`)
 * so it survives this plugin reloading, and because the pid of a remote process
 * is only meaningful over there. Local state is only the port forwards, which
 * are children of this process and die with it.
 */

import { execFile, spawn } from "node:child_process";
import { connect } from "node:net";

export const name = "dsh-remote-agent";

/** The Host route lives on the shared `/api` Fetch channel. */
export const inject = ["connection"];

const ROUTE = "/api/remote-agent";

const OPS = ["overview", "probe", "start", "stop", "restart", "url", "logs"];

/**
 * Conservative shapes for anything that ends up inside a command line.
 * A row that fails these is dropped with a diagnostic instead of being quoted
 * and hoped for — config is code, and this is the boundary where that is true.
 */
const RX_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,190}$/;
const RX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** A single path segment on the remote, dot-prefixed names allowed. */
const RX_SEGMENT = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RX_ABS_PATH = /^\/[A-Za-z0-9._@/+-]{1,400}$/;
const RX_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Remote commands the probe op looks for, in the order it reports them. */
const PROBE_COMMANDS = ["dsh", "codex", "claude", "gemini", "opencode", "pi"];

const DEFAULT_STATE_DIR = ".dsh-remote-agent";
const DEFAULT_PORT = 19391;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_HEAL_INTERVAL_MS = 30_000;

/* ------------------------------------------------------------------ *
 * Process-global state
 * ------------------------------------------------------------------ */

const STATE_KEY = Symbol.for("dsh-remote-agent/state");

/**
 * A reload leaves the old route alive, so the handler must read the newest
 * generation's config through a slot both generations agree on rather than
 * through a module-scope closure. The port forwards are the same story: they
 * are children of the process, not of a generation, so they must not be
 * duplicated by a reload that re-registers the route.
 */
function state() {
  const existing = globalThis[STATE_KEY];
  if (existing !== undefined) return existing;
  const created = {
    handler: null,
    config: null,
    /** key `${alias}:${port}` -> { child, alias, port, startedAt, error } */
    tunnels: new Map(),
  };
  globalThis[STATE_KEY] = created;
  return created;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** POSIX single-quote quoting: the only place a value becomes shell syntax. */
function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(text) {
  return String(text ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
}

function clip(text, max = 400) {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Run a local executable; never throws, always answers with the outcome. */
function run(file, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error,
        });
      },
    );
  });
}

/**
 * One non-interactive SSH command.
 *
 * BatchMode and a strict host key are not decoration: the remote end of this
 * plugin's own web agent enables the same two settings, and an agent host that
 * can stop to ask for a password or a fingerprint is an agent host that hangs
 * a request instead of failing it.
 */
function ssh(alias, command, timeoutMs = 30_000) {
  return run(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=8",
      "--",
      alias,
      command,
    ],
    timeoutMs,
  );
}

/**
 * Wrap a script so it runs under the user's OWN login+interactive shell.
 *
 * This started as `bash -lc`, which looked obviously correct and was wrong. Agent
 * CLIs are routinely installed into directories that only the *interactive* rc
 * adds: on the reference machine `claude` lives in `~/.bun/bin`, and
 * `~/.opencode/bin` and `~/zakl_shell` are on that PATH too. `bash -lc` therefore
 * reported an installed `claude` as missing — a silent, confident lie, which is
 * the worst kind of wrong for a panel whose job is to say what is installed.
 *
 * `-i` matters as much as `-l`: PATH edits and aliases normally live in `.zshrc`,
 * which a non-interactive shell never reads.
 *
 * The price is that the rc may print banners (`WSL ip … ssh:running` on the
 * reference machine). Every consumer here parses `key=value` lines out of stdout
 * and ignores everything else, which is exactly why that parser is lenient.
 */
function remoteShell(script, shell = '"$SHELL"') {
  return `exec ${shell} -lic ${shq(script)}`;
}

/** `key=value` lines, split on the first `=`. Values may contain anything else. */
function parseLines(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    map.set(line.slice(0, at), line.slice(at + 1));
  }
  return map;
}

/**
 * Decode a `key=value` line that carried a multi-line value. 0x1e is the ASCII
 * record separator: it cannot appear in a text log, so it survives the round
 * trip without a JSON encoder in the remote shell. The encoding side is `tr`
 * inside the remote script, not a function here.
 */
function decodeLines(text) {
  return String(text ?? "").replaceAll("\u001e", "\n");
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

function normalizeWeb(raw) {
  // `stateDir` is a single remote path segment, so a leading dot is legal here
  // even though it is not for an agent id — the default value starts with one.
  const stateDir =
    typeof raw?.stateDir === "string" && RX_SEGMENT.test(raw.stateDir) ? raw.stateDir : DEFAULT_STATE_DIR;
  const startTimeoutMs =
    Number.isInteger(raw?.startTimeoutMs) && raw.startTimeoutMs > 0 ? raw.startTimeoutMs : DEFAULT_START_TIMEOUT_MS;
  const healIntervalMs =
    Number.isInteger(raw?.healIntervalMs) && raw.healIntervalMs >= 0 ? raw.healIntervalMs : DEFAULT_HEAL_INTERVAL_MS;
  return { stateDir, startTimeoutMs, healIntervalMs };
}

/**
 * Drop anything that could not be executed safely, and say what was dropped.
 * Silently accepting a malformed row would surface later as "the button does
 * nothing", which is the worst possible failure for a remote-control panel.
 */
function normalizeConfig(raw) {
  const problems = [];
  const hosts = [];
  const hostRows = Array.isArray(raw?.hosts) ? raw.hosts : [];
  if (hostRows.length === 0) problems.push("config.hosts is empty — nothing to manage");

  for (const [index, row] of hostRows.entries()) {
    const alias = typeof row?.alias === "string" ? row.alias.trim() : "";
    if (!RX_ALIAS.test(alias)) {
      problems.push(`hosts[${index}]: "alias" must match ${RX_ALIAS} (got ${JSON.stringify(row?.alias ?? null)})`);
      continue;
    }
    const label =
      typeof row?.label === "string" && row.label.trim() !== "" ? row.label.trim() : alias;

    const agents = [];
    for (const [agentIndex, agentRow] of (Array.isArray(row?.agents) ? row.agents : []).entries()) {
      const where = `hosts[${index}].agents[${agentIndex}]`;
      const id = typeof agentRow?.id === "string" ? agentRow.id.trim() : "";
      if (!RX_ID.test(id)) {
        problems.push(`${where}: "id" must match ${RX_ID}`);
        continue;
      }
      const kind = agentRow?.kind;
      if (kind !== "web" && kind !== "tty") {
        problems.push(`${where}: "kind" must be "web" or "tty"`);
        continue;
      }
      const agentLabel =
        typeof agentRow?.label === "string" && agentRow.label.trim() !== "" ? agentRow.label.trim() : id;

      if (kind === "tty") {
        const command = typeof agentRow?.command === "string" ? agentRow.command.trim() : "";
        if (!RX_COMMAND.test(command)) {
          problems.push(`${where}: tty "command" must be a bare executable name matching ${RX_COMMAND}`);
          continue;
        }
        agents.push({ id, kind, label: agentLabel, command });
        continue;
      }

      const port = Number.isInteger(agentRow?.port) ? agentRow.port : DEFAULT_PORT;
      if (!(port > 0 && port < 65536)) {
        problems.push(`${where}: "port" must be 1..65535`);
        continue;
      }
      const bin = typeof agentRow?.bin === "string" ? agentRow.bin.trim() : "";
      const dshHome = typeof agentRow?.dshHome === "string" ? agentRow.dshHome.trim() : "";
      if (!RX_ABS_PATH.test(bin)) {
        problems.push(`${where}: web "bin" must be an absolute remote path`);
        continue;
      }
      if (!RX_ABS_PATH.test(dshHome)) {
        problems.push(`${where}: web "dshHome" must be an absolute remote path`);
        continue;
      }
      const profile = typeof agentRow?.profile === "string" ? agentRow.profile.trim() : "";
      if (!RX_ID.test(profile)) {
        problems.push(`${where}: web "profile" must match ${RX_ID}`);
        continue;
      }
      agents.push({ id, kind, label: agentLabel, port, bin, dshHome, profile });
    }

    hosts.push({ alias, label, agents });
  }

  return { hosts, web: normalizeWeb(raw?.web), problems };
}

function findHost(cfg, alias) {
  if (typeof alias !== "string") return null;
  return cfg.hosts.find((host) => host.alias === alias) ?? null;
}

function findAgent(host, id) {
  if (typeof id !== "string") return null;
  return host.agents.find((agent) => agent.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * Remote scripts
 * ------------------------------------------------------------------ *
 * Every script is generated from validated identifiers only, so nothing here
 * needs to defend against a hostile value — the values cannot reach it.
 */

/**
 * Remote state paths, spelled so `$HOME` still expands.
 *
 * This is the subtle one: `shq` exists to stop expansion, so quoting the whole
 * path would make the remote shell look for a literal directory named `$HOME`.
 * The home anchor therefore stays outside the quotes and only the validated
 * literal parts are quoted — `"$HOME"/'.dsh-remote-agent'/'x.pid'`.
 */
function remotePaths(web, agentId) {
  const head = `"$HOME"/${shq(web.stateDir)}`;
  return {
    dir: head,
    pid: `${head}/${shq(`${agentId}.pid`)}`,
    log: `${head}/${shq(`${agentId}.log`)}`,
  };
}

/** One SSH round trip per host: reachability, liveness, token, availability. */
function statusScript(host, web) {
  const lines = [`echo "host=ok"`, `echo "home=$HOME"`];
  for (const agent of host.agents) {
    const { pid: pidFile, log: logFile } = remotePaths(web, agent.id);
    if (agent.kind === "tty") {
      lines.push(`echo "${agent.id}.which=$(command -v ${agent.command} 2>/dev/null || true)"`);
      continue;
    }
    lines.push(
      `if [ -x ${shq(agent.bin)} ]; then echo "${agent.id}.bin=1"; else echo "${agent.id}.bin=0"; fi`,
      `pid=$(cat ${pidFile} 2>/dev/null || true)`,
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "${agent.id}.alive=1"; echo "${agent.id}.pid=$pid"; else echo "${agent.id}.alive=0"; fi`,
      `if [ -f ${logFile} ]; then`,
      `  tk=$(grep -o 'token=[A-Za-z0-9._-]*' ${logFile} 2>/dev/null | tail -1 | cut -d= -f2)`,
      `  [ -n "$tk" ] && echo "${agent.id}.token=$tk"`,
      `  echo "${agent.id}.log=$(tail -n 3 ${logFile} 2>/dev/null | tr '\\n' '\\036')"`,
      `fi`,
      `if command -v ss >/dev/null 2>&1; then`,
      `  if ss -ltn 2>/dev/null | grep -q ":${agent.port} "; then echo "${agent.id}.listen=1"; else echo "${agent.id}.listen=0"; fi`,
      `fi`,
    );
  }
  return lines.join("\n");
}

/**
 * The probe op: what a login shell can actually reach on that machine.
 *
 * It runs under `bash -lc` on purpose. A non-interactive ssh command gets the
 * bare system PATH, so an agent installed under `~/.local/bin` looks missing —
 * and "looks missing" is the difference between offering a launch button and
 * hiding one.
 */
function probeScript(host) {
  const lines = [`echo "path=$PATH"`, `echo "shell=$SHELL"`];
  const wanted = new Set(PROBE_COMMANDS);
  for (const agent of host.agents) {
    if (agent.kind === "tty") wanted.add(agent.command);
  }
  for (const command of wanted) {
    lines.push(`echo "cmd.${command}=$(command -v ${command} 2>/dev/null || true)"`);
  }
  for (const agent of host.agents) {
    if (agent.kind !== "web") continue;
    lines.push(`if [ -x ${shq(agent.bin)} ]; then echo "bin.${agent.id}=1"; else echo "bin.${agent.id}=0"; fi`);
  }
  return lines.join("\n");
}

/**
 * Start the remote server and wait for its token in the same round trip.
 *
 * The token is only ever printed once, on stdout, at boot — there is no flag to
 * mint one later — so the log file is the durable source of truth and this loop
 * is what turns "started" into "usable".
 */
function startScript(agent, web, timeoutMs) {
  const { dir, pid: pidFile, log: logFile } = remotePaths(web, agent.id);
  const attempts = Math.max(1, Math.ceil(timeoutMs / 500));
  return [
    `state=${dir}`,
    `mkdir -p "$state"`,
    `pid=$(cat ${pidFile} 2>/dev/null || true)`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then`,
    `  echo "already=1"; echo "pid=$pid"`,
    `else`,
    `  : > ${logFile}`,
    `  cd ${shq(agent.dshHome)} || exit 3`,
    // No `setsid`: it can fork, which would make `$!` a short-lived parent and
    // poison the pid file. Plain `nohup ... &` was measured to outlive the ssh
    // session on this target, and it keeps `$!` equal to the server's real pid.
    `  DSH_HOME=${shq(agent.dshHome)} nohup ${shq(agent.bin)} ${shq(agent.profile)} --port ${agent.port} --no-open >> ${logFile} 2>&1 < /dev/null &`,
    `  started=$!`,
    `  echo "$started" > ${pidFile}`,
    `  echo "already=0"; echo "pid=$started"`,
    `fi`,
    `tk=""`,
    `i=0`,
    `while [ $i -lt ${attempts} ]; do`,
    `  tk=$(grep -o 'token=[A-Za-z0-9._-]*' ${logFile} 2>/dev/null | tail -1 | cut -d= -f2)`,
    `  [ -n "$tk" ] && break`,
    `  i=$((i+1))`,
    `  sleep 0.5`,
    `done`,
    `echo "token=$tk"`,
    `echo "log=$(tail -n 5 ${logFile} 2>/dev/null | tr '\\n' '\\036')"`,
  ].join("\n");
}

function stopScript(agent, web) {
  const { pid: pidFile } = remotePaths(web, agent.id);
  return [
    `pid=$(cat ${pidFile} 2>/dev/null || true)`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then`,
    `  kill "$pid" 2>/dev/null || true`,
    `  i=0`,
    `  while [ $i -lt 20 ] && kill -0 "$pid" 2>/dev/null; do i=$((i+1)); sleep 0.25; done`,
    `  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi`,
    `  echo "stopped=1"; echo "pid=$pid"`,
    `else`,
    `  echo "stopped=0"`,
    `fi`,
    `rm -f ${pidFile}`,
  ].join("\n");
}

function logsScript(agent, web, lines) {
  const { log: logFile } = remotePaths(web, agent.id);
  const count = Number.isInteger(lines) && lines > 0 && lines <= 2000 ? lines : 200;
  return [`if [ -f ${logFile} ]; then tail -n ${count} ${logFile}; else echo "(no log yet)"; fi`].join("\n");
}

/* ------------------------------------------------------------------ *
 * Local port forwards
 * ------------------------------------------------------------------ */

function tunnelKey(alias, port) {
  return `${alias}:${port}`;
}

/**
 * Is something already listening on this local port?
 *
 * Checked BEFORE spawning, because `-L` with a taken port fails inside ssh
 * where the message is easy to lose, and because the alternative reading —
 * "it is probably our own forward" — is exactly how a stale forward from a
 * previous generation turns into a silent mismatch.
 */
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (busy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function tunnelRecord(alias, port) {
  return state().tunnels.get(tunnelKey(alias, port)) ?? null;
}

function tunnelAlive(record) {
  return record !== null && record.child.exitCode === null && record.child.signalCode === null;
}

/**
 * One forward per `alias:port`, reused across calls and generations.
 *
 * `ServerAliveInterval`/`CountMax` matter more here than in a one-shot ssh: a
 * forward is supposed to sit idle for hours, and an idle TCP connection through
 * a jump host is exactly the thing that gets reaped without either end
 * noticing.
 */
async function ensureTunnel(alias, port) {
  const existing = tunnelRecord(alias, port);
  if (tunnelAlive(existing)) return { ok: true, reused: true };

  if (existing !== null) state().tunnels.delete(tunnelKey(alias, port));

  if (await portBusy(port)) {
    return {
      ok: false,
      error:
        `local port ${port} is already in use, so the forward cannot bind. ` +
        `The local port must equal the remote port (the auth cookie's authority is 127.0.0.1:${port}), ` +
        `so free that port or change the agent's "port" on both ends.`,
    };
  }

  const child = spawn(
    "ssh",
    [
      "-N",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-L", `${port}:127.0.0.1:${port}`,
      "--",
      alias,
    ],
    { stdio: "ignore" },
  );

  const record = { child, alias, port, startedAt: Date.now(), error: null };
  child.once("exit", (code, signal) => {
    record.error = `forward exited (code ${code ?? "null"}, signal ${signal ?? "null"})`;
  });
  child.once("error", (error) => {
    record.error = clip(error?.message ?? error, 200);
  });
  state().tunnels.set(tunnelKey(alias, port), record);

  // `ssh -N` reports startup failure on its own exit rather than on spawn, so
  // the only honest readiness signal is the local port accepting.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await delay(250);
    if (await portBusy(port)) return { ok: true, reused: false };
    if (record.child.exitCode !== null || record.child.signalCode !== null) break;
  }
  state().tunnels.delete(tunnelKey(alias, port));
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  return { ok: false, error: record.error ?? `forward to ${alias}:${port} did not come up` };
}

function closeTunnel(alias, port) {
  const key = tunnelKey(alias, port);
  const record = state().tunnels.get(key);
  if (record === undefined) return false;
  state().tunnels.delete(key);
  try {
    record.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  return true;
}

function closeAllTunnels() {
  for (const key of [...state().tunnels.keys()]) {
    const [alias, portText] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
    closeTunnel(alias, Number(portText));
  }
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

function ttyCommand(alias, command) {
  // Same reason as `remoteShell`: `bash -lc` would not find a CLI that only the
  // interactive rc puts on PATH, so `ssh -t host "bash -lc 'exec claude'"` fails
  // for exactly the tool this plugin exists to reach. Single-quoting the remote
  // command keeps the whole thing paste-able into a local shell unchanged.
  return `ssh -t ${alias} ${shq(`exec "$SHELL" -lic "exec ${command}"`)}`;
}

function webUrl(port, token) {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

function describeUnreachable(host) {
  return host.agents.map((agent) => ({
    ...baseAgent(host, agent),
    available: null,
    state: "unknown",
    tunnel: agent.kind === "web" ? "down" : "n/a",
    logTail: null,
  }));
}

function baseAgent(host, agent) {
  if (agent.kind === "tty") {
    return {
      id: agent.id,
      label: agent.label,
      kind: "tty",
      command: agent.command,
      ttyCommand: ttyCommand(host.alias, agent.command),
    };
  }
  return {
    id: agent.id,
    label: agent.label,
    kind: "web",
    port: agent.port,
  };
}

function describeAgent(host, agent, map) {
  const base = baseAgent(host, agent);
  if (agent.kind === "tty") {
    const which = map.get(`${agent.id}.which`) ?? "";
    return {
      ...base,
      available: which !== "",
      state: "unknown",
      tunnel: "n/a",
      pid: null,
      logTail: null,
    };
  }

  const alive = map.get(`${agent.id}.alive`) === "1";
  const pid = Number(map.get(`${agent.id}.pid`) ?? 0) || null;
  const token = map.get(`${agent.id}.token`) || null;
  const hasBin = map.get(`${agent.id}.bin`) === "1";
  const tunnel = tunnelAlive(tunnelRecord(host.alias, agent.port)) ? "up" : "down";
  const logTail = map.has(`${agent.id}.log`) ? decodeLines(map.get(`${agent.id}.log`)) : null;

  return {
    ...base,
    available: hasBin,
    state: alive ? "running" : "stopped",
    pid: alive ? pid : null,
    token,
    // A stopped server leaves its last token in the log, and that token still
    // parses — it just cannot be reached. Publishing a URL for it would put a
    // working-looking button in front of a dead server.
    url: token === null || !alive ? null : webUrl(agent.port, token),
    tunnel,
    logTail,
    hint: hasBin ? undefined : `remote executable missing: ${agent.bin}`,
  };
}

async function opOverview(cfg) {
  const hosts = [];
  for (const host of cfg.hosts) {
    const result = await ssh(host.alias, remoteShell(statusScript(host, cfg.web)), 20_000);
    if (result.code !== 0 || !result.stdout.includes("host=ok")) {
      hosts.push({
        alias: host.alias,
        label: host.label,
        reachable: false,
        error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`),
        agents: describeUnreachable(host),
      });
      continue;
    }
    const map = parseLines(result.stdout);
    hosts.push({
      alias: host.alias,
      label: host.label,
      reachable: true,
      agents: host.agents.map((agent) => describeAgent(host, agent, map)),
    });
  }
  return { ok: true, generatedAt: Date.now(), hosts, problems: cfg.problems };
}

async function opProbe(cfg, host) {
  const result = await ssh(host.alias, remoteShell(probeScript(host)), 20_000);
  if (result.code !== 0) {
    return { ok: false, error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`) };
  }
  const map = parseLines(result.stdout);
  const found = {};
  for (const command of PROBE_COMMANDS) {
    const value = map.get(`cmd.${command}`) ?? "";
    found[command] = value === "" ? null : value;
  }
  for (const agent of host.agents) {
    if (agent.kind !== "tty") continue;
    const value = map.get(`cmd.${agent.command}`);
    if (value !== undefined) found[agent.command] = value === "" ? null : value;
  }
  return {
    ok: true,
    host: host.alias,
    // Named for what it is: the PATH that decides whether a CLI is reachable.
    // Probing it with a non-interactive shell is what produced the wrong answer
    // this field now exists to make debuggable.
    loginPath: map.get("path") ?? "",
    interactiveShell: map.get("shell") ?? "",
    found,
  };
}

async function opStart(cfg, host, agent) {
  if (agent.kind !== "web") {
    return { ok: false, error: `start is only meaningful for a "web" agent; ${agent.id} is "${agent.kind}"` };
  }
  const result = await ssh(
    host.alias,
    remoteShell(startScript(agent, cfg.web, cfg.web.startTimeoutMs)),
    cfg.web.startTimeoutMs + 20_000,
  );
  if (result.code !== 0) {
    return { ok: false, error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`) };
  }
  const map = parseLines(result.stdout);
  const token = map.get("token") ?? "";
  const pid = Number(map.get("pid") ?? 0) || null;
  const logTail = map.has("log") ? decodeLines(map.get("log")) : null;
  if (token === "") {
    return {
      ok: false,
      error:
        `remote dsh web started but printed no token within ${cfg.web.startTimeoutMs} ms. ` +
        `Remote log tail: ${clip((logTail ?? "").replaceAll("\n", " / "), 300)}`,
    };
  }

  const tunnel = await ensureTunnel(host.alias, agent.port);
  if (!tunnel.ok) {
    return { ok: false, error: clip(tunnel.error), port: agent.port, token, pid, logTail };
  }
  return { ok: true, url: webUrl(agent.port, token), token, port: agent.port, pid, logTail };
}

async function opStop(cfg, host, agent) {
  if (agent.kind !== "web") {
    return { ok: false, error: `stop is only meaningful for a "web" agent; ${agent.id} is "${agent.kind}"` };
  }
  const result = await ssh(host.alias, remoteShell(stopScript(agent, cfg.web)), 25_000);
  const closed = closeTunnel(host.alias, agent.port);
  if (result.code !== 0) {
    return { ok: false, error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`) };
  }
  const map = parseLines(result.stdout);
  return { ok: true, stopped: map.get("stopped") === "1", pid: Number(map.get("pid") ?? 0) || null, tunnelClosed: closed };
}

/**
 * Read the token that is already in the remote log and make sure the forward
 * exists. Deliberately does NOT restart anything: "open it again" must not
 * cost the person their running session.
 */
async function opUrl(cfg, host, agent) {
  if (agent.kind !== "web") {
    return { ok: false, error: `url is only meaningful for a "web" agent; ${agent.id} is "${agent.kind}"` };
  }
  const result = await ssh(host.alias, remoteShell(statusScript(host, cfg.web)), 20_000);
  if (result.code !== 0) {
    return { ok: false, error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`) };
  }
  const map = parseLines(result.stdout);
  const token = map.get(`${agent.id}.token`) ?? "";
  const alive = map.get(`${agent.id}.alive`) === "1";
  // Liveness first: the log outlives the process, so a token left over from an
  // earlier run is a trap that answers "here is your URL" for a dead server.
  if (!alive) {
    return { ok: false, error: "the remote server is not running — start it first" };
  }
  if (token === "") {
    return { ok: false, error: "the remote server is running but its log holds no token yet — try again in a moment" };
  }
  const tunnel = await ensureTunnel(host.alias, agent.port);
  if (!tunnel.ok) return { ok: false, error: clip(tunnel.error), port: agent.port, token };
  return { ok: true, url: webUrl(agent.port, token), token, port: agent.port };
}

async function opLogs(cfg, host, agent, lines) {
  const result = await ssh(host.alias, remoteShell(logsScript(agent, cfg.web, lines)), 20_000);
  if (result.code !== 0) {
    return { ok: false, error: clip(result.stderr || result.stdout || `ssh exited ${result.code}`) };
  }
  return { ok: true, log: result.stdout };
}

async function dispatch(cfg, payload) {
  const op = typeof payload?.op === "string" ? payload.op : "";
  if (!OPS.includes(op)) return { ok: false, error: `unknown op: ${op}`, supported: OPS };
  if (op === "overview") return opOverview(cfg);

  const host = findHost(cfg, payload?.host);
  if (host === null) {
    return { ok: false, error: `unknown host: ${String(payload?.host ?? "")}`, supported: cfg.hosts.map((h) => h.alias) };
  }
  // `probe` asks about the machine, not about one agent on it, so it must be
  // answered before the agent is resolved.
  if (op === "probe") return opProbe(cfg, host);

  const agent = findAgent(host, payload?.agent);
  if (agent === null) {
    return { ok: false, error: `unknown agent: ${String(payload?.agent ?? "")}`, supported: host.agents.map((a) => a.id) };
  }

  switch (op) {
    case "start":
    case "restart":
      if (op === "restart") await opStop(cfg, host, agent);
      return opStart(cfg, host, agent);
    case "stop":
      return opStop(cfg, host, agent);
    case "url":
      return opUrl(cfg, host, agent);
    case "logs":
      return opLogs(cfg, host, agent, payload?.lines);
    default:
      return { ok: false, error: `unhandled op: ${op}`, supported: OPS };
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function apply(ctx, config) {
  const normalized = normalizeConfig(config);
  const store = state();
  store.config = normalized;
  store.handler = (payload) => dispatch(store.config, payload);

  // A dropped config row is worth reporting, but a logging channel that is not
  // reachable must never be the reason the plugin fails to activate.
  for (const problem of normalized.problems) {
    try {
      ctx.logger?.warn?.(`dsh-remote-agent: ${problem}`);
    } catch {
      /* no logger here; the problem is still reflected in `overview.problems` */
    }
  }

  /**
   * Publish the machines this window can reach.
   *
   * A machine has to be declared in exactly one place. This is that place: this
   * plugin is the one whose job is remote machines, and its hosts already carry
   * each alias, label and remote `dshHome`. `dsh-session-hub` reads the same
   * machines' session stores, and folds what is published here into its
   * environment switcher — so adding a host below makes it appear there too,
   * instead of the same alias being written down twice and drifting apart.
   *
   * A method, not a snapshot: a config reload replaces this value with a new
   * service, but within one generation the answer should read the live config.
   */
  ctx.provide("remoteHosts", {
    list: () =>
      normalized.hosts.map((host) => ({
        alias: host.alias,
        label: host.label,
        // The one fact a remote reader cannot always probe correctly: the
        // reference machine keeps its DSH home outside the default location.
        dshHome: host.agents.find((agent) => agent.kind === "web")?.dshHome ?? null,
      })),
    problems: () => [...normalized.problems],
  });

  ctx.effect(() => {
    let dispose = null;
    try {
      dispose = ctx.connection.fetch.register({
        path: ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let payload = {};
          try {
            payload = await request.json();
          } catch {
            payload = {};
          }
          // Read the handler at call time: this route may outlive the
          // generation that registered it.
          const handler = state().handler;
          if (handler === null) return json({ ok: false, error: "remote-agent is not active" }, 503);
          try {
            return json(await handler(payload));
          } catch (error) {
            return json({ ok: false, error: String(error?.message ?? error) }, 500);
          }
        },
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes("already registered")) throw error;
      // Left behind by an older generation; the global slot covers it.
    }

    return () => {
      try {
        if (typeof dispose === "function") dispose();
      } catch {
        /* Already gone. */
      }
    };
  }, "remote-agent: /api route");

  /**
   * Keep forwards alive.
   *
   * `ssh -N` through a jump host dies quietly, and a dead forward looks exactly
   * like a healthy remote server from the panel's point of view — the state
   * badge says "running" while the browser 404s. Re-establishing only forwards
   * this process had already opened keeps the timer from reaching out to hosts
   * nobody asked about.
   */
  ctx.effect(() => {
    const interval = normalized.web.healIntervalMs;
    // Cordis throws on `ctx.timer` unless "timer" is injected, so the optional
    // accessor is the only correct way to ask "is there a timer service here?".
    // Declaring it in `inject` instead would make the whole plugin refuse to
    // activate on a composition without one, which is far too strong a demand
    // for a keep-alive nicety.
    const timers = typeof ctx.get === "function" ? ctx.get("timer") : undefined;
    if (!(interval > 0) || typeof timers?.interval !== "function") return () => {};
    return timers.interval(() => {
      for (const record of [...state().tunnels.values()]) {
        if (tunnelAlive(record)) continue;
        const key = tunnelKey(record.alias, record.port);
        state().tunnels.delete(key);
        void ensureTunnel(record.alias, record.port);
      }
    }, interval);
  }, "remote-agent: forward keep-alive");

  /**
   * The forwards are children of the process, but this cleanup is per
   * generation: on reload the old generation must not leave its ssh children
   * orphaned, since the next generation will not adopt them.
   */
  ctx.effect(() => () => closeAllTunnels(), "remote-agent: forward teardown");
}

/** Exported for tests: pure helpers that do not touch the network. */
export const __test = {
  normalizeConfig,
  parseLines,
  shq,
  ttyCommand,
  webUrl,
  statusScript,
  startScript,
  stopScript,
  probeScript,
  logsScript,
  decodeLines,
};
