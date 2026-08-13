import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { WeixinMedia, WeixinMessage } from "../../shared/types";

const require = createRequire(import.meta.url);

export interface StoredBotState {
  workspacePath?: string;
  sessionId?: string;
  sessionPath?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  updatesBuffer: string;
  trustedAt?: number;
  autoLaunch: boolean;
  compactionCount: number;
  lastError?: string;
  paused: boolean;
}

export type WeixinOutboxPayload =
  | { kind: "text"; to: string; text: string }
  | { kind: "media"; to: string; localPath: string };

interface StateRow {
  workspace_path: string | null; session_id: string | null; session_path: string | null;
  account_id: string | null; user_id: string | null; base_url: string | null;
  updates_buffer: string; trusted_at: number | null; auto_launch: number;
  compaction_count: number; last_error: string | null; paused: number;
}

interface MessageRow {
  id: number; platform_id: string | null; direction: WeixinMessage["direction"];
  source: WeixinMessage["source"]; role: WeixinMessage["role"]; text: string;
  media_json: string; status: WeixinMessage["status"]; created_at: number;
}

export class WeixinStore {
  private readonly db: DatabaseSync;
  readonly rootPath: string;
  readonly mediaPath: string;
  readonly secretsFallbackPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.mediaPath = path.join(rootPath, "media");
    this.secretsFallbackPath = path.join(rootPath, "credentials.json");
    fsSync.mkdirSync(this.mediaPath, { recursive: true, mode: 0o700 });
    const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as typeof import("node:sqlite");
    const file = path.join(rootPath, "state.sqlite");
    this.db = new SQLiteDatabase(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS weixin_bot_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), workspace_path TEXT, session_id TEXT, session_path TEXT,
        account_id TEXT, user_id TEXT, base_url TEXT, updates_buffer TEXT NOT NULL DEFAULT '',
        trusted_at INTEGER, auto_launch INTEGER NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, paused INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO weixin_bot_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS weixin_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, platform_id TEXT UNIQUE, direction TEXT NOT NULL,
        source TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', media_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS weixin_messages_created_idx ON weixin_messages(id DESC);
      CREATE TABLE IF NOT EXISTS weixin_inbox (
        platform_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weixin_outbox (
        client_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    fsSync.chmodSync(file, 0o600);
  }

  close(): void { this.db.close(); }

  getState(): StoredBotState {
    const row = this.db.prepare("SELECT * FROM weixin_bot_state WHERE id=1").get() as unknown as StateRow;
    return {
      ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.session_path ? { sessionPath: row.session_path } : {}),
      ...(row.account_id ? { accountId: row.account_id } : {}),
      ...(row.user_id ? { userId: row.user_id } : {}),
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      updatesBuffer: row.updates_buffer,
      ...(row.trusted_at ? { trustedAt: row.trusted_at } : {}),
      autoLaunch: Boolean(row.auto_launch),
      compactionCount: row.compaction_count,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      paused: Boolean(row.paused),
    };
  }

  patchState(patch: Partial<StoredBotState>): StoredBotState {
    const current = { ...this.getState(), ...patch };
    this.db.prepare(`UPDATE weixin_bot_state SET workspace_path=?,session_id=?,session_path=?,account_id=?,user_id=?,base_url=?,
      updates_buffer=?,trusted_at=?,auto_launch=?,compaction_count=?,last_error=?,paused=? WHERE id=1`).run(
      current.workspacePath ?? null, current.sessionId ?? null, current.sessionPath ?? null,
      current.accountId ?? null, current.userId ?? null, current.baseUrl ?? null,
      current.updatesBuffer, current.trustedAt ?? null, current.autoLaunch ? 1 : 0,
      current.compactionCount, current.lastError ?? null, current.paused ? 1 : 0,
    );
    return current;
  }

  addMessage(input: Omit<WeixinMessage, "id" | "createdAt"> & { createdAt?: number }): WeixinMessage {
    const createdAt = input.createdAt ?? Date.now();
    const result = this.db.prepare(`INSERT INTO weixin_messages(platform_id,direction,source,role,text,media_json,status,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(platform_id) DO NOTHING`).run(
      input.platformId ?? null, input.direction, input.source, input.role, input.text,
      JSON.stringify(input.media), input.status, createdAt,
    );
    if (result.changes === 0 && input.platformId) {
      const existing = this.db.prepare("SELECT * FROM weixin_messages WHERE platform_id=?").get(input.platformId) as unknown as MessageRow;
      return rowToMessage(existing);
    }
    const row = this.db.prepare("SELECT * FROM weixin_messages WHERE id=last_insert_rowid()").get() as unknown as MessageRow;
    return rowToMessage(row);
  }

  updateMessage(id: number, status: WeixinMessage["status"], text?: string): WeixinMessage | undefined {
    if (text === undefined) this.db.prepare("UPDATE weixin_messages SET status=? WHERE id=?").run(status, id);
    else this.db.prepare("UPDATE weixin_messages SET status=?,text=? WHERE id=?").run(status, text, id);
    const row = this.db.prepare("SELECT * FROM weixin_messages WHERE id=?").get(id) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  updateMessageByPlatformId(platformId: string, status: WeixinMessage["status"]): WeixinMessage | undefined {
    this.db.prepare("UPDATE weixin_messages SET status=? WHERE platform_id=?").run(status, platformId);
    const row = this.db.prepare("SELECT * FROM weixin_messages WHERE platform_id=?").get(platformId) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  history(before?: number, limit = 100): { messages: WeixinMessage[]; hasMore: boolean; before?: number } {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = (before
      ? this.db.prepare("SELECT * FROM weixin_messages WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, safeLimit + 1)
      : this.db.prepare("SELECT * FROM weixin_messages ORDER BY id DESC LIMIT ?").all(safeLimit + 1)) as unknown as MessageRow[];
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit).reverse().map(rowToMessage);
    return { messages: page, hasMore, ...(hasMore && page[0] ? { before: page[0].id } : {}) };
  }

  persistInbox(platformId: string, payload: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO weixin_inbox(platform_id,payload_json,status,created_at) VALUES(?,?,'pending',?)")
      .run(platformId, JSON.stringify(payload), Date.now()).changes > 0;
  }
  completeInbox(platformId: string): void { this.db.prepare("UPDATE weixin_inbox SET status='complete' WHERE platform_id=?").run(platformId); }
  pendingInbox(): Array<{ platformId: string; payload: unknown }> {
    const rows = this.db.prepare("SELECT platform_id,payload_json FROM weixin_inbox WHERE status='pending' ORDER BY created_at").all() as Array<{ platform_id: string; payload_json: string }>;
    return rows.map((row) => ({ platformId: row.platform_id, payload: JSON.parse(row.payload_json) as unknown }));
  }

  enqueueOutbox(clientId: string, payload: unknown): void {
    this.db.prepare("INSERT OR IGNORE INTO weixin_outbox(client_id,payload_json,status,created_at) VALUES(?,?,'pending',?)")
      .run(clientId, JSON.stringify(payload), Date.now());
  }
  completeOutbox(clientId: string): void { this.db.prepare("UPDATE weixin_outbox SET status='sent' WHERE client_id=?").run(clientId); }
  failOutbox(clientId: string, error: string): void {
    this.db.prepare("UPDATE weixin_outbox SET status='failed',attempts=attempts+1,last_error=? WHERE client_id=?").run(error.slice(0, 500), clientId);
  }
  pendingOutbox(): Array<{ clientId: string; payload: WeixinOutboxPayload }> {
    const rows = this.db.prepare("SELECT client_id,payload_json FROM weixin_outbox WHERE status!='sent' AND attempts < 5 ORDER BY created_at").all() as Array<{ client_id: string; payload_json: string }>;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as WeixinOutboxPayload | { to: string; text: string };
      return { clientId: row.client_id, payload: "kind" in payload ? payload : { kind: "text", ...payload } };
    });
  }

  async saveMedia(buffer: Buffer, name: string, direction: "inbound" | "outbound"): Promise<string> {
    if (buffer.length > 100 * 1024 * 1024) throw new Error("微信附件不能超过 100 MB");
    const dir = path.join(this.mediaPath, direction, new Date().toISOString().slice(0, 10));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const safe = path.basename(name).replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(-120) || "file.bin";
    const file = path.join(dir, `${Date.now()}-${safe}`);
    await fs.writeFile(file, buffer, { mode: 0o600 });
    return file;
  }

  mediaBytes(): number { return directoryBytes(this.mediaPath); }

  async clearAll(): Promise<void> {
    this.db.exec("DELETE FROM weixin_messages; DELETE FROM weixin_inbox; DELETE FROM weixin_outbox; DELETE FROM weixin_bot_state; INSERT INTO weixin_bot_state(id) VALUES(1)");
    await fs.rm(this.mediaPath, { recursive: true, force: true });
    await fs.mkdir(this.mediaPath, { recursive: true, mode: 0o700 });
  }
}

function rowToMessage(row: MessageRow): WeixinMessage {
  let media: WeixinMedia[] = [];
  try { media = JSON.parse(row.media_json) as WeixinMedia[]; } catch { /* corrupted media metadata is non-fatal */ }
  return {
    id: row.id,
    ...(row.platform_id ? { platformId: row.platform_id } : {}),
    direction: row.direction, source: row.source, role: row.role, text: row.text, media,
    status: row.status, createdAt: new Date(row.created_at).toISOString(),
  };
}

function directoryBytes(directory: string): number {
  let total = 0;
  try {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) total += directoryBytes(candidate);
      else if (entry.isFile()) total += fsSync.statSync(candidate).size;
    }
  } catch { return total; }
  return total;
}
