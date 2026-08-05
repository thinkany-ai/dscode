import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getDSCodeHome } from "./home.js";
import {
  getDSCodeStorageSettings,
  type CredentialStoreMode,
} from "./settings.js";

const KEYRING_SERVICE = "ai.thinkany.dscode";
const STORE_PATCH = Symbol.for("ai.thinkany.dscode.credential-store-installed");
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;

type CredentialData = Record<string, Credential>;

interface CredentialMetadata {
  version: 1;
  providers: Record<string, { type: Credential["type"] }>;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface DSCodeKeyringFactory {
  create(service: string, account: string): KeyringEntry;
}

export interface CreateCredentialStoreOptions {
  mode?: CredentialStoreMode;
  authPath?: string;
  metadataPath?: string;
  keyringFactory?: DSCodeKeyringFactory;
}

function defaultAuthPath(): string {
  return path.join(getDSCodeHome(), "auth.json");
}

/** Plain JSON fallback compatible with pi's existing auth.json shape. */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly authPath = defaultAuthPath()) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await readCredentialData(this.authPath))[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const data = await readCredentialData(this.authPath);
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withDirectoryLock(`${this.authPath}.lock`, async () => {
      const data = await readCredentialData(this.authPath);
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      await writePrivateJson(this.authPath, data);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await withDirectoryLock(`${this.authPath}.lock`, async () => {
      const data = await readCredentialData(this.authPath);
      if (!(providerId in data)) return;
      delete data[providerId];
      await writePrivateJson(this.authPath, data);
    });
  }
}

/** CredentialStore backed by Keychain, Credential Manager, or Secret Service. */
export class KeyringCredentialStore implements CredentialStore {
  constructor(
    private readonly factory: DSCodeKeyringFactory,
    readonly metadataPath = path.join(getDSCodeHome(), "credential-metadata.json"),
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const serialized = this.factory.create(KEYRING_SERVICE, providerId).getPassword();
    if (!serialized) return undefined;
    return parseCredential(serialized, `system keyring entry for ${providerId}`);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const metadata = await readMetadata(this.metadataPath);
    return Object.entries(metadata.providers).map(([providerId, entry]) => ({
      providerId,
      type: entry.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withDirectoryLock(this.lockPath(providerId), async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      this.factory.create(KEYRING_SERVICE, providerId).setPassword(JSON.stringify(next));
      await this.remember(providerId, next.type);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await withDirectoryLock(this.lockPath(providerId), async () => {
      this.factory.create(KEYRING_SERVICE, providerId).deletePassword();
      const metadata = await readMetadata(this.metadataPath);
      if (!(providerId in metadata.providers)) return;
      delete metadata.providers[providerId];
      await writePrivateJson(this.metadataPath, metadata);
    });
  }

  private lockPath(providerId: string): string {
    const safeProvider = providerId.replace(/[^a-zA-Z0-9_.-]/gu, "_");
    return path.join(getDSCodeHome(), ".credential-locks", `${safeProvider}.lock`);
  }

  private async remember(providerId: string, type: Credential["type"]): Promise<void> {
    const metadata = await readMetadata(this.metadataPath);
    metadata.providers[providerId] = { type };
    await writePrivateJson(this.metadataPath, metadata);
  }
}

class AutoCredentialStore implements CredentialStore {
  constructor(
    private readonly keyring: KeyringCredentialStore,
    private readonly file: FileCredentialStore,
  ) {}

  async migrateFileCredentials(): Promise<void> {
    for (const { providerId } of await this.file.list()) {
      const credential = await this.file.read(providerId);
      if (!credential) continue;
      try {
        await this.keyring.modify(providerId, async () => credential);
        await this.file.delete(providerId);
      } catch {
        // auto deliberately preserves the working file credential when the OS store is unavailable.
        return;
      }
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    try {
      const keyringCredential = await this.keyring.read(providerId);
      if (keyringCredential) return keyringCredential;
    } catch {
      // Fall through to the owner-only auth file.
    }
    return this.file.read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const merged = new Map<string, CredentialInfo>();
    for (const entry of await this.file.list()) merged.set(entry.providerId, entry);
    try {
      for (const entry of await this.keyring.list()) merged.set(entry.providerId, entry);
    } catch {
      // The fallback list is still authoritative when the OS service is unavailable.
    }
    return [...merged.values()];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    try {
      const stored = await this.keyring.modify(providerId, async () => next);
      await this.file.delete(providerId);
      return stored;
    } catch {
      return this.file.modify(providerId, async () => next);
    }
  }

  async delete(providerId: string): Promise<void> {
    try {
      await this.keyring.delete(providerId);
    } catch {
      // Logout must still clear the fallback credential.
    }
    await this.file.delete(providerId);
  }
}

export async function createDSCodeCredentialStore(
  options: CreateCredentialStoreOptions = {},
): Promise<CredentialStore> {
  const configured = getDSCodeStorageSettings();
  const mode = options.mode ?? configured.credentialStore;
  const file = new FileCredentialStore(options.authPath ?? defaultAuthPath());
  if (mode === "file") return file;
  if (mode === "auto" && !options.keyringFactory && !canUseInteractiveKeyring()) return file;

  let factory = options.keyringFactory;
  if (!factory) {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      factory = { create: (service, account) => new Entry(service, account) };
    } catch (error) {
      if (mode === "auto") return file;
      throw new Error(`System keyring is unavailable: ${errorMessage(error)}`);
    }
  }

  const keyring = new KeyringCredentialStore(
    factory,
    options.metadataPath ?? path.join(getDSCodeHome(), "credential-metadata.json"),
  );
  if (mode === "keyring") return keyring;
  const automatic = new AutoCredentialStore(keyring, file);
  await automatic.migrateFileCredentials();
  return automatic;
}

/**
 * pi's CLI creates ModelRuntime internally. Patch its public factory once so every
 * TUI, JSON, and RPC runtime receives the same DSCode-owned credential store.
 */
export async function installDSCodeCredentialStore(): Promise<void> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = ModelRuntime as typeof ModelRuntime & { [STORE_PATCH]?: boolean };
  if (runtime[STORE_PATCH]) return;
  const credentials = await createDSCodeCredentialStore();
  const create = ModelRuntime.create.bind(ModelRuntime);
  ModelRuntime.create = (options = {}) =>
    create({ ...options, credentials: options.credentials ?? credentials });
  runtime[STORE_PATCH] = true;
}

async function readCredentialData(authPath: string): Promise<CredentialData> {
  try {
    const parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Credential] => isCredential(entry[1])),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`Cannot parse DSCode auth file: ${authPath}`);
    throw error;
  }
}

async function readMetadata(metadataPath: string): Promise<CredentialMetadata> {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return emptyMetadata();
    const providers: CredentialMetadata["providers"] = {};
    for (const [providerId, value] of Object.entries(parsed.providers)) {
      if (isRecord(value) && (value.type === "api_key" || value.type === "oauth")) {
        providers[providerId] = { type: value.type };
      }
    }
    return { version: 1, providers };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyMetadata();
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode credential metadata: ${metadataPath}`);
    }
    throw error;
  }
}

function emptyMetadata(): CredentialMetadata {
  return { version: 1, providers: {} };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withDirectoryLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const stale = await fs.stat(lockPath).then(
        (stat) => Date.now() - stat.mtimeMs > LOCK_STALE_MS,
        () => false,
      );
      if (stale) {
        await fs.rmdir(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for credential lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  try {
    return await task();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
}

function parseCredential(serialized: string, source: string): Credential {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (isCredential(parsed)) return parsed;
  } catch {
    // Report one consistent message for invalid JSON and invalid credential shapes.
  }
  throw new Error(`Cannot parse ${source}`);
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    return value.key === undefined || typeof value.key === "string";
  }
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canUseInteractiveKeyring(): boolean {
  return Boolean(
    process.versions.electron ||
      (process.stdin.isTTY && process.stdout.isTTY) ||
      process.env.DSCODE_ALLOW_HEADLESS_KEYRING === "1",
  );
}
