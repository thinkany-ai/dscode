import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDSCodeCredentialStore,
  type DSCodeKeyringFactory,
} from "../packages/core/src/credential-store.js";

class MemoryKeyring implements DSCodeKeyringFactory {
  readonly values = new Map<string, string>();

  create(service: string, account: string) {
    const key = `${service}:${account}`;
    return {
      getPassword: () => this.values.get(key) ?? null,
      setPassword: (password: string) => {
        this.values.set(key, password);
      },
      deletePassword: () => this.values.delete(key),
    };
  }
}

describe("DSCode credential storage", () => {
  const temporaryDirectories: string[] = [];
  const originalHome = process.env.DSCODE_HOME;

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.DSCODE_HOME;
    else process.env.DSCODE_HOME = originalHome;
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
    );
  });

  it("migrates file credentials to the keyring without leaving secrets in auth.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-credential-test-"));
    temporaryDirectories.push(root);
    process.env.DSCODE_HOME = root;
    const authPath = path.join(root, "auth.json");
    const metadataPath = path.join(root, "credential-metadata.json");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        deepseek: { type: "api_key", key: "sk-secret" },
        "openai-codex": {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      }),
      { mode: 0o600 },
    );
    const keyring = new MemoryKeyring();

    const store = await createDSCodeCredentialStore({
      mode: "auto",
      authPath,
      metadataPath,
      keyringFactory: keyring,
    });

    await expect(store.read("deepseek")).resolves.toEqual({ type: "api_key", key: "sk-secret" });
    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        { providerId: "deepseek", type: "api_key" },
        { providerId: "openai-codex", type: "oauth" },
      ]),
    );
    expect(JSON.parse(await fs.readFile(authPath, "utf8"))).toEqual({});
    expect(await fs.readFile(metadataPath, "utf8")).not.toContain("sk-secret");
  });

  it("serializes OAuth refreshes through the same keyring credential store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-credential-test-"));
    temporaryDirectories.push(root);
    process.env.DSCODE_HOME = root;
    const keyring = new MemoryKeyring();
    const store = await createDSCodeCredentialStore({
      mode: "keyring",
      metadataPath: path.join(root, "metadata.json"),
      keyringFactory: keyring,
    });
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "old",
      refresh: "refresh",
      expires: 1,
    }));
    await store.modify("openai-codex", async (current) => ({
      ...(current?.type === "oauth" ? current : { refresh: "refresh" }),
      type: "oauth",
      access: "new",
      expires: 2,
    }));

    await expect(store.read("openai-codex")).resolves.toMatchObject({ access: "new", expires: 2 });
    await store.delete("openai-codex");
    await expect(store.read("openai-codex")).resolves.toBeUndefined();
  });
});
