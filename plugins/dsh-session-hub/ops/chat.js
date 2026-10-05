/**
 * The `chat` op: hold a live ACP conversation as a DSH session.
 *
 * ## What this op is
 *
 * It opens a conversation with an agent's own ACP server and projects it into a
 * DSH session — so the conversation renders in DSH's chat, while the **record
 * stays with the agent**. This op writes no durable history of its own: the
 * history lives where it always did, and the session here is the view of it.
 *
 * ## Two decisions worth stating
 *
 * **Local only, for now.** The ACP server must run on the machine that holds the
 * conversation. In a remote environment that machine is the other one, and
 * running a server over there is a different piece of work (streaming SSH) — so
 * this refuses with a sentence rather than failing somewhere confusing.
 *
 * **The command can be overridden.** `DSH_SESSION_HUB_ACP` takes a JSON argv
 * array and wins over the adapter's declaration. That is not only a test seam: a
 * person who installed the server themselves, or who wants a pinned local build
 * instead of `npx` fetching one, needs exactly this.
 *
 * @module dsh-session-hub/ops/chat
 */

import { connectAcp } from "../acp.js";
import { openAcpChat } from "../chat.js";
import { defineOp } from "./op.js";

/** Live conversations by session key, so a follow-up turn finds the same agent. */
const chats = new Map();

/**
 * The command that starts an agent's ACP server.
 *
 * @returns {{command: string, args: string[], source: string}|null} Null when the
 *   agent has no ACP server, which is a fact about the agent, not an error.
 */
export function acpCommandFor(adapter, env = process.env) {
  // **Whether** an agent has a server is the adapter's declaration, and an
  // override must not be able to invent one: `dsh` has no ACP server, and a
  // command from the environment must not silently make the panel offer a chat
  // that cannot work. The override only changes *how* the declared server starts.
  if (adapter?.acp === undefined || adapter.acp === null) return null;

  const override = env?.DSH_SESSION_HUB_ACP;
  if (typeof override === "string" && override.trim() !== "") {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) {
        return { command: parsed[0], args: parsed.slice(1), source: "DSH_SESSION_HUB_ACP" };
      }
    } catch {
      /* A malformed override falls back to the declaration rather than throwing
         in the middle of a click. */
    }
  }
  return { command: adapter.acp.command, args: [...adapter.acp.args], source: "adapter declaration" };
}

/**
 * The ways this session can be opened, derived from declarations — never a list.
 *
 * The card is required: `openPlan` builds a deep link out of the session's own
 * id, so calling it without one throws.
 */
export function openWaysFor(adapter, card) {
  const ways = [];
  const acp = acpCommandFor(adapter);
  if (acp !== null) ways.push({ id: "chat", label: "chat", source: acp.source });
  for (const step of adapter?.openPlan?.(card) ?? []) {
    if (step.kind === "app") ways.push({ id: "app", label: step.label ?? "app" });
    if (step.kind === "terminal") ways.push({ id: "terminal", label: "terminal" });
  }
  return ways;
}

export const chatOps = [
  defineOp({
    name: "chat",
    store: false,
    async handle(payload, ctx, host) {
      const action = typeof payload?.action === "string" ? payload.action : "open";
      const key = typeof payload?.key === "string" ? payload.key : "";

      if (action === "stop") {
        const live = chats.get(key);
        if (live === undefined) return { ok: true, stopped: false };
        live.chat.stop();
        chats.delete(key);
        return { ok: true, stopped: true };
      }

      // ACP runs the agent next to the conversation, so a remote environment
      // would need its own server. Say so plainly.
      if (host.environmentState.activeId !== host.LOCAL_ENVIRONMENT.id) {
        return { ok: false, error: "chatting over ACP runs on this machine only — switch to 本机 first" };
      }

      const card = host.findCard(key);
      if (card === null) return { ok: false, error: "unknown session key" };

      const adapter = host.adapterOf(card.agent);
      const command = acpCommandFor(adapter);
      if (command === null) {
        return { ok: false, error: `${card.agentLabel} has no ACP server this panel can start` };
      }

      const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
      if (sessions === undefined || typeof sessions.create !== "function") {
        return { ok: false, error: "this Host has no session store to render the conversation in" };
      }

      const live = chats.get(key);

      if (action === "prompt") {
        if (live === undefined) return { ok: false, error: "this conversation is not open" };
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (text.trim() === "") return { ok: false, error: "nothing to send" };
        const result = await live.chat.prompt(text);
        return { ok: true, sessionId: live.sessionId, stopReason: result?.stopReason ?? null };
      }

      // A second open on the same row replaces the first: two agents writing into
      // one conversation would interleave two histories.
      if (live !== undefined) {
        live.chat.stop();
        chats.delete(key);
      }

      const acp = connectAcp({ command: command.command, args: command.args, cwd: card.cwd ?? host.home() });
      // The person's own approval, or a refusal — never a silent allow.
      const approval = typeof ctx?.get === "function" ? ctx.get("approval") : undefined;
      const chat = await openAcpChat({
        sessions,
        acp,
        cwd: card.cwd ?? host.home(),
        sessionId: card.sessionId,
        provider: card.agent,
        model: card.model ?? undefined,
        preset: card.agent,
      });

      const sessionId = chat.session?.id ?? null;
      chats.set(key, { chat, sessionId, agent: card.agent, key });
      return {
        ok: true,
        // The DSH session the conversation renders in — the client navigates here.
        sessionId,
        // The id the agent knows it by: the same one when continued, a new one otherwise.
        acpSessionId: chat.acpSessionId,
        agent: card.agent,
        agentLabel: card.agentLabel,
        command: [command.command, ...command.args].join(" "),
      };
    },
  }),
];
