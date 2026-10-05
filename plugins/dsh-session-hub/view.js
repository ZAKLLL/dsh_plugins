/**
 * The view bridge: ACP `session/update` notifications → DSH session events.
 *
 * ## What this layer is, and is not
 *
 * The conversation's record lives **in the original agent** — it holds the
 * history and writes its own store. A DSH session built from this bridge is a
 * **view**: a projection that the chat box renders and that can be thrown away
 * and rebuilt (`session/load` asks the agent to replay). Nothing here writes a
 * durable record, and that is the point — two records would have to be kept in
 * step, and one view can simply be replaced.
 *
 * ## Why it is pure
 *
 * `session.append` is duck-typed rather than imported. The Host passes the real
 * `Session`; a test passes a recorder. That is also what makes the mapping — the
 * part that can actually be wrong — testable without DSH running.
 *
 * Field shapes are taken from DSH's own generated types, not guessed:
 * `MessageBase` is `{ id, content, source }`, `TextBlock` is `{ type: "text",
 * text }`, and a surface event needs a `SurfaceIntent` — `{ surfaceOp: "append" }`
 * — to reach the conversation at all.
 *
 * @module dsh-session-hub/view
 */

/** Content blocks from an ACP content payload, ignoring kinds we cannot show. */
function blocksOf(content) {
  if (content === null || content === undefined) return [];
  const list = Array.isArray(content) ? content : [content];
  const blocks = [];
  for (const block of list) {
    if (block?.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    // Reasoning is worth keeping: it is what the agent was thinking, and the chat
    // already knows how to render and fold it.
    if (block?.type === "reasoning" && typeof block.text === "string") {
      blocks.push({ type: "reasoning", text: block.text });
    }
  }
  return blocks;
}

const textOf = (blocks) => blocks.filter((block) => block.type === "text").map((block) => block.text).join("");

/**
 * Project one ACP session onto a DSH session.
 *
 * @param {object} options
 * @param {{ append: Function }} options.session A DSH Session (or anything with
 *   the same `append`), which is the only thing this layer writes to.
 * @param {() => string} [options.nextId] Message ids. DSH requires one per
 *   message and does not mint them for a foreign producer.
 * @param {() => number} [options.clock]
 * @param {string} [options.provider] Which agent is behind this view.
 * @param {string} [options.model]
 */
export function createAcpView(options) {
  const { session, provider = "acp", model = "unknown" } = options;
  const nextId = options.nextId ?? (() => `acp-${(idCounter += 1)}`);
  const clock = options.clock ?? Date.now;

  let turn = 0;
  let step = 0;
  let open = false;
  /** The assistant message being streamed, if any. */
  let current = null;
  const toolNames = new Map();

  const startTurn = () => {
    if (open) return;
    turn += 1;
    step = 1;
    open = true;
    session.append("turn/start", { turn });
    session.append("step/start", { turn, step });
  };

  const closeTurn = (reason) => {
    if (!open) return;
    closeMessage();
    session.append("step/end", { turn, step });
    session.append("turn/end", { turn, reason });
    open = false;
  };

  /**
   * Finish the streaming assistant message.
   *
   * DSH keeps a recorded stream beside the blocks, so the chat can replay how the
   * answer arrived rather than only showing the result. Chunks are recorded as
   * they come; this closes the block and the stream.
   */
  function closeMessage() {
    if (current === null) return;
    const blocks = current.blocks;
    if (blocks.length > 0) {
      current.stream.push({
        type: "chunk",
        time: clock(),
        chunk: { type: "block-end", index: 0, block: blocks[0] },
      });
    }
    for (const block of blocks) {
      session.append(
        "assistant/message",
        {
          turn,
          step,
          message: {
            id: current.id,
            role: "assistant",
            content: [block],
            source: { kind: "model", provider, model },
          },
          stream: current.stream,
        },
        { surfaceOp: "append" },
      );
    }
    current = null;
  }

  return {
    /**
     * Apply one `session/update` payload.
     *
     * Unknown update kinds are ignored rather than thrown on: the protocol
     * grows, and a view that dies on a new notification type would take the chat
     * with it.
     */
    update(params) {
      const update = params?.update ?? {};
      const kind = update.sessionUpdate;

      if (kind === "agent_message_chunk") {
        startTurn();
        const blocks = blocksOf(update.content);
        if (blocks.length === 0) return;
        if (current === null) {
          current = { id: nextId(), blocks: [], stream: [] };
          current.stream.push({
            type: "chunk",
            time: clock(),
            chunk: { type: "block-start", index: 0, blockType: "text" },
          });
        }
        if (current.blocks.length === 0) current.blocks.push({ type: "text", text: "" });
        current.blocks[0].text += textOf(blocks);
        current.stream.push({
          type: "chunk",
          time: clock(),
          chunk: { type: "text-delta", index: 0, text: textOf(blocks) },
        });
        return;
      }

      if (kind === "tool_call" || kind === "tool_call_update") {
        startTurn();
        const callId = update.toolCallId ?? update.toolCall?.toolCallId ?? "acp-tool";
        const name = update.title ?? update.toolCall?.title ?? update.kind ?? "tool";
        toolNames.set(callId, name);
        if (update.status === "completed" || update.status === "failed") {
          session.append(
            "tool/result",
            {
              turn,
              step,
              message: {
                id: nextId(),
                role: "tool",
                content: blocksOf(update.content),
                source: { kind: "tool", callId },
                toolCallId: callId,
              },
              ...(update.status === "failed" ? { error: { name, code: "acp_tool_failed" } } : {}),
            },
            { surfaceOp: "append" },
          );
          return;
        }
        session.append("tool/call", {
          turn,
          step,
          callId,
          name: String(name),
          arguments: typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput ?? {}),
        });
        return;
      }

      // `plan`, `available_commands_update`, `current_mode_update` and friends are
      // agent metadata; the chat has nowhere to put them yet.
    },

    /** The agent finished the turn it was asked for. */
    endTurn(stopReason) {
      closeTurn(stopReason === "cancelled" ? { kind: "interrupted" } : { kind: "completed" });
    },

    /** A turn the person sent, so their own words appear in the view too. */
    userTurn(text) {
      startTurn();
      session.append(
        "user/message",
        { id: nextId(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
        { surfaceOp: "append" },
      );
    },

    /** Abandon whatever is open, for a session being torn down mid-answer. */
    interrupt() {
      closeTurn({ kind: "interrupted" });
    },
  };
}

let idCounter = 0;
