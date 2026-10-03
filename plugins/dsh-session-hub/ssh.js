/**
 * dsh-session-hub — talking to another machine over SSH.
 *
 * One place that knows how to build an `ssh` invocation, so the environment
 * probe and the remote store cannot drift apart in their timeouts, their
 * quoting, or their idea of what counts as a failure.
 *
 * Two properties are load-bearing and worth stating once:
 *
 *   Quoting. `ssh host sh -c <script>` does **not** work: `ssh` joins its
 *   arguments with spaces and the remote login shell re-splits them, so a script
 *   containing a space arrives as several words. The script is therefore quoted
 *   into a *single* remote word — `sh -c '<script>'` — and travels as one argv
 *   element to the local `ssh`.
 *
 *   Bytes. A session store can be zstd-framed, so stdout is collected as a
 *   Buffer with no encoding. A utf8-decoding helper here would silently corrupt
 *   every frame it touched.
 *
 * @module dsh-session-hub/ssh
 */

import { execFile } from "node:child_process";

/**
 * Quote one value for a POSIX shell, as a single word.
 *
 * Single quotes, with the one escape a single-quoted string cannot express:
 * a literal `'` closes the quote, emits an escaped quote, and reopens it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Options every invocation shares: no prompt, no banner, a bounded connect. */
const BASE_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR"];

/**
 * Reuse one connection for every call to the same machine.
 *
 * Not a nicety — the difference between usable and not. A fresh `ssh` pays a
 * handshake and an authentication round trip every time, measured at **1.34s**
 * to a machine on the local network; multiplexed, the same call is **0.24s**. An
 * inventory asks a couple of dozen questions, so that alone was the 47-second
 * first scan.
 *
 * `%C` is a hash of local host, remote host, port and user computed by ssh
 * itself, so two aliases reaching the same machine share a socket and two
 * contexts differing in any of those four do not. The socket lives in `/tmp`
 * rather than `~/.ssh`: this plugin has no business leaving files in a directory
 * the person curates.
 *
 * `ControlPersist` bounds how long an unused master survives, which is what
 * keeps a stale connection from outliving a network change. It is left to expire
 * rather than torn down explicitly — a live connection is also what makes the
 * next poll cheap, and 60 idle seconds is a fair price for that.
 */
const MULTIPLEX_OPTIONS = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/dsh-session-hub-%C",
  "-o",
  "ControlPersist=60",
];

/**
 * Run one command on a remote host and collect its output.
 *
 * A non-zero exit is a *result*, not an exception: probing an agent that is not
 * installed, or reading a file that is not there, both exit non-zero and both
 * are answers. Only a failure to start `ssh` at all rejects.
 *
 * @param {string} alias SSH host alias, exactly as `~/.ssh/config` names it.
 * @param {string} script The remote script, unquoted; this function quotes it.
 * @param {{timeoutMs?: number, maxBuffer?: number, login?: boolean}} [options]
 *   `login` wraps the script in `exec "$SHELL" -lic`, which is the only way to
 *   see a command that an interactive rc puts on PATH — `claude` at
 *   `~/.bun/bin/claude`, for instance. It costs a login shell and any noise the
 *   rc prints, so it is opt-in.
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string}>}
 */
export function sshExec(alias, script, { timeoutMs = 20000, maxBuffer = 256 * 1024 * 1024, login = false } = {}) {
  const command = login
    ? `exec "$SHELL" -lic ${shq(script)}`
    : `sh -c ${shq(script)}`;
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      [...BASE_OPTIONS, ...MULTIPLEX_OPTIONS, alias, command],
      { timeout: timeoutMs, maxBuffer, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error !== null && error.code === undefined) return reject(error);
        const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: buffer,
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
        });
      },
    );
  });
}

/** The same call, as text — for the probes and listings that are JSON or lines. */
export async function sshText(alias, script, options) {
  const { code, stdout, stderr } = await sshExec(alias, script, options);
  return { code, stdout: stdout.toString("utf8"), stderr };
}

/**
 * Wrap a script so its output is separable from anything a login rc prints.
 *
 * An interactive rc greets you: a motd, a version manager's banner, a `git`
 * status. None of that is the answer, and a probe that parsed it as one would
 * report a machine's home directory as the word "Welcome". Two identical
 * sentinels bracket the real payload, and only what lies between them is read.
 *
 * The payload runs in a **subshell**, which is not decoration. A probe script
 * ends in `exit 0` so that a missing agent store does not make the whole ssh
 * exit non-zero — and a bare `exit` would then terminate the shell before the
 * closing sentinel was ever printed, turning a perfectly good answer into
 * "no output". A subshell contains that exit and guarantees the sentinel lands.
 */
export function bracketed(script) {
  const mark = "__dsh_session_hub__";
  return { mark, command: `printf '\\n%s\\n' ${shq(mark)}; ( ${script} ); printf '\\n%s\\n' ${shq(mark)}` };
}

/** Extract what `bracketed()` wrapped, or null when the sentinels never arrived. */
export function unwrapBracketed(mark, stdout) {
  const first = stdout.indexOf(mark);
  if (first < 0) return null;
  const second = stdout.indexOf(mark, first + mark.length);
  if (second < 0) return null;
  return stdout.slice(first + mark.length, second).replace(/^\n+|\n+$/g, "");
}
