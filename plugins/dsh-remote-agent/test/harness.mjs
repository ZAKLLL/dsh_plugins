/**
 * End-to-end harness for the `dsh-remote-agent` Host half.
 *
 * Unlike a unit test, this one talks to the REAL machine: it captures the
 * route the plugin registers by handing `apply` a stub Context, then drives the
 * handler with real payloads over SSH. That is deliberate — the parts most
 * likely to be wrong here are the generated remote scripts and the port
 * forward, and neither is worth much against a mock.
 *
 *   node test/harness.mjs                  # read-only: overview + probe
 *   node test/harness.mjs --start          # + start the remote web UI and the forward
 *   node test/harness.mjs --start --stop   # + stop it again
 *
 * Requires: an SSH alias that works with BatchMode (no password prompt), and,
 * for --start, the remote `dsh` CLI plus a bootable profile. Edit `CONFIG` to
 * point at your target — it mirrors `cordis.patch.yml`.
 *
 * The `--stop` half is not optional housekeeping: a started server keeps
 * listening on the remote and a forward keeps holding the local port, so a
 * harness run that only starts would poison the next one.
 */

import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";

/**
 * Parse a shell command the way the person's shell will, by putting a fake `ssh`
 * on PATH that prints its argv.
 *
 * The generated `ttyCommand` is a string a human pastes into a terminal, so its
 * quoting IS the interface — and quoting bugs are invisible to assertions like
 * `includes("-lic")`. This turns "does it paste correctly" into something a test
 * can state: ssh must receive exactly three arguments, the third being one single
 * remote command.
 */
function argvOf(command) {
  const dir = mkdtempSync(join(tmpdir(), "dra-fake-ssh-"));
  const bin = join(dir, "ssh");
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do printf "ARG[%s]\\n" "$a"; done\n');
  chmodSync(bin, 0o755);
  const out = execFileSync("sh", ["-c", command], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith("ARG["))
    .map((line) => line.slice(4, -1));
}

const CONFIG = {
  web: { healIntervalMs: 30000 },
  hosts: [
    {
      alias: "pro14uu",
      label: "pro14",
      agents: [
        {
          id: "dsh",
          kind: "web",
          label: "DSH",
          port: 19391,
          bin: "/home/zakl/.dsh-runtime/node_modules/.bin/dsh",
          dshHome: "/home/zakl/.dsh",
          profile: "remote-web",
        },
        { id: "codex", kind: "tty", label: "Codex", command: "codex" },
        // The regression that matters most: this CLI is only on the PATH of the
        // INTERACTIVE shell, so a `bash -lc` probe reports it as missing.
        { id: "claude", kind: "tty", label: "Claude Code", command: "claude" },
      ],
    },
  ],
};

const argv = process.argv.slice(2);
const wantStart = argv.includes("--start");
const wantStop = argv.includes("--stop");

let failures = 0;
function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  // The detail explains a FAILURE; printing it on success reads as a false
  // alarm ("port chip missing" next to an [ok]) and trains the eye to ignore it.
  const suffix = condition || detail === "" ? "" : ` — ${detail}`;
  console.log(`  [${condition ? "ok  " : "FAIL"}] ${name}${suffix}`);
}

/* ---------------------------------------------------------------- *
 * Stub Context: hand `apply` the smallest surface it touches.
 * ---------------------------------------------------------------- */

/* A throwaway activation with NO timer service at all: reading `ctx.timer`
 * here would throw, and so would letting a missing timer skip the effect
 * incorrectly. The keep-alive is a nicety, never a requirement. */
{
  let captured = null;
  let thrown = null;
  try {
    apply(
      {
        connection: { fetch: { register: (definition) => ((captured = definition), () => {}) } },
        effect: (fn) => fn(),
        get timer() {
          throw new Error('cannot get property "timer" without inject');
        },
        get: () => undefined,
        provide: () => () => {},
        logger: { warn: () => {} },
      },
      CONFIG,
    );
  } catch (error) {
    thrown = error;
  }
  check(
    "activates when the timer service is absent",
    thrown === null && captured !== null,
    thrown?.message ?? "route not registered",
  );
}

let route = null;
const disposers = [];
const intervals = [];
/** Services this plugin published, so the contract can be asserted. */
const provided = new Map();

/**
 * Cordis THROWS when a service is read without being injected, so this stub
 * has to as well. A stub that politely returned `undefined` for `timer` would
 * have let the original `ctx.timer?.interval` bug sail through this harness —
 * which is exactly what happened in production.
 */
const ctx = {
  connection: {
    fetch: {
      register(definition) {
        route = definition;
        return () => {
          route = null;
        };
      },
    },
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  },
  get timer() {
    throw new Error('cannot get property "timer" without inject');
  },
  /** The optional accessor: the only correct way to ask whether one exists. */
  get(name) {
    if (name !== "timer") return undefined;
    return {
      interval: (fn, ms) => {
        intervals.push(ms);
        return () => {};
      },
    };
  },
  logger: { warn: (...args) => console.log("  [warn]", ...args) },
  /**
   * The service registry, as Cordis mixes it onto a real context.
   *
   * `provide` self-declares in Cordis and registers its own effect, so a stub
   * that recorded the value and returned a disposer is faithful enough to catch
   * a plugin that publishes under the wrong name.
   */
  provide(name, value) {
    provided.set(name, value);
    return () => provided.delete(name);
  },
};

apply(ctx, CONFIG);
if (route === null) {
  console.error("the plugin did not register its route");
  process.exit(1);
}
check(
  "keep-alive uses the timer service when it is reachable",
  intervals.length === 1 && intervals[0] === CONFIG.web.healIntervalMs,
  `interval(${intervals.join(",")})`,
);

/**
 * The machine list other plugins read.
 *
 * `dsh-session-hub` folds this into its environment switcher, so the shape is a
 * contract: an alias it can hand to `ssh`, a label to show, and the remote
 * `dshHome` that a bare probe gets wrong on a machine whose DSH home is not
 * `$HOME/.dsh`. A host with no web agent has no `dshHome` to report, and saying
 * `null` is how that is stated rather than guessed.
 */
{
  const service = provided.get("remoteHosts");
  check("publishes the machine list as a service", service !== undefined && typeof service.list === "function");
  const hosts = service.list();
  check("the published list is not empty", Array.isArray(hosts) && hosts.length > 0);
  const host = hosts[0];
  check(
    "a published host names the alias, a label and the remote dshHome",
    host.alias === CONFIG.hosts[0].alias &&
      host.label === CONFIG.hosts[0].label &&
      host.dshHome === CONFIG.hosts[0].agents.find((agent) => agent.kind === "web")?.dshHome,
    JSON.stringify(host),
  );
  check(
    "only the fields a remote reader needs are published",
    Object.keys(host).sort().join(",") === "alias,dshHome,label",
    Object.keys(host).join(","),
  );
}

async function call(body) {
  const response = await route.fetch(
    new Request("http://127.0.0.1/api/remote-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return response.json();
}

function cleanup() {
  for (const dispose of disposers.reverse()) {
    try {
      dispose();
    } catch {
      /* teardown must not mask a failure */
    }
  }
}

/* ---------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- *
 * Preconditions and teardown
 * ---------------------------------------------------------------- */

/*
 * A forward left behind by an interrupted run is the most confusing way this
 * harness can fail: the port is taken, `start` cannot bind, and half a dozen
 * unrelated checks fall over — which reads like the plugin is broken. Say the
 * precondition instead, with the command that clears it.
 */
{
  const port = CONFIG.hosts[0].agents[0].port;
  const busy = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
  if (busy) {
    console.error(
      `\nlocal port ${port} is already listening, so the forward cannot bind.\n` +
        `An interrupted run most likely left its tunnel behind — clear it with:\n` +
        `  lsof -nP -iTCP:${port} -sTCP:LISTEN   then   kill <pid>\n`,
    );
    process.exit(2);
  }
}

// `finally` covers the normal and throwing paths but not a signal, and a killed
// harness is exactly how an orphan tunnel gets created in the first place.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  console.log("\n1. overview (one SSH round trip per host)");
  const overview = await call({ op: "overview" });
  check("route answers ok", overview.ok === true, overview.error ?? "");
  const host = overview.hosts?.[0];
  check("host is reachable", host?.reachable === true, host?.error ?? "");
  const web = host?.agents?.find((a) => a.id === "dsh");
  const tty = host?.agents?.find((a) => a.id === "codex");
  check("web agent reports its remote binary present", web?.available === true);
  check("web agent reports a stopped server", web?.state === "stopped", `state=${web?.state}`);
  check("local forward is down before any start", web?.tunnel === "down");
  check("tty agent is available on the remote", tty?.available === true);
  const claude = host?.agents?.find((a) => a.id === "claude");
  check(
    "a CLI that only the interactive rc puts on PATH is still found",
    claude?.available === true,
    "probed with a non-interactive shell?",
  );
  check(
    "tty command is a one-shot ssh",
    typeof tty?.ttyCommand === "string" && tty.ttyCommand.startsWith("ssh -t pro14uu "),
    tty?.ttyCommand ?? "",
  );

  console.log("\n2. probe (login-shell PATH)");
  const probe = await call({ op: "probe", host: "pro14uu" });
  check("probe answers ok", probe.ok === true, probe.error ?? "");
  check("codex resolves under a login shell", typeof probe.found?.codex === "string", probe.found?.codex ?? "null");
  check("login PATH is reported", typeof probe.loginPath === "string" && probe.loginPath.includes("/usr/bin"));
  check(
    "the interactive shell is reported, not assumed",
    typeof probe.interactiveShell === "string" && probe.interactiveShell !== "",
    probe.interactiveShell ?? "missing",
  );
  check(
    "the tty command goes through the interactive shell",
    typeof tty?.ttyCommand === "string" && tty.ttyCommand.includes("-lic"),
    tty?.ttyCommand ?? "",
  );

  console.log("\n2b. the generated tty command is paste-able");
  {
    const argv = argvOf(claude?.ttyCommand ?? "");
    check("ssh receives exactly three arguments", argv.length === 3, JSON.stringify(argv));
    check(
      "the remote command stays ONE argument, quotes and all",
      argv[2] === 'exec "$SHELL" -lic "exec claude"',
      JSON.stringify(argv[2]),
    );
  }

  console.log("\n3. unknown targets are refused, not guessed");
  const badHost = await call({ op: "url", host: "nope", agent: "dsh" });
  check("unknown host refused", badHost.ok === false && /unknown host/.test(badHost.error));
  const badAgent = await call({ op: "url", host: "pro14uu", agent: "nope" });
  check("unknown agent refused", badAgent.ok === false && /unknown agent/.test(badAgent.error));
  const badOp = await call({ op: "launch" });
  check("unknown op refused", badOp.ok === false && Array.isArray(badOp.supported));

  console.log("\n4. url before start is refused with a useful reason");
  const early = await call({ op: "url", host: "pro14uu", agent: "dsh" });
  check("not-running is reported as such", early.ok === false && /not running/.test(early.error), early.error ?? "");

  if (!wantStart) {
    console.log("\n(read-only run; pass --start to exercise the remote web service)\n");
  } else {
    console.log("\n5. start (remote server + token + local forward)");
    const started = await call({ op: "start", host: "pro14uu", agent: "dsh" });
    check("start answers ok", started.ok === true, started.error ?? "");
    check("a token came back", typeof started.token === "string" && started.token.length > 8);
    check("a pid came back", Number.isInteger(started.pid) && started.pid > 0, `pid=${started.pid}`);
    check(
      "url points at the same local port as the remote one",
      started.url === `http://127.0.0.1:19391/?token=${started.token}`,
      started.url ?? "",
    );

    if (started.url) {
      // The whole point of the port rule: the token must be accepted through
      // the forward. A 401 here is the authority mismatch, not a stale token.
      const authorized = await fetch(started.url, { redirect: "manual" });
      check("the forwarded URL authorizes", authorized.status < 400, `HTTP ${authorized.status}`);
      const cookie = authorized.headers.get("set-cookie") ?? "";
      check("it issues an auth cookie", cookie.includes("dsh-auth"));
    }

    console.log("\n6. overview sees the running server, url reuses its token");
    const again = await call({ op: "overview" });
    const webAgain = again.hosts?.[0]?.agents?.find((a) => a.id === "dsh");
    check("state is now running", webAgain?.state === "running");
    check("forward is now up", webAgain?.tunnel === "up");
    const reused = await call({ op: "url", host: "pro14uu", agent: "dsh" });
    check("url reuses the same token", reused.ok === true && reused.token === started.token);

    console.log("\n7. logs");
    const logs = await call({ op: "logs", host: "pro14uu", agent: "dsh", lines: 20 });
    check("log is readable", logs.ok === true && logs.log.includes("token="), logs.error ?? "");

    if (wantStop) {
      console.log("\n8. stop");
      const stopped = await call({ op: "stop", host: "pro14uu", agent: "dsh" });
      check("stop answers ok", stopped.ok === true, stopped.error ?? "");
      check("the remote process was stopped", stopped.stopped === true);
      check("the local forward was closed", stopped.tunnelClosed === true);
      const after = await call({ op: "overview" });
      const webAfter = after.hosts?.[0]?.agents?.find((a) => a.id === "dsh");
      check("state is stopped again", webAfter?.state === "stopped");
      check("forward is down again", webAfter?.tunnel === "down");
      // The log keeps the last token after the process dies, so a stopped agent
      // must not advertise a URL at all.
      check("a stopped server advertises no url", webAfter?.url === null, String(webAfter?.url));
    } else {
      console.log("\n(server left running; pass --stop too, or the next run's forward will collide)");
    }
  }
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
