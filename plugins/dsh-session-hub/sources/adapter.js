/**
 * dsh-session-hub — the agent adapter contract.
 *
 * Every agent-specific fact lives behind this interface. The machinery in
 * `../index.js` — walking, caching, liveness, transcripts, delete guards — must
 * never branch on an agent id; it asks the adapter instead. The moment a
 * function needs to ask "which agent is this?", it belongs here.
 *
 * Adding an agent means writing one module in this directory that satisfies the
 * shape below and listing it in `./index.js`. Nothing else changes.
 *
 * @module dsh-session-hub/sources/adapter
 */

/**
 * One normalized session, as the panel consumes it.
 *
 * @typedef {object} Value
 * @property {SessionCard} card Normalized metadata, ready to render.
 * @property {string} body Markdown transcript body (may be empty for a source
 *   that answers `full()` on demand).
 * @property {object} meta Adapter-private extras; the Host passes them through.
 */

/**
 * @typedef {object} SessionCard
 * @property {string} key Stable identity: `"<agent>:<store path or id>"`.
 * @property {string} agent The adapter id.
 * @property {string} agentLabel Human name, for display.
 * @property {string} sessionId The id the agent's own CLI resumes with.
 * @property {string} title Never empty — falls back to `UNTITLED`.
 * @property {string|null} cwd Workspace the session ran in.
 * @property {string|null} project Last path segment of `cwd`.
 * @property {number|null} createdAt Epoch ms.
 * @property {number|null} updatedAt Epoch ms; drives sorting and "how recent".
 * @property {number} bytes Store size, or 0 when that is meaningless.
 * @property {number} messages Human/assistant turns counted.
 * @property {boolean} partial True when only a prefix was read.
 * @property {boolean} subagent True when this is a delegated child session.
 * @property {string|null} parentSessionId Parent, when the dialect records one.
 * @property {number} depth Delegation depth, 0 at the root.
 * @property {string} file Store path, for display and provenance.
 * @property {string|null} resumeCommand Exact command that reopens it.
 */

/**
 * What a running session has spent.
 *
 * @typedef {object} Tokens
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} total
 */

/**
 * What a running session is waiting on.
 *
 * `kind: "approval"` means the agent asked for permission and has not been
 * answered — a fact. `kind: "tool"` means a tool call has no matching result,
 * which may mean it is running or may mean it is waiting; callers must not
 * present it as a confirmed approval wait.
 *
 * @typedef {object} Pending
 * @property {"approval"|"tool"} kind
 * @property {string|null} label Tool name, when known.
 * @property {number} count How many are outstanding.
 */

/**
 * The verdict of one adapter read against a live store.
 *
 * @typedef {object} Reading
 * @property {Tokens|null} tokens
 * @property {Pending|null} pending
 */

/**
 * How a store is laid out on disk, which decides how it can be re-read.
 *
 * - `"jsonl"` — append-only JSON lines; readable from a byte offset.
 * - `"frames"` — concatenated zstd frames (DSH); **not** byte-addressable, so it
 *   is decoded whole and gated on mtime + size.
 * - `null` — no incremental reading is defined for this store.
 *
 * @typedef {"jsonl"|"frames"|null} StoreKind
 */

/**
 * An attachable file standing in for one session.
 *
 * `origin` says whether this *is* the store artifact or a copy an adapter made,
 * because "drag the session file" has no single answer across dialects.
 *
 * @typedef {object} Handoff
 * @property {string} path Absolute path of a readable file.
 * @property {string} name Suggested attachment name.
 * @property {"native"|"dump"} origin
 * @property {number} bytes
 */

/**
 * The store artifact a session lives in.
 *
 * The Host owns the guards (unknown key, running session, store-root fence); an
 * adapter only says what to remove and what extra bookkeeping that implies.
 *
 * @typedef {object} DeletePlan
 * @property {string} target Absolute path to remove.
 * @property {boolean} recursive True when `target` is a directory.
 * @property {(store: object) => Promise<boolean>} [after] Runs after a successful
 *   removal; returns whether it changed anything. This is where an adapter
 *   cleans up state it keeps elsewhere (Codex's name index, for instance). It
 *   receives the active store, because that state may live on the same remote
 *   machine the session did.
 */

/**
 * The accumulating state one live store read carries between polls.
 *
 * @typedef {object} ReadingState
 * @property {Set<string>} asked Approval ids that were asked.
 * @property {Set<string>} decided Approval ids that were answered.
 * @property {Map<string, string|null>} approvalTools Approval id → tool name.
 * @property {Map<string, string|null>} tools Live tool call id → tool name.
 */

/**
 * The reading a preview walk builds up from a store tail.
 *
 * @typedef {object} PreviewState
 * @property {string|null} input Last human message.
 * @property {string|null} output Last visible assistant text.
 * @property {number|null} at Epoch ms of whichever message set `output`.
 */

/**
 * One file that configures an agent.
 *
 * Paths are absolute and derived from `home()`/`dshHome()`, exactly like
 * `root()` — which is what makes the config viewer work against another machine
 * with no extra machinery: the same call answers "where is Claude's settings
 * file" for whichever environment is active.
 *
 * @typedef {object} ConfigFile
 * @property {string} path Absolute path on the active environment.
 * @property {string} label Human name, e.g. "settings.json".
 * @property {"json"|"toml"|"yaml"|"markdown"|"text"} [language] Syntax hint.
 * @property {boolean} [sensitive] Holds credentials or tokens. The client hides
 *   the body until it is explicitly revealed, so opening the panel cannot leak a
 *   key onto a screen someone else is looking at.
 * @property {boolean} [creatable] Offer an empty editor when the file is absent,
 *   which is how a config that has never been written gets written.
 */

/**
 * The contract every agent adapter satisfies.
 *
 * @typedef {object} AgentAdapter
 *
 * // --- identity -------------------------------------------------------
 * @property {string} id Matches `SessionCard.agent` and the `"<id>:"` key prefix.
 * @property {string} label Human name.
 * @property {string[]} executables Process basenames that mean "this agent is
 *   running". Matched against the executable *and* the first argument, because
 *   macOS reports a shebang script as `/bin/sh <script>` and a wrapper as
 *   `node /path/to/<agent>-wrapper`.
 * @property {string|null} spawnCommand Shell command that starts a fresh
 *   interactive session, or null when the plugin cannot start this agent (DSH
 *   sessions are created through the DSH workspace registry instead).
 * @property {boolean} [clientOwned] True when *opening* an existing session is
 *   the client's job rather than a terminal launch — DSH opens in the DSH UI.
 * @property {"registry"|"process"} [liveness] Where "is this running" comes
 *   from. `"registry"` reads the in-process agent registry, which is the only
 *   correct answer for an agent that IS this process; `"process"` (the default)
 *   reads the process table, which is the only thing that sees an agent started
 *   straight from a terminal.
 * @property {(sessionId: string) => string|null} resumeCommand
 * @property {(card: SessionCard) => SessionArtifact} sessionFile The store
 *   artifact this session lives in — exact, and what the delete fence and the
 *   transcript header cite.
 * @property {(card: SessionCard, options: {dir: string}) => Promise<Handoff>} [handoff]
 *   Hand this session over as an attachable file. Omit it when the store is
 *   already one readable file, and the Host returns that file directly; provide
 *   it to dump a portable copy instead (opencode's database row). A dialect
 *   may also leave it out *and* keep a non-file `sessionFile.kind`, which means
 *   there is genuinely nothing to hand over — a DSH session dragged inside DSH.
 *
 * // --- inventory: one directory of session files ----------------------
 * @property {() => string} root Directory to walk. Always present, even for a
 *   self-served store, where it names the store's own directory for display.
 * @property {(fileName: string) => boolean} [match] Which files are sessions.
 * @property {number} [concurrency] Files parsed in parallel.
 * @property {{start: number, max: number, complete: (events: object[]) => boolean}} [prefix]
 *   How to grow a prefix read until it holds what `build` needs.
 * @property {BuildValue} [build] Turn one store file into a `Value`.
 *
 * // --- inventory: a store that is not a directory of files ------------
 * @property {(force: boolean) => Promise<Value[]>} [list] Answer the whole
 *   inventory itself (opencode's SQLite, for instance).
 * @property {(rest: string) => Promise<Value|null>} [full] Re-read one session
 *   fully, keyed by whatever follows `"<id>:"` in the key.
 * @property {(card: SessionCard) => Promise<Reading|null>} [preview] Read a
 *   store that `readStoreEvent` cannot walk.
 * @property {(card: SessionCard) => Promise<void>} [remove] Delete through the
 *   store's own handle, for a self-served store.
 *
 * // --- per-dialect readings -------------------------------------------
 * @property {(input: {store: object, files: string[]}) => Promise<void>} [hydrate]
 *   Do async preparation through the **active store** before `build` runs.
 *
 *   A dialect sometimes needs a second file to interpret the first — Codex keeps
 *   its model-generated thread names in a sibling index, Gemini mirrors a
 *   project root in `.project_root`. `build` is synchronous by contract, so
 *   those reads cannot happen inside it, and doing them with `node:fs` directly
 *   would read *this* machine while the panel is pointed at another one.
 *
 *   `hydrate` is called once per source per scan (and again before a full
 *   re-read), receives the same store every other read goes through, and is
 *   expected to populate a module-level cache that the synchronous reader then
 *   consults. It must be cheap when nothing changed.
 *
 * @property {StoreKind} [storeKind] Defaults to `null` (no store reading).
 * @property {(event: object, state: PreviewState) => void} [readPreview]
 *   Fold one store event into the live preview's IN/OUT.
 * @property {(event: object, state: ReadingState) => void} [readStoreEvent]
 *   Fold one store event into the token total and the waiting set.
 *
 * // --- deletion --------------------------------------------------------
 * @property {(card: SessionCard) => DeletePlan} [deletePlan] Defaults to
 *   removing `card.file`.
 *
 * // --- configuration ---------------------------------------------------
 * @property {() => ConfigFile[]} [configFiles] The files that configure this
 *   agent. Omitted when the agent has no config worth showing. The Host fences
 *   every read and write to exactly these paths, so a viewer can never be
 *   pointed at an arbitrary file.
 */

/**
 * @callback BuildValue
 * @param {string} file
 * @param {{size: number, mtimeMs: number, birthtimeMs?: number}} stats
 * @param {object[]|Buffer} input Parsed events from the prefix read — **or**,
 *   when `storeKind` is `"frames"`, the whole store as a `Buffer`. A frames
 *   store is not byte-addressable, so there is no prefix to parse; the engine
 *   reads it through the active store and hands the bytes over, because an
 *   adapter that read them itself would read the wrong machine. This is also
 *   what keeps `build` synchronous for every adapter.
 * @param {boolean} truncated True when the prefix was capped before `complete`.
 * @returns {Value}
 */

/**
 * Declare an adapter, failing at module load rather than at the first request.
 *
 * A plugin whose adapter is malformed should not come up half-working: a missing
 * `match` would silently inventory nothing, and a missing `resumeCommand` would
 * silently offer no way back. Both are cheap to catch here.
 *
 * @param {AgentAdapter} spec
 * @returns {AgentAdapter} The same object, so a module can `export default`.
 */
export function defineAdapter(spec) {
  const problems = [];
  if (typeof spec?.id !== "string" || spec.id === "") problems.push("id");
  if (typeof spec?.label !== "string" || spec.label === "") problems.push("label");
  if (!Array.isArray(spec?.executables)) problems.push("executables[]");
  if (typeof spec?.root !== "function") problems.push("root()");
  if (typeof spec?.resumeCommand !== "function") problems.push("resumeCommand()");
  if (typeof spec?.sessionFile !== "function") problems.push("sessionFile()");

  const fileBacked = typeof spec?.build === "function";
  const selfServed = typeof spec?.list === "function";
  if (fileBacked === selfServed) problems.push("exactly one of build() or list()");
  if (fileBacked && typeof spec?.match !== "function") problems.push("match() (required by build())");

  // A declaration that cannot be run is worse than none: the panel would offer a
  // chat that fails at the first click.
  if (spec?.acp !== undefined && spec?.acp !== null) {
    if (typeof spec.acp.command !== "string" || spec.acp.command === "") problems.push("acp.command");
    if (!Array.isArray(spec.acp.args) || spec.acp.args.some((arg) => typeof arg !== "string")) {
      problems.push("acp.args (must be an array of strings)");
    }
  }

  if (problems.length > 0) {
    throw new Error(`session-hub adapter "${spec?.id ?? "?"}" is missing: ${problems.join(", ")}`);
  }
  if (spec.spawnCommand !== undefined && spec.spawnCommand !== null && typeof spec.spawnCommand !== "string") {
    throw new Error(`session-hub adapter "${spec.id}": spawnCommand must be a string or null`);
  }
  if (spec.configFiles !== undefined && typeof spec.configFiles !== "function") {
    throw new Error(`session-hub adapter "${spec.id}": configFiles must be a function returning ConfigFile[]`);
  }
  return spec;
}
