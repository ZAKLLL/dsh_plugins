/**
 * dsh-session-hub — where a session store's bytes actually come from.
 *
 * Everything above this file asks questions in paths and gets bytes back. It
 * never learns whether the answer came from this machine's disk or from another
 * machine over SSH. That is the whole point: the six adapters under `./sources/`
 * are pure folds over parsed events, so pointing them at a remote store costs
 * one module here and zero dialect code there.
 *
 * A store is deliberately *small*. It only covers the session stores themselves:
 *
 *   walk / stat / readHead / readAt / readTail / readFile / remove / writeText
 *
 * Everything else the Host touches — pins, the hook spool, the process table,
 * the `code` CLI, the scratch directory a transcript is dumped into — is about
 * *this* machine and stays local. A plugin that mixed those into the store would
 * be claiming it could open a remote project in a local editor.
 *
 * Two shapes answer the same interface:
 *
 *   localStore   node:fs, the only implementation that can be byte-exact.
 *   remoteStore  one `ssh` invocation per operation, or per *batch* — see
 *                `statMany` / `readHeads`, which exist because an inventory of
 *                a few thousand rollouts would otherwise be a few thousand
 *                round trips.
 *
 * @module dsh-session-hub/store
 */

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shq, sshExec } from "./ssh.js";

/**
 * @typedef {object} StoreStats
 * @property {number} size Bytes.
 * @property {number} mtimeMs
 * @property {number} [birthtimeMs]
 */

/**
 * One file's head, and whether the cap cut it short.
 *
 * @typedef {object} Head
 * @property {string} text
 * @property {boolean} filled False when the file ended before the cap.
 */

/**
 * A batch read request, for a store that can answer many files at once.
 *
 * @typedef {object} HeadRequest
 * @property {string} path
 * @property {number} bytes
 */

/**
 * The contract. `statMany` and `readHeads` are optional: a store without them
 * is simply asked one file at a time, which is correct but slow.
 *
 * @typedef {object} Store
 * @property {"local"|"remote"} kind
 * @property {string} id
 * @property {(root: string, match: (path: string, name: string) => boolean, options?: object) => Promise<string[]>} walk
 * @property {(path: string) => Promise<StoreStats>} stat
 * @property {(path: string, bytes: number) => Promise<Head>} readHead
 * @property {(path: string, offset: number, length: number) => Promise<Buffer>} readAt
 * @property {(path: string, bytes: number, stats?: StoreStats) => Promise<{buffer: Buffer, fromStart: boolean}>} readTail
 * @property {(path: string) => Promise<Buffer>} readFile
 * @property {(path: string, options: {recursive: boolean}) => Promise<void>} remove
 * @property {(path: string, text: string) => Promise<void>} writeText
 * @property {(from: string, to: string) => Promise<void>} move Rename a file.
 *   Exists so a rewrite-through-temp-file keeps its atomicity: an interrupted
 *   `writeText` over a live index truncates it, a rename cannot.
 * @property {(paths: string[]) => Promise<Map<string, StoreStats|null>>} [statMany]
 * @property {(requests: HeadRequest[]) => Promise<Map<string, Head>>} [readHeads]
 */

/* ------------------------------------------------------------------ *
 * Local — this machine's disk
 * ------------------------------------------------------------------ */

/**
 * Read at most `bytes` from the head of a file, looping over short reads.
 *
 * The loop is not decoration: a single `read` may return less than asked for,
 * and the callers use `filled` to decide whether they saw the whole file.
 */
async function localReadHead(path, bytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    let total = 0;
    while (total < bytes) {
      const { bytesRead } = await handle.read(buffer, total, bytes - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return { text: buffer.subarray(0, total).toString("utf8"), filled: total >= bytes };
  } finally {
    await handle.close();
  }
}

/** Read exactly `length` bytes at `offset`; a short read returns what there is. */
async function localReadAt(path, offset, length) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/**
 * Recursively collect matching files under `root`, bounded on both axes.
 *
 * Breadth-first on purpose: a store that keeps its newest sessions shallowly
 * still answers even when a deep archive would blow the file budget.
 */
async function localWalk(root, match, { maxFiles = 4000, maxDepth = 8 } = {}) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: path, depth: depth + 1 });
      } else if (entry.isFile() && match(path, entry.name)) {
        found.push(path);
      }
    }
  }
  return found;
}

/** @type {Store} */
export const localStore = {
  kind: "local",
  id: "local",
  walk: localWalk,
  stat: (path) => stat(path),
  readHead: localReadHead,
  readAt: localReadAt,
  async readTail(path, bytes, stats) {
    const size = (stats ?? (await stat(path))).size;
    const from = Math.max(0, size - bytes);
    const buffer = await localReadAt(path, from, size - from);
    return { buffer, fromStart: from === 0 };
  },
  readFile: (path) => readFile(path),
  remove: (path, { recursive }) => rm(path, { recursive, force: false }),
  move: (from, to) => rename(from, to),
  async writeText(path, text) {
    // The parent is created because a config file may be the first thing that
    // ever lands in its directory — `~/.config/opencode/opencode.json`.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  },
  async statMany(paths) {
    const found = new Map();
    await Promise.all(
      paths.map(async (path) => {
        try {
          found.set(path, await stat(path));
        } catch {
          found.set(path, null);
        }
      }),
    );
    return found;
  },
  async readHeads(requests) {
    const found = new Map();
    await Promise.all(
      requests.map(async ({ path, bytes }) => {
        try {
          found.set(path, await localReadHead(path, bytes));
        } catch {
          /* A file that vanished between the walk and the read. */
        }
      }),
    );
    return found;
  },
};

/* ------------------------------------------------------------------ *
 * Remote — another machine, over SSH
 * ------------------------------------------------------------------ */

/**
 * Parse one GNU `stat` timestamp: `2024-10-03 10:09:12.123456789 +0800`.
 *
 * `stat` is asked for its human format rather than `%Y` because `%Y` is whole
 * seconds, and the engine's caches are invalidated by `mtimeMs:size`. Two
 * appends inside one second would then look like one write. The nanoseconds are
 * in the string; only a parser was missing.
 *
 * The offset is applied explicitly rather than handed to `Date.parse`, which
 * rejects a nine-digit fraction and would make every remote file look unchanged
 * at epoch zero.
 *
 * @param {string} text
 * @returns {number|null} Epoch ms, or null when the shape is not recognised.
 */
export function parseGnuStatTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(?:([+-])(\d{2})(\d{2}))?$/.exec(
    String(text ?? "").trim(),
  );
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] = match;
  const fractionMs = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  const local = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fractionMs,
  );
  if (!Number.isFinite(local)) return null;
  const offset =
    sign === undefined ? 0 : (sign === "-" ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute)) * 60000;
  return local - offset;
}

/** The one-line `stat` format the remote end is asked for. */
const STAT_FORMAT = "%s|%y|%w";

/** How many paths one batched call carries, to stay well inside ARG_MAX. */
const BATCH_PATHS = 400;

/**
 * Build the store for one remote machine.
 *
 * Every read is a `sh` script, never a login shell: a shell rc prints banners
 * that would land in the middle of a session's bytes. The one thing an
 * interactive shell is needed for — finding a CLI on a PATH the rc builds — is
 * the launcher's problem, not this one.
 *
 * The batched methods are not an optimisation detail; they are what makes this
 * usable at all. An inventory of a few thousand rollouts through one `ssh` per
 * file is a few thousand round trips, which is minutes. `statMany` and
 * `readHeads` collapse that to a handful.
 *
 * @param {{alias: string, id?: string, timeoutMs?: number}} options
 * @returns {Store}
 */
export function createRemoteStore({ alias, id = alias, timeoutMs = 30000 }) {
  const run = (script, extra) => sshExec(alias, script, { timeoutMs, ...extra });

  /** Fail loudly on a non-zero exit, so a caller's catch means "could not read". */
  async function runOrThrow(script, what) {
    const { code, stdout, stderr } = await run(script);
    if (code !== 0) {
      throw new Error(`${alias}: ${what} failed (exit ${code})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
    }
    return stdout;
  }

  /**
   * Split a NUL-terminated stream and drop a record the cap cut in half.
   *
   * A truncated transfer always ends mid-record; keeping its fragment would
   * invent a file whose name is the first half of a path.
   */
  function splitNul(buffer) {
    const parts = buffer.toString("utf8").split("\0");
    parts.pop();
    return parts;
  }

  return {
    kind: "remote",
    id,

    async walk(root, match, { maxFiles = 4000, maxDepth = 8 } = {}) {
      const script = [
        `[ -d ${shq(root)} ] || exit 0`,
        // Bounded on the wire as well as in the result: one pathological store
        // must not pull a directory tree into this process's memory.
        `find ${shq(root)} -maxdepth ${Number(maxDepth)} -type f -print0 2>/dev/null | head -c 16000000`,
      ].join("\n");
      const { code, stdout } = await run(script);
      // A box without `find`, or a root this user cannot read, is an environment
      // with no sessions there — not an exception per file.
      if (code !== 0) return [];
      const found = [];
      for (const path of splitNul(stdout)) {
        if (found.length >= maxFiles) break;
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (match(path, name)) found.push(path);
      }
      return found;
    },

    async stat(path) {
      const stdout = await runOrThrow(`stat -c ${shq(STAT_FORMAT)} -- ${shq(path)} 2>/dev/null`, `stat ${path}`);
      const stats = parseRemoteStat(stdout.toString("utf8"));
      if (stats === null) throw new Error(`${alias}: stat ${path} returned nothing`);
      return stats;
    },

    async readHead(path, bytes) {
      const stdout = await runOrThrow(`head -c ${Number(bytes)} -- ${shq(path)}`, `read ${path}`);
      return { text: stdout.toString("utf8"), filled: stdout.length >= bytes };
    },

    async readAt(path, offset, length) {
      const script = `tail -c +${Number(offset) + 1} -- ${shq(path)} | head -c ${Number(length)}`;
      return await runOrThrow(script, `read ${path}`);
    },

    async readTail(path, bytes, stats) {
      const size = stats?.size ?? (await this.stat(path)).size;
      const buffer = await runOrThrow(`tail -c ${Number(bytes)} -- ${shq(path)}`, `tail ${path}`);
      return { buffer, fromStart: size <= bytes };
    },

    async readFile(path) {
      return await runOrThrow(`cat -- ${shq(path)}`, `read ${path}`);
    },

    async remove(path, { recursive }) {
      const script = `rm ${recursive ? "-r " : ""}-- ${shq(path)}`;
      await runOrThrow(script, `remove ${path}`);
    },

    async move(from, to) {
      await runOrThrow(`mv -- ${shq(from)} ${shq(to)}`, `move ${from}`);
    },

    async writeText(path, text) {
      // Through base64, because a config file is arbitrary text: quoting it into
      // a shell word would be a second parser to get wrong, and the first one
      // to be wrong about a `'` or a `$(...)` would corrupt the file or run it.
      const encoded = Buffer.from(text, "utf8").toString("base64");
      const script = [
        `mkdir -p -- "$(dirname ${shq(path)})"`,
        // GNU spells decode `-d` and BSD spells it `-D`. Probing once is
        // cheaper than a flag error on the far end, and it keeps this working if
        // the "remote" machine is itself a Mac.
        `if base64 -d </dev/null >/dev/null 2>&1; then dec=-d; else dec=-D; fi`,
        `printf '%s' ${shq(encoded)} | base64 "$dec" > ${shq(path)}`,
      ].join("\n");
      await runOrThrow(script, `write ${path}`);
    },

    async statMany(paths) {
      const found = new Map();
      for (const path of paths) found.set(path, null);
      for (let at = 0; at < paths.length; at += BATCH_PATHS) {
        const chunk = paths.slice(at, at + BATCH_PATHS);
        // One process per file on the far side, but one *round trip* for the
        // whole chunk — which is the cost that actually matters.
        const script = [
          `for p in ${chunk.map(shq).join(" ")}; do`,
          `  st=$(stat -c ${shq(STAT_FORMAT)} -- "$p" 2>/dev/null) || continue`,
          `  printf '%s\\0%s\\0' "$p" "$st"`,
          `done`,
        ].join("\n");
        const { code, stdout } = await run(script);
        if (code !== 0) continue;
        const parts = splitNul(stdout);
        for (let index = 0; index + 1 < parts.length; index += 2) {
          const stats = parseRemoteStat(parts[index + 1]);
          if (stats !== null) found.set(parts[index], stats);
        }
      }
      return found;
    },

    async readHeads(requests) {
      const found = new Map();
      for (let at = 0; at < requests.length; at += BATCH_PATHS) {
        const chunk = requests.slice(at, at + BATCH_PATHS);
        const script = [
          `for spec in ${chunk.map(({ path, bytes }) => `${shq(path)}:${Number(bytes)}`).join(" ")}; do`,
          `  p=\${spec%:*}; n=\${spec##*:}`,
          `  printf '%s\\0' "$p"`,
          `  [ -f "$p" ] && head -c "$n" -- "$p" | base64 | tr -d '\\n'`,
          `  printf '\\0'`,
          `done`,
        ].join("\n");
        const { code, stdout } = await run(script);
        if (code !== 0) continue;
        const parts = splitNul(stdout);
        for (let index = 0; index + 1 < parts.length; index += 2) {
          const path = parts[index];
          const body = parts[index + 1];
          if (body === "") continue;
          const bytes = Buffer.from(body, "base64");
          const asked = chunk.find((request) => request.path === path)?.bytes ?? 0;
          found.set(path, { text: bytes.toString("utf8"), filled: bytes.length >= asked });
        }
      }
      return found;
    },

  };
}

/** Parse one `size|mtime|birth` line from the remote `stat`. */
export function parseRemoteStat(text) {
  const line = String(text ?? "").trim();
  if (line === "") return null;
  const [size, mtime, birth] = line.split("|");
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return null;
  const mtimeMs = parseGnuStatTime(mtime);
  if (mtimeMs === null) return null;
  // `%w` is `-` on a filesystem that does not record a birth time; an absent
  // date must not become 1970, which would sort a new session to the bottom.
  const birthtimeMs = birth === undefined || birth.trim() === "-" ? undefined : parseGnuStatTime(birth) ?? undefined;
  return { size: bytes, mtimeMs, birthtimeMs };
}

/** A store id → implementation, so an environment names its own byte source. */
