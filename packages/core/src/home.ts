import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LEGACY_AGENT_ENTRIES = [
  "auth.json",
  "settings.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "skills",
  "extensions",
  "prompts",
  "themes",
  "bin",
  "packages",
  "npm",
  "git",
] as const;

export function getDSCodeHome(): string {
  return resolveHomePath(process.env.DSCODE_HOME ?? path.join(os.homedir(), ".dscode"));
}

export function getDSCodeSessionsDir(): string {
  return resolveHomePath(
    process.env.DSCODE_SESSIONS_DIR ?? path.join(getDSCodeHome(), "sessions"),
  );
}

export function getDSCodeArchivedSessionsDir(): string {
  return resolveHomePath(
    process.env.DSCODE_ARCHIVED_SESSIONS_DIR ?? path.join(getDSCodeHome(), "archived_sessions"),
  );
}

/** Configure the underlying runtime to use DSCode-owned paths only. */
export async function initializeDSCodeHome(): Promise<string> {
  const home = getDSCodeHome();
  const sessions = getDSCodeSessionsDir();
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => undefined);
  if (process.env.DSCODE_HOME === undefined) {
    await migrateLegacyDSCodeHome(home);
  }
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  await fs.chmod(sessions, 0o700).catch(() => undefined);
  await fs.mkdir(getDSCodeArchivedSessionsDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(getDSCodeArchivedSessionsDir(), 0o700).catch(() => undefined);
  await partitionExistingSessions(sessions);
  return home;
}

export interface PartitionedSessionPath {
  /** Flat hard-link retained for pi's current --resume/session-dir implementation. */
  runtimePath: string;
  /** Canonical transcript path partitioned as sessions/YYYY/MM/DD/*.jsonl. */
  storagePath: string;
}

/**
 * Move a flat pi transcript into a date partition, then retain a flat hard-link.
 * Both names address the same inode, so the runtime remains fully compatible and
 * no transcript content is duplicated.
 */
export async function partitionSessionFile(file: string): Promise<PartitionedSessionPath> {
  const sessions = getDSCodeSessionsDir();
  const runtimePath = path.resolve(file);
  const relative = path.relative(sessions, runtimePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { runtimePath, storagePath: runtimePath };
  }
  if (path.dirname(relative) !== ".") {
    return { runtimePath: path.join(sessions, path.basename(file)), storagePath: runtimePath };
  }

  const stat = await fs.stat(runtimePath);
  const timestamp = await sessionTimestamp(runtimePath, stat.mtime);
  const date = timestamp.toISOString().slice(0, 10).split("-");
  const storagePath = path.join(sessions, ...date, path.basename(runtimePath));
  await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(storagePath), 0o700).catch(() => undefined);

  const existing = await statOrUndefined(storagePath);
  if (existing) {
    if (sameFile(stat, existing)) {
      await fs.chmod(runtimePath, 0o600).catch(() => undefined);
      return { runtimePath, storagePath };
    }
    // Never overwrite a different transcript on a path collision.
    return { runtimePath, storagePath: runtimePath };
  }

  try {
    await fs.rename(runtimePath, storagePath);
    try {
      await fs.link(storagePath, runtimePath);
    } catch (error) {
      await fs.rename(storagePath, runtimePath).catch(() => undefined);
      throw error;
    }
    await fs.chmod(storagePath, 0o600).catch(() => undefined);
    return { runtimePath, storagePath };
  } catch {
    // Hard links can be unavailable on unusual/network filesystems. Keeping the
    // original flat file is safer than copying or breaking resume semantics.
    return { runtimePath, storagePath: runtimePath };
  }
}

export async function partitionExistingSessions(
  sessions = getDSCodeSessionsDir(),
): Promise<PartitionedSessionPath[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const partitioned: PartitionedSessionPath[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    partitioned.push(await partitionSessionFile(path.join(sessions, entry.name)));
  }
  return partitioned;
}

/** Copy legacy ~/.dscode/agent contents upward without overwriting or deleting anything. */
export async function migrateLegacyDSCodeHome(home = getDSCodeHome()): Promise<string[]> {
  const legacy = path.join(home, "agent");
  const migrated: string[] = [];
  for (const entry of LEGACY_AGENT_ENTRIES) {
    const source = path.join(legacy, entry);
    const target = path.join(home, entry);
    if (!(await exists(source)) || (await exists(target))) continue;
    await fs.cp(source, target, { recursive: true, preserveTimestamps: true });
    migrated.push(entry);
  }
  for (const file of ["auth.json", "settings.json", "trust.json"]) {
    await fs.chmod(path.join(home, file), 0o600).catch(() => undefined);
  }
  return migrated;
}

function resolveHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function sessionTimestamp(file: string, fallback: Date): Promise<Date> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return fallback;
    const header = JSON.parse(firstLine) as unknown;
    if (isRecord(header) && typeof header.timestamp === "string") {
      const timestamp = new Date(header.timestamp);
      if (!Number.isNaN(timestamp.getTime())) return timestamp;
    }
    return fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function statOrUndefined(file: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
