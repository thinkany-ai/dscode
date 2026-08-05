import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  getDSCodeArchivedSessionsDir,
  getDSCodeHome,
  getDSCodeSessionsDir,
  partitionSessionFile,
} from "./home.js";
import { getDSCodeStorageSettings } from "./settings.js";

type JsonRecord = Record<string, unknown>;
const require = createRequire(import.meta.url);

export interface DSCodeThread {
  id: string;
  sessionPath: string;
  storagePath: string;
  cwd: string;
  title: string;
  preview?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  archived: boolean;
}

export interface ListThreadOptions {
  cwd?: string;
  includeArchived?: boolean;
}

interface ThreadRow {
  id: string;
  session_path: string;
  storage_path: string;
  cwd: string;
  title: string;
  preview: string | null;
  provider: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  pinned: number;
  archived: number;
  file_size: number;
  file_mtime_ms: number;
}

export function getDSCodeStatePath(): string {
  const sqliteHome = getDSCodeStorageSettings().sqliteHome ?? getDSCodeHome();
  return path.join(sqliteHome, "state.sqlite");
}

/** SQLite is an index/runtime-state layer; JSONL remains the transcript source of truth. */
export class DSCodeStateStore {
  private readonly database: DatabaseSync;
  private readonly findByPath: StatementSync;

  constructor(readonly statePath = getDSCodeStatePath()) {
    if (statePath !== ":memory:") {
      fsSync.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    }
    const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as typeof import("node:sqlite");
    this.database = new SQLiteDatabase(statePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_path TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS threads_updated_at_idx ON threads(archived, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS threads_cwd_idx ON threads(cwd, archived, updated_at DESC);
      CREATE INDEX IF NOT EXISTS threads_storage_path_idx ON threads(storage_path);
      PRAGMA user_version = 1;
    `);
    if (statePath !== ":memory:") fsSync.chmodSync(statePath, 0o600);
    this.findByPath = this.database.prepare(
      "SELECT * FROM threads WHERE session_path = ? OR storage_path = ? LIMIT 1",
    );
  }

  close(): void {
    this.database.close();
  }

  async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const file of await directJsonlFiles(getDSCodeSessionsDir())) {
      const partitioned = await partitionSessionFile(file);
      seen.add(partitioned.storagePath);
      await this.indexFile(partitioned.runtimePath, partitioned.storagePath, false);
    }
    for (const file of await recursiveJsonlFiles(getDSCodeArchivedSessionsDir())) {
      seen.add(file);
      await this.indexFile(file, file, true);
    }

    const rows = this.database.prepare("SELECT id, storage_path FROM threads").all() as Array<{
      id: string;
      storage_path: string;
    }>;
    const remove = this.database.prepare("DELETE FROM threads WHERE id = ?");
    for (const row of rows) {
      if (!seen.has(row.storage_path)) remove.run(row.id);
    }
  }

  async indexSession(file: string): Promise<DSCodeThread | undefined> {
    const partitioned = await partitionSessionFile(file);
    return this.indexFile(partitioned.runtimePath, partitioned.storagePath, false);
  }

  list(options: ListThreadOptions = {}): DSCodeThread[] {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (!options.includeArchived) where.push("archived = 0");
    if (options.cwd) {
      where.push("cwd = ?");
      parameters.push(path.resolve(options.cwd));
    }
    const query = `SELECT * FROM threads${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, updated_at DESC`;
    return (this.database.prepare(query).all(...parameters) as unknown as ThreadRow[]).map(rowToThread);
  }

  get(id: string): DSCodeThread | undefined {
    const row = this.database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  setPinned(id: string, pinned: boolean): boolean {
    return this.database
      .prepare("UPDATE threads SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id).changes > 0;
  }

  async archive(id: string): Promise<DSCodeThread | undefined> {
    const current = this.get(id);
    if (!current || current.archived) return current;
    const dateParts = current.createdAt.slice(0, 10).split("-");
    const target = path.join(getDSCodeArchivedSessionsDir(), ...dateParts, path.basename(current.storagePath));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(target), 0o700).catch(() => undefined);
    let compatibilityLinkRemoved = false;
    if (current.sessionPath !== current.storagePath) {
      await fs.unlink(current.sessionPath).catch((error) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
      compatibilityLinkRemoved = true;
    }
    try {
      await fs.rename(current.storagePath, target);
    } catch (error) {
      if (compatibilityLinkRemoved) {
        await fs.link(current.storagePath, current.sessionPath).catch(() => undefined);
      }
      throw error;
    }
    this.database
      .prepare(
        "UPDATE threads SET session_path = ?, storage_path = ?, archived = 1, updated_at = ? WHERE id = ?",
      )
      .run(target, target, Date.now(), id);
    return this.get(id);
  }

  async unarchive(id: string): Promise<DSCodeThread | undefined> {
    const current = this.get(id);
    if (!current || !current.archived) return current;
    const dateParts = current.createdAt.slice(0, 10).split("-");
    const storagePath = path.join(getDSCodeSessionsDir(), ...dateParts, path.basename(current.storagePath));
    const runtimePath = path.join(getDSCodeSessionsDir(), path.basename(current.storagePath));
    await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    await fs.rename(current.storagePath, storagePath);
    try {
      await fs.link(storagePath, runtimePath);
    } catch (error) {
      await fs.rename(storagePath, current.storagePath).catch(() => undefined);
      throw error;
    }
    await fs.chmod(storagePath, 0o600).catch(() => undefined);
    this.database
      .prepare(
        "UPDATE threads SET session_path = ?, storage_path = ?, archived = 0, updated_at = ? WHERE id = ?",
      )
      .run(runtimePath, storagePath, Date.now(), id);
    return this.get(id);
  }

  private async indexFile(
    sessionPath: string,
    storagePath: string,
    archived: boolean,
  ): Promise<DSCodeThread | undefined> {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(storagePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const cached = this.findByPath.get(sessionPath, storagePath) as ThreadRow | undefined;
    if (
      cached &&
      cached.file_size === stat.size &&
      cached.file_mtime_ms === stat.mtimeMs &&
      Boolean(cached.archived) === archived
    ) {
      return rowToThread(cached);
    }

    const parsed = await parseSession(storagePath, stat);
    if (!parsed) return undefined;
    this.database
      .prepare(`
        INSERT INTO threads (
          id, session_path, storage_path, cwd, title, preview, provider, model,
          created_at, updated_at, message_count, pinned, archived, file_size, file_mtime_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_path = excluded.session_path,
          storage_path = excluded.storage_path,
          cwd = excluded.cwd,
          title = excluded.title,
          preview = excluded.preview,
          provider = excluded.provider,
          model = excluded.model,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          message_count = excluded.message_count,
          archived = excluded.archived,
          file_size = excluded.file_size,
          file_mtime_ms = excluded.file_mtime_ms
      `)
      .run(
        parsed.id,
        sessionPath,
        storagePath,
        parsed.cwd,
        parsed.title,
        parsed.preview ?? null,
        parsed.provider ?? null,
        parsed.model ?? null,
        parsed.createdAt,
        stat.mtimeMs,
        parsed.messageCount,
        archived ? 1 : 0,
        stat.size,
        stat.mtimeMs,
      );
    return this.get(parsed.id);
  }
}

export async function listDSCodeThreads(options: ListThreadOptions = {}): Promise<DSCodeThread[]> {
  const store = new DSCodeStateStore();
  try {
    await store.refresh();
    return store.list(options);
  } finally {
    store.close();
  }
}

export async function indexDSCodeSession(file: string): Promise<DSCodeThread | undefined> {
  const store = new DSCodeStateStore();
  try {
    return await store.indexSession(file);
  } finally {
    store.close();
  }
}

async function parseSession(
  file: string,
  stat: import("node:fs").Stats,
): Promise<
  | {
      id: string;
      cwd: string;
      title: string;
      preview?: string;
      provider?: string;
      model?: string;
      createdAt: number;
      messageCount: number;
    }
  | undefined
> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const lines = raw.split("\n").filter(Boolean);
  const header = lines[0] ? parseLine(lines[0]) : undefined;
  if (header?.type !== "session" || typeof header.cwd !== "string") return undefined;

  let firstUserText: string | undefined;
  let preview: string | undefined;
  let namedTitle: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  for (const line of lines.slice(1)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") provider = entry.provider;
      if (typeof entry.modelId === "string") model = entry.modelId;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") namedTitle = entry.name;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    messageCount += 1;
    const text = messageText(entry.message.content);
    if (!text) continue;
    preview = text;
    if (!firstUserText && entry.message.role === "user") firstUserText = text;
  }
  const createdAt =
    typeof header.timestamp === "string" && Number.isFinite(Date.parse(header.timestamp))
      ? Date.parse(header.timestamp)
      : stat.birthtimeMs || stat.mtimeMs;
  return {
    id: typeof header.id === "string" ? header.id : path.basename(file, ".jsonl"),
    cwd: path.resolve(header.cwd),
    title: crop(normalize(namedTitle ?? firstUserText ?? "New thread"), 96),
    ...(preview ? { preview: crop(preview, 240) } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    createdAt,
    messageCount,
  };
}

function rowToThread(row: ThreadRow): DSCodeThread {
  return {
    id: row.id,
    sessionPath: row.session_path,
    storagePath: row.storage_path,
    cwd: row.cwd,
    title: row.title,
    ...(row.preview ? { preview: row.preview } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    messageCount: row.message_count,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
  };
}

async function directJsonlFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function recursiveJsonlFiles(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveJsonlFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}

function parseLine(line: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return normalize(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  return text ? normalize(text) : undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function crop(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
