/**
 * Environment-switcher and config-file test.
 *
 * Drives the Host exactly the way the Cordis loader does and asserts the two
 * things that are easy to get quietly wrong:
 *
 *   1. An unreachable environment must never present this machine's sessions as
 *      that machine's. "Broken" and "empty" have to look different.
 *   2. A config read or write must be fenced to the paths an adapter declared,
 *      and must leave the previous body recoverable.
 *
 * `DSH_HOME` is pointed at a scratch directory *before* the Host is imported, so
 * the write half of the test lands in a temporary file rather than in a real
 * `.credentials.yaml`, and the remembered environment does not overwrite the
 * one a person is actually using.
 *
 *   node test/environments.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_ENVIRONMENT, mergeEnvironments, normalizeEnvironments, parseSshConfig } from "../environments.js";

const scratch = await mkdtemp(join(tmpdir(), "dsh-session-hub-env-"));
process.env.DSH_HOME = scratch;
await mkdir(join(scratch, "sessions"), { recursive: true });

/* ---------------------------------------------------------------- *
 * 0. Folding in the machines another plugin publishes
 * ---------------------------------------------------------------- */

// Pure, so the merge rules are asserted without a Host or an ssh connection.
const merged = mergeEnvironments(normalizeEnvironments(undefined).environments, [
  { alias: "pro14uu", label: "pro14", dshHome: "/home/zakl/.dsh" },
  { alias: "laptop", label: "laptop", home: "/home/zakl", dshHome: "/home/zakl/.dsh" },
]);
assert.equal(merged.length, 3, "two published hosts must become two environments");
assert.equal(merged[0].id, "local", "local stays first");
const pro14 = merged.find((entry) => entry.id === "pro14uu");
assert.equal(pro14.kind, "remote", "a published host is a remote environment");
assert.equal(pro14.label, "pro14", "its label carries over");
assert.equal(pro14.dshHome, "/home/zakl/.dsh", "and the remote dshHome, which is the fact a probe gets wrong");
assert.equal(pro14.home, undefined, "a host that did not publish `home` leaves it to the probe");

// The rules that keep one source from silently overriding the other.
const withLocal = mergeEnvironments(
  [LOCAL_ENVIRONMENT, { id: "pro14uu", kind: "remote", alias: "pro14uu", label: "overridden", home: "/custom" }],
  [{ alias: "pro14uu", label: "pro14" }],
);
assert.equal(withLocal.length, 2, "a published host that is already named must not be added twice");
assert.equal(withLocal[1].label, "overridden", "this plugin's own entry wins: it is a correction, not a duplicate");
assert.equal(withLocal[1].home, "/custom", "including its explicit home");

const hostile = mergeEnvironments([LOCAL_ENVIRONMENT], [
  { alias: "local", label: "impostor" },
  { alias: "not a host name", label: "bad" },
  { alias: "", label: "empty" },
  { alias: "ok-host", label: "fine" },
  null,
  "nonsense",
]);
assert.deepEqual(
  hostile.map((entry) => entry.id),
  ["local", "ok-host"],
  "a host across a plugin boundary is validated like any other",
);
assert.equal(hostile[0].label, "本机", "nothing can publish over `local`");

/* ---------------------------------------------------------------- *
 * 0b. Reading the machines ssh already knows
 * ---------------------------------------------------------------- */

const parsed = parseSshConfig(
  [
    "# a comment, and an alias that is only mentioned in one",
    "Host pro14",
    "    HostName 172.21.164.226",
    "    User zakl",
    "    Port 22",
    "    ServerAliveInterval 30",
    "",
    "Host pro14uu",
    "    HostName 127.0.0.1",
    "    User zakl",
    "    Port 2222",
    "",
    "Host *",
    "    ServerAliveInterval 30",
    "",
    "Host a b",
    "    HostName shared.example.com",
    "    User both",
    "",
    "Host !excluded",
    "",
    "Host pro14", // a second block for an alias already seen
    "    User other",
    "",
    "Include ~/.ssh/extra",
  ].join("\n"),
);
assert.deepEqual(
  parsed.map((host) => host.alias),
  ["pro14", "pro14uu", "a", "b"],
  "wildcards, negations and duplicates are not machines; every word on a Host line is",
);
const first = parsed.find((host) => host.alias === "pro14");
assert.equal(first.hostName, "172.21.164.226", "HostName is read");
assert.equal(first.user, "zakl", "so is User");
assert.equal(first.port, 22, "and Port, as a number");
assert.equal(parsed.find((host) => host.alias === "pro14uu").port, 2222, "each alias keeps its own block");
// A `Host a b` line applies its directives to both, which is how ssh reads it —
// taking only the last would silently lose `a`'s host name.
assert.equal(parsed.find((host) => host.alias === "a").hostName, "shared.example.com", "a multi-alias Host line applies to all of them");
assert.equal(parsed.find((host) => host.alias === "b").user, "both", "including every other directive");
assert.deepEqual(parseSshConfig(""), [], "an empty config has no machines");
assert.deepEqual(parseSshConfig(undefined), [], "and neither has a missing one");

/* ---------------------------------------------------------------- *
 * 0c. The machines the person added here
 * ---------------------------------------------------------------- */

const withSaved = mergeEnvironments(
  normalizeEnvironments(undefined).environments,
  [{ alias: "pro14uu", label: "published" }],
  [{ alias: "pro14uu", label: "mine", enabled: true }, { alias: "215", label: "build box", home: "/home/jiakui" }],
);
assert.deepEqual(withSaved.map((entry) => entry.id), ["local", "pro14uu", "215"], "saved machines join the catalogue");
assert.equal(withSaved.find((entry) => entry.id === "pro14uu").label, "mine", "a machine the person typed beats a published one");
assert.equal(withSaved.find((entry) => entry.id === "215").source, "saved", "and says where it came from");
assert.equal(withSaved.find((entry) => entry.id === "215").home, "/home/jiakui", "with the home they gave it");

const hidden = mergeEnvironments(
  normalizeEnvironments(undefined).environments,
  [{ alias: "pro14uu" }],
  [{ alias: "pro14uu", enabled: false }],
);
assert.deepEqual(hidden.map((entry) => entry.id), ["local"], "`enabled: false` subtracts a machine whatever else named it");

const onlySaved = mergeEnvironments([], [], [{ alias: "215", label: "box" }]);
assert.deepEqual(onlySaved.map((entry) => entry.id), ["local", "215"], "with no config and no remote-agent, saved still works");

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
    connection: {
      fetch: {
        register: (registered) => {
          route = registered;
        },
      },
    },
    // The optional `remoteHosts` service, as `dsh-remote-agent` publishes it.
    // Read through `ctx.get` because a hard `inject` would stop this plugin
    // activating in a composition that has no remote-agent at all.
    get: (name) =>
      name === "remoteHosts"
        ? {
            list: () => [
              { alias: "published-box", label: "Published", dshHome: "/srv/dsh/.dsh" },
              { alias: "unreachable", label: "Would be a duplicate" },
            ],
          }
        : undefined,
  },
  {
    environments: [
      // A host name that cannot resolve: `.invalid` is reserved for exactly
      // this, and it fails fast instead of waiting out a connect timeout.
      { id: "unreachable", alias: "dsh-session-hub-test.invalid", label: "Unreachable", home: "/home/nobody" },
      { id: "bad", alias: "not a host name", label: "Bad" },
    ],
  },
);

assert.ok(route !== null, "apply() must register a Fetch route");

let checks = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  checks += 1;
}

async function call(payload) {
  const request = new Request("http://127.0.0.1/api/session-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await route.fetch(request).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));
}

/* ---------------------------------------------------------------- *
 * 1. The catalogue
 * ---------------------------------------------------------------- */

const listing = await call({ op: "environment", action: "list" });
check(listing.status === 200, "environment list must answer 200");
check(listing.body.ok === true, `environment list failed: ${JSON.stringify(listing.body)}`);
check(listing.body.active.id === "local", "a fresh Host starts on this machine");
check(listing.body.active.reachable === true, "the local environment is always reachable");
const ids = listing.body.environments.map((entry) => entry.id);
check(ids.includes("local"), "the catalogue always holds local");
check(ids.includes("unreachable"), "a configured remote is in the catalogue");
check(!ids.includes("bad"), "an alias that is not a host name is rejected, not listed");
check(ids.includes("published-box"), "a machine published by another plugin is in the catalogue");
check(
  !ids.includes("unreachable") || listing.body.environments.filter((e) => e.id === "unreachable").length === 1,
  "a published host that this plugin already names must not be listed twice",
);
check(
  listing.body.environments.find((entry) => entry.id === "published-box").label === "Published",
  "the published label carries over",
);
check(
  listing.body.problems.some((problem) => problem.includes("not a usable ssh host name")),
  `the rejected alias must be reported: ${JSON.stringify(listing.body.problems)}`,
);

// A published machine is a usable environment, not just a listed one — which
// means it reaches the same probe and the same refusal as a configured one.
const published = await call({ op: "environment", action: "set", id: "published-box" });
check(published.body.ok === true, `a published environment must be selectable: ${JSON.stringify(published.body)}`);
check(published.body.active.reachable === false, "a published alias that does not resolve reports unreachable");
check(published.body.active.dshHome === "/srv/dsh/.dsh", "and keeps the dshHome the publisher supplied");
const rightBack = await call({ op: "environment", action: "set", id: "local" });
check(rightBack.body.ok === true, "and it can be left again");

/* ---------------------------------------------------------------- *
 * 2. Config listing is adapter-declared and environment-scoped
 * ---------------------------------------------------------------- */

const config = await call({ op: "config", action: "list" });
check(config.body.ok === true, `config list failed: ${JSON.stringify(config.body)}`);
check(config.body.agents.length === 6, `every agent that declares config must appear: ${config.body.agents.length}`);
for (const group of config.body.agents) {
  for (const file of group.files) {
    check(file.path.startsWith("/"), `${group.agent}: ${file.path} must be absolute`);
    check(file.label !== "", `${group.agent}: a file must carry a label`);
  }
}
const byAgent = new Map(config.body.agents.map((group) => [group.agent, group.files]));
check(byAgent.get("codex").some((file) => file.path.endsWith(".codex/config.toml")), "codex declares config.toml");
check(byAgent.get("dsh").some((file) => file.path === join(scratch, ".credentials.yaml")), "dsh follows DSH_HOME");
check(
  byAgent.get("dsh").find((file) => file.path.endsWith(".credentials.yaml")).sensitive === true,
  "the credential store is marked sensitive",
);

/* ---------------------------------------------------------------- *
 * 3. The config fence
 * ---------------------------------------------------------------- */

const refused = await call({ op: "config", action: "read", agent: "codex", path: "/etc/passwd" });
check(refused.body.ok === false, "a path the adapter did not declare must be refused");
check(/not a declared config file/.test(refused.body.error), `the refusal must say why: ${refused.body.error}`);

const unknown = await call({ op: "config", action: "read", agent: "nope", path: "/etc/passwd" });
check(unknown.body.ok === false, "an unknown agent must be refused");

const prefixAttack = await call({
  op: "config",
  action: "read",
  agent: "dsh",
  path: `${join(scratch, ".credentials.yaml")}.dsh-session-hub.bak`,
});
check(prefixAttack.body.ok === false, "the fence matches whole paths, not prefixes");

/* ---------------------------------------------------------------- *
 * 4. A real write, with the previous body kept
 * ---------------------------------------------------------------- */

const target = join(scratch, ".credentials.yaml");
await writeFile(target, "before: 1\n", "utf8");

const written = await call({
  op: "config",
  action: "write",
  agent: "dsh",
  path: target,
  text: "after: 2\n",
});
check(written.body.ok === true, `config write failed: ${JSON.stringify(written.body)}`);
check(await readFile(target, "utf8") === "after: 2\n", "the new body must land");
check(written.body.backup === `${target}.dsh-session-hub.bak`, "the backup path must be reported");
check(existsSync(written.body.backup), "the backup must exist");
check(await readFile(written.body.backup, "utf8") === "before: 1\n", "the backup must hold the previous body");

const readBack = await call({ op: "config", action: "read", agent: "dsh", path: target });
check(readBack.body.ok === true, "the written file must be readable");
check(readBack.body.text === "after: 2\n", "the read must return what was written");
check(readBack.body.sensitive === true, "the read must carry the sensitivity flag");

/* ---------------------------------------------------------------- *
 * 5. An unreachable environment is refused, never faked
 * ---------------------------------------------------------------- */

const localList = await call({ op: "list" });
check(localList.body.ok === true, `the local list must work: ${JSON.stringify(localList.body).slice(0, 200)}`);
const localCount = localList.body.sessions.length;
check(localCount > 0, "this machine has sessions to compare against");

const switched = await call({ op: "environment", action: "set", id: "unreachable" });
check(switched.body.ok === true, `switching must answer: ${JSON.stringify(switched.body)}`);
check(switched.body.active.id === "unreachable", "the switch must take effect");
check(switched.body.active.reachable === false, "an unresolvable host must report unreachable");
check(typeof switched.body.active.error === "string" && switched.body.active.error !== "", "the failure must be explained");

const remoteList = await call({ op: "list" });
check(remoteList.body.ok === false, "a store read on an unreachable environment must be refused");
check(
  remoteList.body.sessions === undefined,
  "a refused read must not carry this machine's sessions as if they were remote",
);
check(remoteList.body.environment?.id === "unreachable", "the refusal must name the environment that failed");

const remoteConfig = await call({ op: "config", action: "list" });
check(remoteConfig.body.ok === false, "config reads are refused too, since they would touch the wrong machine");

// A failed reconnect must not erase the last good choice.
const saved = JSON.parse(await readFile(join(scratch, "session-hub", "environment.json"), "utf8"));
check(saved.active === "unreachable", "a deliberate switch is remembered");

/* ---------------------------------------------------------------- *
 * 6. Switching back restores this machine exactly
 * ---------------------------------------------------------------- */

const back = await call({ op: "environment", action: "set", id: "local" });
check(back.body.ok === true, "switching back to local must answer");
check(back.body.active.reachable === true, "local is reachable again");

const restored = await call({ op: "list" });
check(restored.body.ok === true, "the local list must work again");
check(restored.body.sessions.length === localCount, `the list must be exactly as before: ${restored.body.sessions.length} vs ${localCount}`);

const after = JSON.parse(await readFile(join(scratch, "session-hub", "environment.json"), "utf8"));
check(after.active === "local", "the choice is persisted");

/* ---------------------------------------------------------------- *
 * 7. The machine manager
 * ---------------------------------------------------------------- */

/**
 * The aliases here are synthetic (`.invalid` is reserved and fails fast), so
 * nothing in this section depends on the machine the test runs on — except the
 * one assertion that every alias in the real `~/.ssh/config` is *offered*,
 * which is the whole point of reading it.
 */
const listing2 = await call({ op: "hosts", action: "list" });
check(listing2.body.ok === true, `hosts list must answer: ${JSON.stringify(listing2.body).slice(0, 200)}`);
check(listing2.body.sshConfigPath.endsWith("/.ssh/config"), "it must say which file the aliases came from");
check(listing2.body.statePath === join(scratch, "session-hub", "environment.json"), "and which file it writes");

const sshText = await readFile(join(homedir(), ".ssh", "config"), "utf8").catch(() => "");
for (const host of parseSshConfig(sshText)) {
  check(
    listing2.body.hosts.some((row) => row.alias === host.alias && row.source === "ssh"),
    `an alias ssh already knows must be offered: ${host.alias}`,
  );
}
check(
  // The config entry names itself `unreachable` but points at a different ssh
  // alias, which is the case a manager must not confuse.
  listing2.body.hosts.some((row) => row.alias === "dsh-session-hub-test.invalid" && row.source === "config"),
  "and one this plugin's own config declares says so, under the alias it resolves to",
);
check(
  listing2.body.hosts.some((row) => row.alias === "published-box" && row.source === "published"),
  "and one another plugin published says so too",
);

const BOX = "hub-test-box.invalid";
const added = await call({ op: "hosts", action: "save", alias: BOX, label: "Test box", home: "/home/tester" });
check(added.body.ok === true, `saving a machine must work: ${JSON.stringify(added.body).slice(0, 200)}`);
check(
  added.body.environments.some((entry) => entry.id === BOX),
  "a saved machine joins the switcher immediately",
);
check(
  added.body.hosts.find((row) => row.alias === BOX).source === "saved",
  "and the manager says the person added it",
);

const listed = await call({ op: "hosts", action: "list" });
const box = listed.body.hosts.find((row) => row.alias === BOX);
check(box.isEnvironment === true, "it reads as in use");
check(box.home === "/home/tester", "with the home it was given, which beats the probe");

const probed = await call({ op: "hosts", action: "probe", alias: BOX });
check(probed.body.ok === true, "a machine can be tested before it is trusted");
check(probed.body.probe.reachable === false, "and a name that does not resolve reports unreachable");
check(typeof probed.body.probe.error === "string" && probed.body.probe.error !== "", "with the reason");

// Switching machines must not erase the machine list: both are writes to one file.
const switched2 = await call({ op: "environment", action: "set", id: BOX });
check(switched2.body.ok === true, "a saved machine is selectable");
const stateAfterSwitch = JSON.parse(await readFile(join(scratch, "session-hub", "environment.json"), "utf8"));
check(stateAfterSwitch.active === BOX, "the choice is remembered");
check(stateAfterSwitch.hosts.some((host) => host.alias === BOX), "and the machine list survives being switched to");

// Hiding the machine you are on has to move you off it.
const hiddenNow = await call({ op: "hosts", action: "save", alias: BOX, enabled: false });
check(hiddenNow.body.ok === true, "hiding a machine must work");
check(hiddenNow.body.active.id === "local", "turning off the machine you are looking at moves you back to this one");
check(
  !hiddenNow.body.environments.some((entry) => entry.id === BOX),
  "and it leaves the switcher",
);

const forgotten = await call({ op: "hosts", action: "remove", alias: BOX });
check(forgotten.body.ok === true, "forgetting must work");
check(
  !forgotten.body.hosts.some((row) => row.alias === BOX),
  "and the machine is gone from the manager entirely",
);
const stateAfterForget = JSON.parse(await readFile(join(scratch, "session-hub", "environment.json"), "utf8"));
check(stateAfterForget.hosts.every((host) => host.alias !== BOX), "because the saved record is what was removed");
check(stateAfterForget.active === "local", "and the choice is still valid");

// The same fence the ssh invocation needs, checked where a person types it.
const badAlias = await call({ op: "hosts", action: "save", alias: "not a host name" });
check(badAlias.body.ok === false, "an alias that is not a host name is refused");
const badHome = await call({ op: "hosts", action: "save", alias: BOX, home: "relative/path" });
check(badHome.body.ok === false, "a relative remote home is refused");
check(/absolute path/.test(badHome.body.error ?? ""), `and says why: ${badHome.body.error}`);

// A machine that is already named elsewhere is hidden, not duplicated.
const hidePublished = await call({ op: "hosts", action: "save", alias: "published-box", enabled: false });
check(
  !hidePublished.body.environments.some((entry) => entry.id === "published-box"),
  "hiding a published machine subtracts it without touching what published it",
);
const unhide = await call({ op: "hosts", action: "save", alias: "published-box", enabled: true });
check(unhide.body.ok === true, "and it can be brought back");

await rm(scratch, { recursive: true, force: true });
console.log(`environments: all ${checks} assertions passed`);
