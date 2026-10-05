/**
 * Open a DSH conversation as a live view over an ACP agent.
 *
 * This is the glue the entry point needs, and it is deliberately thin: it
 * creates a session, pipes the agent's updates into a view, and forwards the
 * person's turns. The two hard parts live next door and are tested on their own
 * — `acp.js` speaks the protocol, `view.js` knows DSH's event shapes.
 *
 * ## The seam, again
 *
 * `sessions` and the ACP handle are **parameters**. The Host passes the real
 * ones; a test passes a fake session store and the fake ACP server. That is what
 * keeps "who owns the conversation" an honest question: this module never writes
 * a durable record, because the agent is the record and this is the view of it.
 *
 * @module dsh-session-hub/chat
 */

import { createAcpView } from "./view.js";

/**
 * @param {object} options
 * @param {{ create: (id?: string, options?: object) => object }} options.sessions
 *   DSH's session store — or anything with the same `create`.
 * @param {object} options.acp A handle from `connectAcp`.
 * @param {string} options.cwd The agent's workspace.
 * @param {string} [options.sessionId] An existing session to continue. Omitted
 *   starts a new conversation instead.
 * @param {string} [options.provider] Recorded on every message, so the view says
 *   which agent answered.
 * @param {string} [options.model]
 * @param {string} [options.preset] Written to the session header — this is how a
 *   row in the session list says "codex" rather than showing an anonymous chat.
 * @param {(error: Error) => void} [options.onError]
 */
export async function openAcpChat(options) {
  const { sessions, acp, cwd, sessionId, provider = "acp", model, preset, onError } = options;

  const session = sessions.create(undefined, {
    // The header is the only place provenance can live for a session the Host did
    // not create through its own loop.
    meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset }) },
  });

  const view = createAcpView({ session, provider, ...(model === undefined ? {} : { model }) });
  const stopUpdates = acp.onUpdate((params) => view.update(params));

  let acpSessionId = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopUpdates();
    acp.stop();
  };

  try {
    const opened = sessionId === undefined || sessionId === null || sessionId === ""
      ? await acp.newSession(cwd)
      : await acp.loadSession(sessionId, cwd);
    acpSessionId = opened?.sessionId ?? sessionId ?? null;
  } catch (error) {
    // A conversation that never opened must not leave a half-built view behind,
    // and the agent process must not be left running for it.
    stop();
    if (onError !== undefined) onError(error);
    throw error;
  }

  return {
    session,
    view,
    /** The id the agent knows this conversation by — native id when resumed. */
    get acpSessionId() {
      return acpSessionId;
    },
    /**
     * Send one turn and wait for the agent to finish answering it.
     *
     * The person's own words go into the view too: otherwise the conversation
     * reads as answers to questions nobody asked.
     */
    async prompt(text) {
      view.userTurn(text);
      try {
        const result = await acp.prompt(acpSessionId, text);
        view.endTurn(result?.stopReason);
        return result;
      } catch (error) {
        // An interrupted turn still shows what arrived; the error is the caller's
        // to report.
        view.interrupt();
        throw error;
      }
    },
    stop,
  };
}
