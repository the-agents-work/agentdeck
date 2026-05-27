import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentName, SessionStatus, SessionSummary } from "@pocket-agents/protocol";
import { DB_PATH, ensureConfigDir } from "./paths.ts";

/**
 * Persists sessions + their message history so:
 *  - Mobile can reconnect and "keep the conversation"
 *  - Multiple devices can read the same session (phone + tablet later)
 *  - Resume on next CLI start works after laptop reboot
 */
export class SessionStore {
  private readonly db: Database;

  constructor() {
    ensureConfigDir();
    this.db = new Database(DB_PATH);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        native_session_id TEXT,
        cwd TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        payload TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
    `);

    // Orphan cleanup: any session still marked "running" at boot was killed
    // mid-flight (Ctrl+C, laptop reboot, oom). Without this, the dashboard
    // would resume them and show a ghost WORKING timer that never advances
    // — there's no adapter in memory to push messages anymore.
    this.db
      .prepare(`UPDATE sessions SET status = 'error' WHERE status = 'running'`)
      .run();
  }

  createSession(opts: { agent: AgentName; title?: string; cwd?: string }): SessionSummary {
    const id = randomUUID();
    const now = Date.now();
    const title = opts.title?.trim() || `New chat · ${new Date(now).toLocaleString()}`;
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, cwd, status, created_at, last_message_at)
         VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, title, opts.agent, opts.cwd ?? null, now, now);
    return {
      id,
      title,
      agent: opts.agent,
      cwd: opts.cwd ?? null,
      createdAt: now,
      lastMessageAt: now,
      status: "idle",
      messageCount: 0,
    };
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.agent, s.status, s.cwd,
                s.native_session_id AS nativeSessionId,
                s.created_at AS createdAt,
                s.last_message_at AS lastMessageAt,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
         FROM sessions s
         ORDER BY s.last_message_at DESC`,
      )
      .all() as Array<SessionSummary & { agent: string; status: string; cwd: string | null }>;
    return rows.map((r) => ({
      ...r,
      agent: r.agent as AgentName,
      status: r.status as SessionStatus,
    }));
  }

  getSession(id: string): {
    id: string;
    title: string;
    agent: AgentName;
    nativeSessionId: string | null;
    cwd: string | null;
    status: SessionStatus;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, title, agent, native_session_id AS nativeSessionId,
                cwd, status
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      id: string;
      title: string;
      agent: string;
      nativeSessionId: string | null;
      cwd: string | null;
      status: string;
    } | null;
    if (!row) return null;
    return { ...row, agent: row.agent as AgentName, status: row.status as SessionStatus };
  }

  getMessages(sessionId: string): AgentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT type, text, payload FROM messages
         WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as Array<{ type: string; text: string | null; payload: string }>;
    return rows.map((r) => {
      const parsed = JSON.parse(r.payload) as AgentMessage;
      return parsed;
    });
  }

  appendMessage(sessionId: string, msg: AgentMessage): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const seq = (this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?`)
        .get(sessionId) as { next: number }).next;
      this.db
        .prepare(
          `INSERT INTO messages (session_id, seq, ts, type, text, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, seq, now, msg.type, msg.text ?? null, JSON.stringify(msg));
      this.db
        .prepare(`UPDATE sessions SET last_message_at = ? WHERE id = ?`)
        .run(now, sessionId);
    });
    tx();
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
  }

  setNativeSessionId(sessionId: string, nativeId: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET native_session_id = ? WHERE id = ?`)
      .run(nativeId, sessionId);
  }

  setTitle(sessionId: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
  }

  /** Return the wire-shape SessionSummary for a single id, or null. Same
   *  column set as listSessions() so subscribers can re-emit on update. */
  getSummary(id: string): SessionSummary | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.title, s.agent, s.status, s.cwd,
                s.native_session_id AS nativeSessionId,
                s.created_at AS createdAt,
                s.last_message_at AS lastMessageAt,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
         FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as (SessionSummary & { agent: string; status: string }) | null;
    if (!row) return null;
    return { ...row, agent: row.agent as AgentName, status: row.status as SessionStatus };
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
}
