/**
 * dsh-session-hub — which machine the panel is looking at.
 *
 * An *environment* is a place session stores live. There are two kinds:
 *
 *   local    this machine's disk, through `./store.js`'s `localStore`.
 *   remote   another machine, reached over SSH, through the same interface.
 *
 * The adapter layer above never learns which one is active. That is what makes
 * the remote mode cheap: `sources/claude.js` folds Claude's events the same way
 * whether the bytes came from `~/.claude/projects` here or on the far side of an
 * ssh connection, because a store is just bytes and stats.
 *
 * This module is deliberately *descriptive* — it validates, probes and persists
 * a choice, but it never installs one. `index.js` does the wiring (scoping
 * `home()`/`dshHome()`, swapping the store, dropping the caches), so there is no
 * import cycle back into the Host.
 *
 * @module dsh-session-hub/environments
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bracketed, shq, sshText, unwrapBracketed } from "./ssh.js";
import { localDshHome, localHome } from "./shared.js";

/** This machine, always first and always present. */
export const LOCAL_ENVIRONMENT = Object.freeze({
  id: "local",
  kind: "local",
  label: "本机",
  detail: "this machine",
});

/** Agent ids an environment may hold stores for; the adapters own the meaning. */
export const KNOWN_AGENTS = ["dsh", "claude", "codex", "gemini", "pi", "opencode"];

const RX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RX_ABS = /^\/[^\0\n]*$/;

/**
 * Whether a string can be handed to `ssh` as a host.
 *
 * Exported because the manager validates what a person types before it becomes
 * a saved host, and two regexes for one rule is how they drift.
 */
export function isHostAlias(value) {
  return typeof value === "string" && RX_ID.test(value.trim());
}

/**
 * Read the configured environments out of the plugin config.
 *
 * A malformed entry is reported rather than dropped: silently ignoring a
 * mistyped host would present the panel as though that machine had no sessions,
 * which is the one thing an environment switcher must never do.
 *
 * @param {object} config The `config` block of this plugin's Cordis row.
 * @returns {{environments: object[], problems: string[]}}
 */
export function normalizeEnvironments(config) {
  const problems = [];
  const environments = [LOCAL_ENVIRONMENT];
  const rows = config?.environments;

  if (rows === undefined) return { environments, problems };
  if (!Array.isArray(rows)) {
    return { environments, problems: ["config.environments must be a list"] };
  }

  const seen = new Set([LOCAL_ENVIRONMENT.id]);
  for (const [index, row] of rows.entries()) {
    const where = `config.environments[${index}]`;
    if (row === null || typeof row !== "object") {
      problems.push(`${where} must be an object`);
      continue;
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const alias = typeof row.alias === "string" ? row.alias.trim() : id;
    if (id === "") {
      problems.push(`${where} needs an id`);
      continue;
    }
    if (!RX_ID.test(id)) {
      problems.push(`${where}.id "${id}" must be letters, digits, dot, dash or underscore`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${where}.id "${id}" is a duplicate`);
      continue;
    }
    if (!RX_ID.test(alias)) {
      problems.push(`${where}.alias "${alias}" is not a usable ssh host name`);
      continue;
    }
    const environment = {
      id,
      kind: "remote",
      alias,
      label: typeof row.label === "string" && row.label !== "" ? row.label : alias,
    };
    if (row.home !== undefined) {
      if (typeof row.home !== "string" || !RX_ABS.test(row.home)) {
        problems.push(`${where}.home must be an absolute path`);
        continue;
      }
      environment.home = row.home;
    }
    if (row.dshHome !== undefined) {
      if (typeof row.dshHome !== "string" || !RX_ABS.test(row.dshHome)) {
        problems.push(`${where}.dshHome must be an absolute path`);
        continue;
      }
      environment.dshHome = row.dshHome;
    }
    seen.add(id);
    environments.push(environment);
  }

  return { environments, problems };
}

/** One environment by id, or null. */
export function findEnvironment(environments, id) {
  return environments.find((environment) => environment.id === id) ?? null;
}

/**
 * Fold every place a machine can be declared into this plugin's catalogue.
 *
 * Three sources, in the order they win:
 *
 *   1. this plugin's own `config.environments` — a file-level correction, and
 *      the only source that exists in a composition with no remote-agent;
 *   2. the person's own list, edited from the panel;
 *   3. the machines `dsh-remote-agent` publishes.
 *
 * The second exists because a host declared for *launching* lives in a bundle
 * patch, which a running app should not rewrite — so the panel keeps its own
 * list, and a machine added there needs nothing else installed. A saved host
 * beats a published one of the same alias because the person typed it.
 *
 * A saved host with `enabled: false` is subtracted at the end, whatever else
 * named it: "hide this machine" has to mean hidden, or the toggle would work
 * only for machines nothing else mentions.
 *
 * Local wins over all of them and is never a remote host.
 *
 * @param {object[]} base Environments this plugin configured for itself.
 * @param {object[]} published What `remoteHosts` published.
 * @param {object[]} [saved] The person's own list.
 * @returns {object[]}
 */
export function mergeEnvironments(base, published, saved = []) {
  const environments = Array.isArray(base) && base.length > 0 ? [...base] : [LOCAL_ENVIRONMENT];
  const disabled = new Set(
    (Array.isArray(saved) ? saved : []).filter((host) => host?.enabled === false).map((host) => host.alias),
  );

  const named = new Set(environments.map((environment) => environment.id));
  const aliased = new Set(
    environments.map((environment) => environment.alias).filter((alias) => typeof alias === "string"),
  );

  /** One shape for a declared machine, whether it came from a file or a service. */
  const add = (host, kind) => {
    const alias = typeof host?.alias === "string" ? host.alias.trim() : "";
    // A host arriving across a plugin boundary or from a hand-edited file is
    // validated here too: a malformed alias would become an ssh invocation.
    if (alias === "" || !RX_ID.test(alias) || named.has(alias) || aliased.has(alias)) return;
    const environment = {
      id: alias,
      kind: "remote",
      alias,
      label: typeof host.label === "string" && host.label.trim() !== "" ? host.label.trim() : alias,
      source: kind,
    };
    if (typeof host.home === "string" && RX_ABS.test(host.home)) environment.home = host.home;
    if (typeof host.dshHome === "string" && RX_ABS.test(host.dshHome)) environment.dshHome = host.dshHome;
    named.add(alias);
    aliased.add(alias);
    environments.push(environment);
  };

  // Saved before published, so the person's own entry is the one that wins.
  for (const host of Array.isArray(saved) ? saved : []) add(host, "saved");
  for (const host of Array.isArray(published) ? published : []) add(host, "published");

  // Matched on the id *or* the alias: a machine declared in this plugin's config
  // may name itself differently from the ssh host it resolves to, and "hide this
  // machine" has to mean hidden either way.
  return environments.filter(
    (environment) =>
      environment.kind === "local" ||
      (!disabled.has(environment.id) && !disabled.has(environment.alias)),
  );
}

/* ------------------------------------------------------------------ *
 * Machines this machine's ssh already knows
 * ------------------------------------------------------------------ */

/**
 * Parse `~/.ssh/config` into candidate machines.
 *
 * Reading the ssh config rather than asking the person to retype an alias is
 * the whole point: the aliases they already use for `ssh` are exactly the
 * machines they would want to switch to, and the file already records the host
 * name, user and port that make a row worth reading.
 *
 * Two things are deliberately not machines:
 *
 *   Wildcards. `Host *` is a rule about every host, not a host. Offering it as a
 *   switch target would produce an environment whose name is a glob.
 *   Negations. `Host !bad` is an exclusion inside a rule for the same reason.
 *
 * `Include` is not followed — a directive that pulls in another file would make
 * this read the whole ssh configuration tree, and an alias that lives only in an
 * included file is still addable by hand.
 *
 * @param {string} text
 * @returns {{alias: string, hostName: string|null, user: string|null, port: number|null}[]}
 */
export function parseSshConfig(text) {
  const hosts = [];
  const seen = new Set();
  /** The entries the most recent `Host` line introduced — one line may name several. */
  let current = [];

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "host") {
      current = [];
      for (const alias of value.split(/\s+/)) {
        if (alias === "" || alias.includes("*") || alias.includes("?") || alias.startsWith("!")) continue;
        if (seen.has(alias)) continue;
        seen.add(alias);
        const entry = { alias, hostName: null, user: null, port: null };
        hosts.push(entry);
        current.push(entry);
      }
      continue;
    }

    // Every directive belongs to every alias on the preceding `Host` line, which
    // is how ssh reads it too — taking only the last one silently loses the rest.
    for (const entry of current) {
      if (key === "hostname" && entry.hostName === null) entry.hostName = value;
      else if (key === "user" && entry.user === null) entry.user = value;
      else if (key === "port" && entry.port === null) entry.port = Number(value) || null;
    }
  }

  return hosts;
}

/** The aliases this machine's `~/.ssh/config` knows. Never throws. */
export async function readSshHosts() {
  try {
    return parseSshConfig(await readFile(join(localHome(), ".ssh", "config"), "utf8"));
  } catch {
    /* No ssh config, or one that cannot be read, is simply no candidates. */
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * The machines the person added from the panel
 * ------------------------------------------------------------------ */

/**
 * A machine the user added, which this plugin has to remember itself.
 *
 * `dsh-remote-agent`'s hosts are declared in a bundle patch, which is not a file
 * a running app should rewrite — so the panel's own list lives here, in this
 * plugin's state file. A saved host wins over a published one of the same alias:
 * the person typed it, so it is the more deliberate statement.
 *
 * @typedef {object} SavedHost
 * @property {string} alias
 * @property {string} label
 * @property {string} [home]
 * @property {string} [dshHome]
 * @property {boolean} enabled False hides the machine without forgetting it.
 */

/** Validate the saved rows, dropping anything that could become an ssh argument. */
function normalizeSavedHosts(rows) {
  if (!Array.isArray(rows)) return [];
  const hosts = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const alias = typeof row.alias === "string" ? row.alias.trim() : "";
    if (alias === "" || !RX_ID.test(alias) || seen.has(alias)) continue;
    const host = {
      alias,
      label: typeof row.label === "string" && row.label.trim() !== "" ? row.label.trim() : alias,
      enabled: row.enabled !== false,
    };
    if (typeof row.home === "string" && RX_ABS.test(row.home)) host.home = row.home;
    if (typeof row.dshHome === "string" && RX_ABS.test(row.dshHome)) host.dshHome = row.dshHome;
    seen.add(alias);
    hosts.push(host);
  }
  return hosts;
}

/* ------------------------------------------------------------------ *
 * The chosen one, remembered across browser sessions
 * ------------------------------------------------------------------ */

/**
 * Where the chosen machine and the person's own list are remembered.
 *
 * Host-side, not `localStorage`, on purpose: the person switches from whichever
 * browser they happen to be in, and the next tab should open where they left
 * off. It is this plugin's own preference, so it lives in this plugin's own
 * directory, beside `state.json` and `hooks.jsonl`.
 */
export function environmentStatePath() {
  return join(localDshHome(), "session-hub", "environment.json");
}

/**
 * The whole state document.
 *
 * A version-1 file held only `active`, and is still read: a person who had
 * already chosen a machine must not lose that choice because this plugin learned
 * to remember a second thing.
 *
 * @returns {Promise<{active: string, hosts: SavedHost[]}>}
 */
export async function readEnvironmentState() {
  try {
    const parsed = JSON.parse(await readFile(environmentStatePath(), "utf8"));
    return {
      active: typeof parsed?.active === "string" && parsed.active !== "" ? parsed.active : LOCAL_ENVIRONMENT.id,
      hosts: normalizeSavedHosts(parsed?.hosts),
    };
  } catch {
    return { active: LOCAL_ENVIRONMENT.id, hosts: [] };
  }
}

/** Write the whole document. Returns false when it could not be written. */
export async function writeEnvironmentState(state) {
  try {
    const path = environmentStatePath();
    await mkdir(dirname(path), { recursive: true });
    const document = {
      version: 2,
      active: typeof state?.active === "string" && state.active !== "" ? state.active : LOCAL_ENVIRONMENT.id,
      hosts: normalizeSavedHosts(state?.hosts),
    };
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The remembered environment id, or "local". Never throws. */
export async function readActiveId() {
  return (await readEnvironmentState()).active;
}

/**
 * Remember an environment id, keeping the person's host list.
 *
 * Read-modify-write rather than a fresh document: switching machines and adding
 * one are two writes to the same file, and the simpler version would have each
 * silently erase the other.
 */
export async function writeActiveId(id) {
  const state = await readEnvironmentState();
  return await writeEnvironmentState({ ...state, active: id });
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

/**
 * What a probe of a remote machine reports.
 *
 * `home`/`dshHome` are what make the adapters work without a line of dialect
 * code changing: every adapter derives its store root from `home()` and
 * `dshHome()`, so answering those two questions for the far side is the whole
 * of "point session-hub at another machine".
 *
 * @typedef {object} Probe
 * @property {boolean} reachable
 * @property {string|null} home
 * @property {string|null} dshHome
 * @property {string[]} agents Agent ids whose store directory exists there.
 * @property {string|null} error
 * @property {number} at
 */

/**
 * The remote script that answers everything a probe needs, in one round trip.
 *
 * Deliberately a plain `sh`, not a login shell: it asks about `$HOME` and the
 * filesystem, and a login rc would only add noise and latency. Which *binaries*
 * exist is a different question, and it is asked separately by the launcher —
 * this probe answers "is there anything to read", not "is there anything to
 * run".
 */
function probeScript(environment) {
  const homes = [
    `printf 'home=%s\\n' ${shq(environment.home ?? "")}`,
    `printf 'dsh_home=%s\\n' ${shq(environment.dshHome ?? "")}`,
    `printf 'probed_home=%s\\n' "$HOME"`,
    `printf 'probed_dsh_home=%s\\n' "\${DSH_HOME:-$HOME/.dsh}"`,
  ];
  const agents = KNOWN_AGENTS.map(
    (agent) => `[ -d "$HOME/${storeDirectory(agent)}" ] && printf 'agent=%s\\n' ${shq(agent)}`,
  );
  return [...homes, ...agents, "exit 0"].join("; ");
}

/**
 * The directory under `$HOME` that holds one agent's sessions.
 *
 * This duplicates a fact the adapters own, which is normally exactly what this
 * codebase refuses to do — so it is only ever used to *report presence* in the
 * switcher, never to read a store. The reading path still asks the adapter for
 * `root()`. A probe that is wrong about one of these shows a disabled-looking
 * row; it cannot mis-parse a session.
 */
function storeDirectory(agent) {
  switch (agent) {
    case "dsh":
      return ".dsh/sessions";
    case "claude":
      return ".claude/projects";
    case "codex":
      return ".codex/sessions";
    case "gemini":
      return ".gemini/tmp";
    case "pi":
      return ".pi/agent/sessions";
    case "opencode":
      return ".local/share/opencode";
    default:
      return "";
  }
}

/** Probes are cheap but not free, so one machine is asked at most this often. */
const PROBE_TTL_MS = 15000;
const probeCache = new Map();

/**
 * Ask one environment whether it is reachable, and where its stores live.
 *
 * A local environment is answered without touching `ssh` at all.
 *
 * @param {object} environment
 * @param {{timeoutMs?: number, force?: boolean}} [options]
 * @returns {Promise<Probe>}
 */
export async function probeEnvironment(environment, { timeoutMs = 12000, force = false } = {}) {
  if (environment.kind === "local") {
    return {
      reachable: true,
      home: null,
      dshHome: null,
      agents: [...KNOWN_AGENTS],
      error: null,
      at: Date.now(),
    };
  }

  const hit = probeCache.get(environment.id);
  if (!force && hit !== undefined && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

  const { mark, command } = bracketed(probeScript(environment));
  let value;
  try {
    const { code, stdout, stderr } = await sshText(environment.alias, command, { timeoutMs });
    const payload = unwrapBracketed(mark, stdout);
    if (payload === null) {
      value = {
        reachable: false,
        home: null,
        dshHome: null,
        agents: [],
        error: stderr.trim() !== "" ? stderr.trim() : `ssh exited ${code} with no output`,
        at: Date.now(),
      };
    } else {
      const fields = new Map();
      const agents = [];
      for (const line of payload.split("\n")) {
        const at = line.indexOf("=");
        if (at < 0) continue;
        const key = line.slice(0, at);
        const rest = line.slice(at + 1);
        if (key === "agent") agents.push(rest);
        else fields.set(key, rest);
      }
      const home = fields.get("home") || fields.get("probed_home") || null;
      const dshHome = fields.get("dsh_home") || fields.get("probed_dsh_home") || null;
      value = {
        reachable: home !== null,
        home,
        dshHome,
        agents,
        error: home === null ? "the remote shell reported no $HOME" : null,
        at: Date.now(),
      };
    }
  } catch (error) {
    value = {
      reachable: false,
      home: null,
      dshHome: null,
      agents: [],
      error: String(error?.message ?? error),
      at: Date.now(),
    };
  }

  probeCache.set(environment.id, { at: value.at, value });
  return value;
}

/** Forget a cached probe, so a "retry" in the UI actually reconnects. */
export function forgetProbe(id) {
  probeCache.delete(id);
}

/**
 * The `home`/`dshHome` an environment resolves to, given its probe.
 *
 * A configured value wins: an operator who wrote down a path meant it, and a
 * probe that disagrees is more likely to be a shell quirk than a correction.
 *
 * @returns {{home: string, dshHome: string}|null} null when it cannot be known.
 */
export function resolveHomes(environment, probe) {
  if (environment.kind === "local") return null;
  const home = environment.home ?? probe?.home ?? null;
  if (home === null) return null;
  const dshHome = environment.dshHome ?? probe?.dshHome ?? join(home, ".dsh");
  return { home, dshHome };
}
