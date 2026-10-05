/**
 * The ops that answer "which machine" — and the one that edits an agent's own
 * configuration over there.
 *
 * Each declares whether it reads agent storage; the Host applies that rule in one
 * place rather than trusting every handler to remember it.
 *
 * @module dsh-session-hub/ops/environment
 */

import { join } from "node:path";

import { dshHome, localHome } from "../shared.js";
import { defineOp } from "./op.js";

/** Every op this module owns, in the order the panel tends to ask for them. */
export const environmentOps = [
  defineOp({
    name: "environment",
    store: false,
    async handle(payload, ctx, host) {
    const { activateEnvironment, declaredConfigFiles, describeEnvironment, environmentCatalogue, environmentStatePath, fencedConfigPath, findEnvironment, hostCandidates, isHostAlias, mapLimit, probeEnvironment, readEnvironmentState, refreshEnvironmentList, store, writeActiveId, writeEnvironmentState , environmentState, LOCAL_ENVIRONMENT, MAX_CONFIG_BYTES, SOURCES } = host;
      const action = typeof payload?.action === "string" ? payload.action : "list";
      // Recomputed per request, so a machine another plugin started publishing is
      // reachable without a reload — and so is one added from the manager.
      await refreshEnvironmentList(ctx);
      if (action === "list") {
        return {
          ok: true,
          active: describeEnvironment(),
          environments: environmentCatalogue(),
          problems: environmentState.problems,
        };
      }
      // The switch can take a dozen seconds; this is what the panel polls while it
      // waits, so the wait can say what it is waiting for.
      if (action === "status") {
        return {
          ok: true,
          progress: environmentState.progress,
          active: describeEnvironment(),
          environments: environmentCatalogue(),
        };
      }
  
      if (action === "set" || action === "probe") {
        const id = action === "set" && typeof payload?.id === "string" ? payload.id : environmentState.activeId;
        if (findEnvironment(environmentState.list, id) === null) {
          return { ok: false, error: `unknown environment: ${id}`, environments: environmentCatalogue() };
        }
        // `set` lands at once and lets the probe catch up; `probe` is the action
        // whose whole point is the answer, so it waits.
        await activateEnvironment(id, { force: true, wait: action === "probe" });
        // Only a deliberate switch is remembered; a failed reconnect must not
        // overwrite the last good choice with the machine that is still down.
        if (action === "set") await writeActiveId(id);
        return { ok: true, progress: environmentState.progress, active: describeEnvironment(), environments: environmentCatalogue() };
      }
      return { ok: false, error: `unknown environment action: ${action}` };
    },
  }),
  defineOp({
    name: "config",
    store: true,
    async handle(payload, ctx, host) {
    const { activateEnvironment, declaredConfigFiles, describeEnvironment, environmentCatalogue, environmentStatePath, fencedConfigPath, findEnvironment, hostCandidates, isHostAlias, mapLimit, probeEnvironment, readEnvironmentState, refreshEnvironmentList, store, writeActiveId, writeEnvironmentState , environmentState, LOCAL_ENVIRONMENT, MAX_CONFIG_BYTES, SOURCES } = host;
      const action = typeof payload?.action === "string" ? payload.action : "list";
      const agent = typeof payload?.agent === "string" ? payload.agent : "";
  
      if (action === "list") {
        const groups = [];
        for (const source of SOURCES) {
          const files = declaredConfigFiles(source.id);
          if (files === null || files.length === 0) continue;
          const rows = await mapLimit(files, 4, async (file) => {
            let stats = null;
            try {
              stats = await store().stat(file.path);
            } catch {
              /* Absent is the normal state of a config that was never written. */
            }
            return {
              path: file.path,
              label: file.label,
              language: file.language ?? "text",
              sensitive: file.sensitive === true,
              creatable: file.creatable === true,
              exists: stats !== null,
              bytes: stats?.size ?? null,
              mtimeMs: stats?.mtimeMs ?? null,
            };
          });
          groups.push({ agent: source.id, agentLabel: source.label, files: rows });
        }
        return { ok: true, environment: describeEnvironment(), agents: groups };
      }
  
      if (action === "read" || action === "write") {
        const path = typeof payload?.path === "string" ? payload.path : "";
        const fence = fencedConfigPath(agent, path);
        if (fence.ok !== true) return fence;
  
        if (action === "read") {
          try {
            const stats = await store().stat(path);
            if (stats.size > MAX_CONFIG_BYTES) {
              return { ok: false, error: `${path} is ${stats.size} bytes — too large to edit here` };
            }
            const buffer = await store().readFile(path);
            return {
              ok: true,
              path,
              agent,
              label: fence.file.label,
              language: fence.file.language ?? "text",
              sensitive: fence.file.sensitive === true,
              text: buffer.toString("utf8"),
              bytes: buffer.length,
              mtimeMs: stats.mtimeMs,
            };
          } catch (error) {
            return { ok: false, error: `cannot read ${path}: ${String(error?.message ?? error)}` };
          }
        }
  
        if (typeof payload?.text !== "string") return { ok: false, error: "a config write needs a text body" };
        if (Buffer.byteLength(payload.text, "utf8") > MAX_CONFIG_BYTES) {
          return { ok: false, error: "the new body is too large to write" };
        }
        try {
          // Keep the previous body. This is someone's real configuration, a
          // mis-click is destructive, and the editor has no undo once the request
          // has left the browser.
          let backup = null;
          try {
            const previous = await store().readFile(path);
            backup = `${path}.dsh-session-hub.bak`;
            await store().writeText(backup, previous.toString("utf8"));
          } catch {
            backup = null;
          }
          await store().writeText(path, payload.text);
          const stats = await store().stat(path);
          return { ok: true, path, agent, bytes: stats.size, backup, environment: describeEnvironment() };
        } catch (error) {
          return { ok: false, error: `cannot write ${path}: ${String(error?.message ?? error)}` };
        }
      }
  
      return { ok: false, error: `unknown config action: ${action}` };
    },
  }),
  defineOp({
    name: "hosts",
    store: false,
    async handle(payload, ctx, host) {
    const { activateEnvironment, declaredConfigFiles, describeEnvironment, environmentCatalogue, environmentStatePath, fencedConfigPath, findEnvironment, hostCandidates, isHostAlias, mapLimit, probeEnvironment, readEnvironmentState, refreshEnvironmentList, store, writeActiveId, writeEnvironmentState , environmentState, LOCAL_ENVIRONMENT, MAX_CONFIG_BYTES, SOURCES } = host;
      const action = typeof payload?.action === "string" ? payload.action : "list";
      const sshConfigPath = join(localHome(), ".ssh", "config");
      const statePath = environmentStatePath();
  
      if (action === "list") {
        return { ok: true, sshConfigPath, statePath, hosts: await hostCandidates(ctx), active: describeEnvironment() };
      }
  
      if (action === "probe") {
        const alias = typeof payload?.alias === "string" ? payload.alias.trim() : "";
        // Any candidate may be tested, including one that is not an environment
        // yet — "does this machine work" is the question you ask *before* adding it.
        const candidate = (await hostCandidates(ctx)).find((row) => row.alias === alias);
        if (candidate === undefined) return { ok: false, error: `unknown host: ${alias}` };
        const probe = await probeEnvironment(
          {
            id: alias,
            kind: "remote",
            alias,
            label: candidate.label,
            ...(candidate.home === null ? {} : { home: candidate.home }),
            ...(candidate.dshHome === null ? {} : { dshHome: candidate.dshHome }),
          },
          { force: true },
        );
        return { ok: true, alias, probe };
      }
  
      if (action === "save" || action === "remove") {
        const alias = typeof payload?.alias === "string" ? payload.alias.trim() : "";
        if (!isHostAlias(alias)) return { ok: false, error: `${JSON.stringify(alias)} is not a usable ssh host name` };
  
        const state = await readEnvironmentState();
        const kept = state.hosts.filter((host) => host.alias !== alias);
  
        if (action === "save") {
          const label = typeof payload?.label === "string" ? payload.label.trim() : "";
          const entry = { alias, label: label === "" ? alias : label, enabled: payload?.enabled !== false };
          for (const key of ["home", "dshHome"]) {
            const value = payload?.[key];
            if (value === undefined || value === null || value === "") continue;
            if (typeof value !== "string" || !value.startsWith("/")) {
              return { ok: false, error: `${key} must be an absolute path` };
            }
            entry[key] = value.trim();
          }
          kept.push(entry);
        }
  
        if (!(await writeEnvironmentState({ ...state, hosts: kept }))) {
          return { ok: false, error: `could not write ${statePath}` };
        }
        await refreshEnvironmentList(ctx);
  
        // Hiding or forgetting the machine you are looking at has to move you off
        // it. Staying would leave the panel pointed at something no longer in the
        // catalogue — the "showing a machine I did not choose" state the switcher
        // exists to prevent.
        if (findEnvironment(environmentState.list, environmentState.activeId) === null) {
          await activateEnvironment(LOCAL_ENVIRONMENT.id, { force: true });
          await writeActiveId(LOCAL_ENVIRONMENT.id);
        }
  
        return {
          ok: true,
          sshConfigPath,
          statePath,
          hosts: await hostCandidates(ctx),
          active: describeEnvironment(),
          environments: environmentCatalogue(),
        };
      }
  
      return { ok: false, error: `unknown hosts action: ${action}` };
    },
  }),
];
