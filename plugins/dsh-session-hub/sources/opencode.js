/**
 * dsh-session-hub — opencode adapter.
 *
 * One SQLite database rather than a file per session, so this adapter answers
 * the whole inventory itself: list, full, preview and remove all go through the
 * database handle by session id.
 *
 * @module dsh-session-hub/sources/opencode
 */

import { dirname, join } from "node:path";
import { defineAdapter } from "./adapter.js";
import { UNTITLED, dumpText, handoffName, home, looksInjected, oneLine, projectOf } from "../shared.js";

/** The one place this adapter spells its own name. */
const LABEL = "opencode";

function opencodeDbPath() {
  return join(home(), ".local", "share", "opencode", "opencode.db");
}

/** Open the database, or return null when it is absent or unreadable. */

/** Open the database, or return null when it is absent or unreadable. */
async function openOpencode({ readOnly }) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(opencodeDbPath(), { readOnly });
  } catch {
    return null;
  }
}

/** The concatenated text of one message's `part` rows. */

/** The concatenated text of one message's `part` rows. */
function opencodeText(parts) {
  const chunks = [];
  for (const row of parts) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data?.type === "text" && typeof data.text === "string") chunks.push(data.text);
  }
  return chunks.join("\n").trim();
}

/** One card per session row, without reading any message bodies. */

/** One card per session row, without reading any message bodies. */
async function listOpencode() {
  const db = await openOpencode({ readOnly: true });
  if (db === null) return [];
  try {
    const rows = db
      .prepare("select id, parent_id, directory, title, time_created, time_updated from session")
      .all();
    const counts = new Map(
      db
        .prepare("select session_id, count(*) as n from message group by session_id")
        .all()
        .map((row) => [row.session_id, row.n]),
    );

    return rows.map((row) => ({
      card: {
        key: `opencode:${row.id}`,
        agent: "opencode",
        agentLabel: LABEL,
        sessionId: row.id,
        title: typeof row.title === "string" && row.title !== "" ? oneLine(row.title, 140) : UNTITLED,
        cwd: typeof row.directory === "string" ? row.directory : null,
        project: projectOf(row.directory),
        createdAt: Number(row.time_created) || null,
        updatedAt: Number(row.time_updated) || null,
        // A row has no byte size; the panel renders that as "—".
        bytes: 0,
        messages: counts.get(row.id) ?? 0,
        // Sessions are read completely in one query, so nothing is a prefix.
        partial: false,
        subagent: row.parent_id !== null,
        parentSessionId: typeof row.parent_id === "string" ? row.parent_id : null,
        depth: 0,
        file: opencodeDbPath(),
        resumeCommand: `opencode --session ${row.id}`,
      },
      body: "",
      meta: {},
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Read one opencode session in full, for the transcript and the preview. */

/** Read one opencode session in full, for the transcript and the preview. */
async function readOpencode(sessionId, { withBody }) {
  const db = await openOpencode({ readOnly: true });
  if (db === null) return null;
  try {
    const row = db.prepare("select * from session where id = ?").get(sessionId);
    if (row === undefined) return null;

    const messages = db
      .prepare("select id, data from message where session_id = ? order by time_created, id")
      .all(sessionId);
    const parts = db
      .prepare("select message_id, data from part where session_id = ? order by time_created, id")
      .all(sessionId);
    const byMessage = new Map();
    for (const part of parts) {
      if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
      byMessage.get(part.message_id).push(part);
    }

    let input = null;
    let output = null;
    const lines = [];
    let count = 0;
    for (const message of messages) {
      let meta;
      try {
        meta = JSON.parse(message.data);
      } catch {
        continue;
      }
      const body = opencodeText(byMessage.get(message.id) ?? []);
      if (body === "") continue;
      if (meta?.role === "user") {
        if (looksInjected(body)) continue;
        count += 1;
        if (input === null) input = body;
        if (withBody) lines.push("## User", "", body, "");
      } else if (meta?.role === "assistant") {
        count += 1;
        output = body;
        if (withBody) lines.push("## Assistant", "", body, "");
      }
    }

    const card = {
      key: `opencode:${row.id}`,
      agent: "opencode",
      agentLabel: LABEL,
      sessionId: row.id,
      title:
        typeof row.title === "string" && row.title !== "" ? oneLine(row.title, 140) : oneLine(input ?? "", 140) || UNTITLED,
      cwd: typeof row.directory === "string" ? row.directory : null,
      project: projectOf(row.directory),
      createdAt: Number(row.time_created) || null,
      updatedAt: Number(row.time_updated) || null,
      bytes: 0,
      messages: count,
      partial: false,
      subagent: row.parent_id !== null,
      parentSessionId: typeof row.parent_id === "string" ? row.parent_id : null,
      depth: 0,
      file: opencodeDbPath(),
      resumeCommand: `opencode --session ${row.id}`,
    };
    return { card, body: lines.join("\n").trimEnd(), meta: { preview: { input, output } } };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Delete one opencode session.
 *
 * opencode owns this database and may be writing to it, so the caller's
 * running-process guard is what keeps this safe; the three deletes run in one
 * transaction so a failure cannot leave a session half-removed.
 */

/**
 * Delete one opencode session.
 *
 * opencode owns this database and may be writing to it, so the caller's
 * running-process guard is what keeps this safe; the three deletes run in one
 * transaction so a failure cannot leave a session half-removed.
 */
async function removeOpencode(sessionId) {
  const db = await openOpencode({ readOnly: false });
  if (db === null) throw new Error("opencode database is not readable");
  try {
    db.exec("begin");
    db.prepare("delete from part where session_id = ?").run(sessionId);
    db.prepare("delete from message where session_id = ?").run(sessionId);
    db.prepare("delete from session where id = ?").run(sessionId);
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      /* The transaction may already be gone. */
    }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Hand this session over as a readable file.
 *
 * opencode has no per-session file at all — the session is a row in a shared
 * database — so the row is read and dumped.
 */
async function handoffOpencode(card, { dir }) {
  const value = await readOpencode(card.sessionId, { withBody: true });
  return dumpText(dir, handoffName(card), value === null ? "" : value.body);
}

export default defineAdapter({
  id: "opencode",
  handoff: handoffOpencode,
  sessionFile: (card) => ({ path: opencodeDbPath(), kind: "record", label: handoffName(card) }),
  label: LABEL,
  executables: ["opencode"],
  spawnCommand: "opencode",
  resumeCommand: (id) => `opencode --session ${id}`,
  root: () => dirname(opencodeDbPath()),
  // Its config lives outside the store, in the XDG config directory, and is the
  // one file here that usually does not exist yet — which is why it is creatable.
  configFiles: () => [
    { path: join(home(), ".config", "opencode", "opencode.json"), label: "opencode.json", language: "json", creatable: true },
  ],
  storeKind: null,
  list: () => listOpencode(),
  full: (sessionId) => readOpencode(sessionId, { withBody: true }),
  preview: (card) => readOpencode(card.sessionId, { withBody: false }),
  remove: (card) => removeOpencode(card.sessionId),
});
