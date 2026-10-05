/**
 * ACP client core — drive an agent that speaks the Agent Client Protocol.
 *
 * This is the third transport. `store.js` answers "where do the bytes live" and
 * `openPlan` hands a session to the agent's own tool; this one *is* the agent's
 * partner, holding a conversation over its stdio.
 *
 * ## Where the wire details come from
 *
 * Not from memory. Method names are taken verbatim from the protocol's own
 * machine-readable `schema/v1/meta.json`, and every request body below was read
 * off `schema/v1/schema.json`:
 *
 *   InitializeRequest    protocolVersion*, clientCapabilities, clientInfo
 *   NewSessionRequest    cwd*, mcpServers*
 *   LoadSessionRequest   sessionId*, cwd*, mcpServers*
 *   PromptRequest        sessionId*, prompt*
 *   SessionNotification  sessionId*, update*      (the `session/update` params)
 *
 * **Version 1, deliberately.** v2 renames `authenticate` to `auth/login` and
 * replaces `session/load` with `session/resume`; the published capability matrix
 * still reports the v1 capability name `loadSession` for today's adapters, so v1
 * is what they actually speak.
 *
 * ## What is injected, and why
 *
 * `spawnChild` and `askPermission` are parameters rather than imports. The Host
 * owns "start a process" and "ask the person" — DSH exposes both (`subprocess`,
 * `approval`) — and a test can supply a fake without a network or a real agent.
 * Nothing in here reaches for a global.
 *
 * @module dsh-session-hub/acp
 */

import { spawn as nodeSpawn } from "node:child_process";

/** Client → agent methods, verbatim from schema/v1/meta.json. */
export const AGENT_METHOD = {
  initialize: "initialize",
  authenticate: "authenticate",
  newSession: "session/new",
  loadSession: "session/load",
  setMode: "session/set_mode",
  setConfigOption: "session/set_config_option",
  prompt: "session/prompt",
  cancel: "session/cancel",
  list: "session/list",
  resume: "session/resume",
  close: "session/close",
};

/** Agent → client methods, verbatim from schema/v1/meta.json. */
export const CLIENT_METHOD = {
  update: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
};

/** The protocol version this client speaks — v1, see the note above. */
export const PROTOCOL_VERSION = 1;

/** The default launcher, when the Host does not supply one. */
function defaultSpawn({ command, args, cwd, env }) {
  return nodeSpawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Start an ACP server and return a handle to talk to it.
 *
 * @param {object} options
 * @param {string} options.command Executable to run (e.g. `npx`).
 * @param {string[]} [options.args] Its arguments.
 * @param {string} [options.cwd] Working directory — the agent's workspace.
 * @param {object} [options.env]
 * @param {(spec: object) => object} [options.spawnChild] The Host's process
 *   launcher. Defaults to plain child_process, which is what tests use.
 * @param {(request: object) => Promise<object>} [options.askPermission] Answers
 *   `session/request_permission`. Without one every request is **cancelled** —
 *   never silently allowed, because a permission prompt is a person's decision
 *   and a client that guesses has removed the only thing standing there.
 */
export function connectAcp(options) {
  const { command, args = [], cwd, env, spawnChild = defaultSpawn, askPermission } = options;

  const child = spawnChild({ command, args, cwd, env });
  const pending = new Map();
  const listeners = { update: [], stderr: [], exit: [] };
  let nextId = 1;
  let buffer = "";
  let closed = false;

  const write = (message) => {
    if (closed) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* The child is gone; the exit handler is already reporting that. */
    }
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      // A request against a session that is already over must fail now: writing
      // into a dead pipe and waiting for a reply nobody will send is the hang
      // this core exists to avoid.
      if (closed) {
        reject(new Error(`the ACP session is closed (${method})`));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      write({ jsonrpc: "2.0", id, method, params });
    });

  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

  const settle = (id, outcome) => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (outcome.error !== undefined && outcome.error !== null) {
      const error = new Error(outcome.error.message ?? `${entry.method} failed`);
      error.code = outcome.error.code;
      entry.reject(error);
    } else {
      entry.resolve(outcome.result);
    }
  };

  /**
   * A request from the agent that needs an answer.
   *
   * These must always be answered — a JSON-RPC request with no reply leaves the
   * agent waiting forever, which reads to the person as a hang.
   */
  const onAgentRequest = async (message) => {
    if (message.method === CLIENT_METHOD.requestPermission) {
      let outcome = { outcome: { outcome: "cancelled" } };
      try {
        if (askPermission !== undefined) outcome = await askPermission(message.params);
      } catch {
        /* An answerer that throws is a refusal, not an approval. */
      }
      write({ jsonrpc: "2.0", id: message.id, result: outcome });
      return;
    }
    // Anything else is answered "not supported" rather than left hanging, so the
    // agent can fall back to its own tools instead of waiting on us.
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `the client does not implement ${message.method}` },
    });
  };

  const handleLine = (line) => {
    const text = line.trim();
    if (text === "") return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // ACP is newline-delimited JSON; a malformed line is noise, not a reason to
      // tear the conversation down.
      return;
    }
    if (message.method !== undefined) {
      if (message.id === undefined) {
        if (message.method === CLIENT_METHOD.update) {
          for (const listener of listeners.update) listener(message.params);
        }
        return;
      }
      void onAgentRequest(message);
      return;
    }
    if (message.id !== undefined) settle(message.id, message);
  };

  child.stdout.setEncoding?.("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      handleLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", (chunk) => {
    for (const listener of listeners.stderr) listener(String(chunk));
  });

  const onExit = (code, signal) => {
    closed = true;
    // Every in-flight request dies with the process. Leaving them pending would
    // hang the caller on an agent that is no longer there.
    for (const [, entry] of pending) entry.reject(new Error(`the agent exited (${signal ?? code}) during ${entry.method}`));
    pending.clear();
    for (const listener of listeners.exit) listener({ code, signal });
  };
  child.on("exit", onExit);
  child.on("error", (error) => onExit(null, error.message));

  return {
    child,
    /** Agent progress: `session/update` notifications, as they arrive. */
    onUpdate(listener) {
      listeners.update.push(listener);
      return () => {
        listeners.update = listeners.update.filter((one) => one !== listener);
      };
    },
    /** The agent's own stderr — its diagnostics, not ours. */
    onStderr(listener) {
      listeners.stderr.push(listener);
      return () => {
        listeners.stderr = listeners.stderr.filter((one) => one !== listener);
      };
    },
    onExit(listener) {
      listeners.exit.push(listener);
      return () => {
        listeners.exit = listeners.exit.filter((one) => one !== listener);
      };
    },

    /** The handshake. Everything else waits on this. */
    initialize(clientInfo = { name: "dsh-session-hub", version: "0.0.0" }) {
      return request(AGENT_METHOD.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo,
      });
    },
    authenticate(methodId) {
      return request(AGENT_METHOD.authenticate, { methodId });
    },
    newSession(sessionCwd, mcpServers = []) {
      return request(AGENT_METHOD.newSession, { cwd: sessionCwd, mcpServers });
    },
    /** Continue a session that already exists on the agent's side. */
    loadSession(sessionId, sessionCwd, mcpServers = []) {
      return request(AGENT_METHOD.loadSession, { sessionId, cwd: sessionCwd, mcpServers });
    },
    listSessions() {
      return request(AGENT_METHOD.list, {});
    },
    /** Send one turn. Resolves when the agent has finished answering it. */
    prompt(sessionId, text) {
      return request(AGENT_METHOD.prompt, { sessionId, prompt: [{ type: "text", text }] });
    },
    /** A notification, not a request: cancelling does not answer the prompt. */
    cancel(sessionId) {
      notify(AGENT_METHOD.cancel, { sessionId });
    },
    stop() {
      closed = true;
      try {
        child.kill();
      } catch {
        /* Already gone. */
      }
    },
  };
}
