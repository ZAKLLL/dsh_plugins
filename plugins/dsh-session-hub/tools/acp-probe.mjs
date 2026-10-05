/**
 * Manual probe: ask a real ACP server the questions the entry point depends on.
 *
 * **Not a test.** It reaches the network (npx downloads the server) and starts a
 * real agent process, so it is run by hand, on purpose:
 *
 *   PROBE_CMD=npx \
 *   PROBE_ARGS='["-y","--package=@agentclientprotocol/codex-acp@2.1.1","codex-acp"]' \
 *   node tools/acp-probe.mjs <cwd> [nativeSessionId]
 *
 * What it answered on 2026-10-05, against wave-2 adapters on this machine — the
 * facts below cost a real agent and a real download to establish, so they are
 * written down rather than re-derived:
 *
 *   - **A scoped package must be run as `npx -y --package=<pkg> <bin>`.** The bare
 *     form (`npx -y @scope/pkg`) ended in `sh: codex-acp: command not found`.
 *   - **`session/list` returns the NATIVE session ids** — they are byte-identical
 *     to what this plugin reads out of the agent's own store, and it also carries
 *     `cwd`, `title` and `updatedAt`. So "click a row → chat with it here" has a
 *     real id to load.
 *   - **`codex-acp` needs no explicit authenticate step**: it advertises
 *     `api-key` and `chat-gpt` but answered `session/new`, `session/load` and
 *     `prompt` straight away, reusing the machine's existing codex login.
 *   - **`session/load(<native id>)` succeeds.**
 *   - **`pi-acp` DOES require auth** (`pi_terminal_login`, type `terminal`) and
 *     answers `session/new` / `session/load` by **never replying** — no result, no
 *     error. That is why every request in `acp.js` has a deadline.
 *
 * @module dsh-session-hub/tools/acp-probe
 */

import { connectAcp } from "../acp.js";

// Command line comes from env so the probe can test the exact npx form the
// declaration will use (`--package=` matters for scoped packages).
const command = process.env.PROBE_CMD ?? "npx";
const args = JSON.parse(process.env.PROBE_ARGS ?? "[]");
const [cwd, sessionId] = process.argv.slice(2);
const show = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)?.slice(0, 700)}`);

const acp = connectAcp({
  command,
  args,
  cwd,
  env: process.env,
  timeoutMs: Number(process.env.PROBE_TIMEOUT ?? 12000),
});
acp.onStderr((chunk) => process.stderr.write(`  [stderr] ${String(chunk).slice(0, 300)}`));

const attempt = async (label, fn) => {
  try {
    const value = await fn();
    show(label, value);
    return { ok: true, value };
  } catch (error) {
    console.log(`  ${label}: ✗ ${error.message}`);
    return { ok: false, error };
  }
};

try {
  const init = await acp.initialize({ name: "dsh-session-hub-probe", version: "0.0.0" });
  console.log("== initialize");
  show("protocolVersion", init?.protocolVersion);
  show("agentCapabilities", init?.agentCapabilities);
  show("authMethods", (init?.authMethods ?? []).map((method) => ({ id: method.id, type: method.type })));

  console.log("\n== session/list（它认哪些会话 id —— 这才是入口的前提）");
  await attempt("list {}", () => acp.listSessions());
  await attempt("list {cwd}", () => acp.request?.("session/list", { cwd }));

  console.log("\n== session/new（未认证时给不给出会话）");
  const fresh = await attempt("new", () => acp.newSession(cwd));
  const newId = fresh.value?.sessionId;
  if (newId !== undefined) console.log(`  ← 新会话 id = ${newId}`);

  if (sessionId !== undefined) {
    console.log(`\n== session/load  <native id> ${sessionId}`);
    await attempt("load", () => acp.loadSession(sessionId, cwd));
    console.log(`  ← 报了错或超时都说明「原生 id 不能直接用」；只有回放才说明能用`);
  }

  if (newId !== undefined) {
    console.log("\n== 一次 prompt（证明链路是活的）");
    const updates = [];
    const off = acp.onUpdate((params) => updates.push(params));
    await attempt("prompt", () => acp.prompt(newId, "Reply with exactly: PROBE-OK"));
    off();
    console.log(`  收到 ${updates.length} 条 update:`);
    for (const update of updates.slice(0, 5)) {
      const kind = update?.update?.sessionUpdate ?? "?";
      const text = update?.update?.content?.text ?? "";
      console.log(`    - ${kind}: ${String(text).slice(0, 100)}`);
    }
  }
} catch (error) {
  console.log(`!! ${error.message}`);
} finally {
  acp.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(0);
}
