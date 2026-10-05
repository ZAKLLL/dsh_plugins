/**
 * A fake ACP server, for testing the client core without an agent.
 *
 * It is deliberately literal about the protocol: newline-delimited JSON-RPC 2.0,
 * the v1 method names, and the request bodies from `schema/v1/schema.json`. It
 * answers by the *text* of the prompt so a test can ask for one behaviour at a
 * time, which is the only concession it makes to being a test fixture.
 *
 * @module dsh-session-hub/test/fake-acp
 */

import { createInterface } from "node:readline";

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let nextId = 1000;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const text = line.trim();
  if (text === "") return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  // A reply to something we asked.
  if (message.id !== undefined && message.method === undefined) {
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
    return;
  }

  const reply = (result) => out({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text2) => out({ jsonrpc: "2.0", id: message.id, error: { code, message: text2 } });
  const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

  let sessionId = "fake-session";

  if (message.method === "initialize") {
    // Echo the negotiated version so a test can see what the client asked for.
    reply({ protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true } });
    return;
  }

  if (message.method === "session/new") {
    reply({ sessionId });
    return;
  }

  if (message.method === "session/load") {
    sessionId = message.params.sessionId;
    reply({ sessionId, loaded: true, cwd: message.params.cwd });
    return;
  }

  if (message.method === "session/list") {
    reply({ sessions: [{ sessionId, cwd: process.cwd() }] });
    return;
  }

  if (message.method === "session/prompt") {
    sessionId = message.params.sessionId;
    const asked = (message.params.prompt ?? []).map((block) => block.text ?? "").join("");

    // Progress first, so the client has to stream before it can resolve.
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking…" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `you said: ${asked}` } });

    if (asked === "permission") {
      const answer = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "run tests", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      reply({ stopReason: "end_turn", answer });
      return;
    }

    if (asked === "no-answer") {
      // A real server did exactly this: `session/load` on an unauthenticated
      // agent never replied. Swallowing the request reproduces it.
      return;
    }

    if (asked === "unknown-request") {
      // A capability this client does not implement. It must still be answered.
      const answer = await request("fs/read_text_file", { sessionId, path: "/etc/hosts" });
      reply({ stopReason: "end_turn", answer });
      return;
    }

    reply({ stopReason: "end_turn" });
    return;
  }

  if (message.method === "session/cancel") return;

  fail(-32601, `the fake server does not implement ${message.method}`);
});
