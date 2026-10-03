/**
 * dsh-session-hub — how to *use* one machine.
 *
 * `store.js` answered "where are the bytes". This answers "how do I do
 * something over there", and for the same reason: nothing above this file should
 * branch on whether the panel is pointed at this machine or another one.
 *
 * The split inside is deliberate, because "local vs remote" turns out to be two
 * different questions:
 *
 *   `exec` / `invocation` are about the **other** machine. Running a command
 *     there, and phrasing a command for a terminal here, genuinely differ.
 *
 *   Opening a window — a cmux workspace, Terminal, VS Code — is always about
 *     **this** machine. A host does not do that; it only says which cwd and
 *     which command the window should carry. That stays in `index.js`, because
 *     it is the one part of "open a session" that cannot be remote.
 *
 * A host is built once per environment and reused, so switching back and forth
 * does not tear down the ssh connection multiplexing underneath it.
 *
 * @module dsh-session-hub/host
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { createRemoteStore, localStore } from "./store.js";
import { shq, sshExec } from "./ssh.js";
import { localHome } from "./shared.js";

/**
 * One process as a machine reports it.
 *
 * @typedef {object} ProcessRow
 * @property {number} pid
 * @property {string} etime `ps` elapsed-time field, as printed.
 * @property {string} executable Basename of the command's first token.
 * @property {string} args Everything after it.
 */

/**
 * How to run one command on a machine, and what it can tell you about itself.
 *
 * @typedef {object} Host
 * @property {string} id
 * @property {"local"|"remote"} kind
 * @property {string} label
 * @property {object} store Byte access, from `store.js`.
 * @property {(script: string, options?: object) => Promise<{code: number, stdout: Buffer, stderr: string}>} exec
 *   Run a POSIX shell script on that machine. A non-zero exit is a result, not
 *   an exception.
 * @property {(command: string, options?: {cwd?: string|null}) => {cwd: string, command: string}} invocation
 *   How a terminal *here* must be asked to open something that lives *there*.
 * @property {() => Promise<ProcessRow[]>} processes What is running there.
 * @property {(pid: number|string) => Promise<string|null>} cwdOf One process's
 *   working directory there, which is how a session with no recorded id is
 *   matched to the run that is producing it.
 */

/**
 * Run a script through the local shell.
 *
 * A shell rather than an argv array, because that is exactly what the remote
 * implementation does — one way to say "run this" is the whole point of the
 * interface, and a local call that took argv would be a second dialect to keep
 * in step.
 */
function localExec(script, { timeoutMs = 20000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", script],
      { timeout: timeoutMs, maxBuffer, encoding: "buffer" },
      (error, stdout, stderr) => {
        // A string `code` means the process never ran (ENOENT, EACCES); a number
        // is just a non-zero exit, which callers treat as an answer.
        if (error !== null && error.code === undefined) return reject(error);
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
        });
      },
    );
  });
}

/**
 * The process table, as one command on every platform this runs on.
 *
 * Verified to print the same three fields with the same shapes on macOS and on
 * Linux, so there is no platform branch here — and `etime` is one of `MM:SS`,
 * `HH:MM:SS` or `DD-HH:MM:SS` on both.
 */
const PS_COMMAND = "ps -eo pid=,etime=,args= 2>/dev/null";

/**
 * Parse `ps` output into rows.
 *
 * `ps` prints ` <pid> <etime> <executable> <args…>`. The executable is taken
 * separately from the arguments because the caller matches on both: macOS
 * reports a shebang script as `/bin/sh /path/to/agent`, so the first token is
 * `sh` and matches nothing.
 *
 * @param {string} text
 * @returns {ProcessRow[]}
 */
export function parseProcesses(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, etime: match[2], executable: basename(match[3]), args: match[4] ?? "" });
  }
  return rows;
}

/**
 * One process's working directory, portably enough for both ends.
 *
 * `/proc` first, because it is free and present on the machines this connects
 * to; `lsof` after, because macOS has no `/proc`. The `-d /proc/self` test is
 * about the *filesystem*, not the target process — `[ -e /proc/1/cwd ]` is false
 * for a normal user even on Linux, and branching on that would send every
 * request down the `lsof` path.
 */
function cwdScript(pid) {
  const id = Number(pid);
  return [
    `p=${id}`,
    `out=""`,
    `[ -d /proc/self ] && out=$(readlink "/proc/$p/cwd" 2>/dev/null)`,
    `[ -z "$out" ] && out=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)`,
    `printf '%s\\n' "$out"`,
  ].join("\n");
}

/** Read the one path a `cwdScript` run prints, or null. */
function firstPath(text) {
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim().replace(/ \(deleted\)$/, "");
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/** This machine, as a host. */
export const localHost = {
  id: "local",
  kind: "local",
  label: "本机",
  store: localStore,
  exec: localExec,
  invocation(command, { cwd } = {}) {
    // A local terminal can be started in the project itself. A path that is not
    // one — or none at all — falls back to the home directory rather than
    // handing `cd` something it will refuse.
    const start = typeof cwd === "string" && cwd.startsWith("/") ? cwd : localHome();
    return { cwd: start, command };
  },
  async processes() {
    const { stdout } = await localExec(PS_COMMAND, { timeoutMs: 8000, maxBuffer: 8 * 1024 * 1024 });
    return parseProcesses(stdout.toString("utf8"));
  },
  async cwdOf(pid) {
    const { code, stdout } = await localExec(cwdScript(pid), { timeoutMs: 5000, maxBuffer: 1024 * 1024 });
    return code === 0 ? firstPath(stdout.toString("utf8")) : null;
  },
};

/**
 * Another machine, as a host.
 *
 * @param {{id?: string, label?: string, alias: string}} environment
 * @returns {Host}
 */
export function createRemoteHost({ id, label, alias }) {
  return {
    id: id ?? alias,
    kind: "remote",
    label: label ?? alias,
    store: createRemoteStore({ alias, id: id ?? alias }),
    exec: (script, options) => sshExec(alias, script, options),
    /**
     * A terminal here runs an `ssh -t` that carries the command there.
     *
     * Two things have to happen on the far side, and both were bugs waiting to
     * be written the obvious way:
     *
     *   `cd`. The session's stored `cwd` is a path *there*. Running the command
     *   locally with a remote `cwd` at best fails, and at worst succeeds in a
     *   directory that happens to share the name.
     *
     *   A login shell. The agent binary has to be looked up by an **interactive**
     *   shell — `claude` sits in `~/.bun/bin`, which only a login rc puts on
     *   `PATH`. Through a non-interactive shell it is "command not found", which
     *   reads as "that agent is not installed on that machine".
     */
    invocation(command, { cwd } = {}) {
      const inner =
        typeof cwd === "string" && cwd.startsWith("/") ? `cd ${shq(cwd)} && exec ${command}` : `exec ${command}`;
      return { cwd: localHome(), command: `ssh -t ${shq(alias)} ${shq(`exec "$SHELL" -lic ${shq(inner)}`)}` };
    },
    async processes() {
      const { code, stdout } = await sshExec(alias, PS_COMMAND, { timeoutMs: 15000, maxBuffer: 16 * 1024 * 1024 });
      return code === 0 ? parseProcesses(stdout.toString("utf8")) : [];
    },
    async cwdOf(pid) {
      const { code, stdout } = await sshExec(alias, cwdScript(pid), { timeoutMs: 8000 });
      return code === 0 ? firstPath(stdout.toString("utf8")) : null;
    },
  };
}
