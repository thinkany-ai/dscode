import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PersistedSessionAlreadyExistsError,
  PersistedSessionNotFoundError,
  createAgentSessionHost,
} from "../src/agent-session-host.js";
import { createHttpUiBroker, type HttpUiBrokerEvent } from "../src/ui-broker.js";

const ENV_KEYS = [
  "DSCODE_HOME",
  "DSCODE_SESSIONS_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;
const originalEnvironment = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("createAgentSessionHost", () => {
  it("creates and disposes an in-process DSCode session without provider calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    const broker = createHttpUiBroker();
    const events: HttpUiBrokerEvent[] = [];
    const host = await createAgentSessionHost({
      cwd: workspace,
      runtimeArgs: [
        "--provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
        "--effort",
        "high",
        "--permission",
        "auto",
      ],
      uiBroker: broker,
    });
    host.subscribe((event) => events.push(event));

    try {
      expect(host.session.model).toMatchObject({
        provider: "deepseek",
        id: "deepseek-v4-flash",
      });
      expect(host.session.sessionManager.isPersisted()).toBe(false);
      expect(host.session.extensionRunner.hasUI()).toBe(true);
      expect(host.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(["exec_command", "apply_patch"]),
      );
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "status",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "ui_event" && event.event.method === "title",
        ),
      ).toBe(true);
      await expect(host.prompt("/clear")).rejects.toThrow(
        "Session command /clear is not supported",
      );

      const firstDispose = host.dispose();
      const secondDispose = host.dispose();
      expect(secondDispose).toBe(firstDispose);
      await firstDispose;
      await expect(host.prompt("Do not run")).rejects.toThrow("disposed");
    } finally {
      await host.dispose();
    }
  });

  it("creates and resumes a persistent session without changing process cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = sessionsDir;
    const originalCwd = process.cwd();
    const sessionId = "0193f4ca-7d8b-7000-8000-000000000001";

    const first = await createAgentSessionHost({
      cwd: workspace,
      session: { type: "persistent", id: sessionId },
    });
    try {
      const manager = first.session.sessionManager;
      const model = first.session.model;
      if (!model) throw new Error("Missing session model");
      expect(manager.isPersisted()).toBe(true);
      expect(manager.getSessionId()).toBe(sessionId);
      expect(manager.getSessionDir()).toBe(sessionsDir);
      manager.appendMessage({ role: "user", content: "Remember this", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Remembered" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      expect((await fs.stat(manager.getSessionFile()!)).isFile()).toBe(true);
    } finally {
      await first.dispose();
    }

    await expect(
      createAgentSessionHost({
        cwd: workspace,
        session: { type: "persistent", id: sessionId },
      }),
    ).rejects.toBeInstanceOf(PersistedSessionAlreadyExistsError);

    const resumed = await createAgentSessionHost({
      cwd: workspace,
      session: { type: "resume", id: sessionId },
    });
    try {
      expect(resumed.session.sessionManager.getSessionId()).toBe(sessionId);
      expect(
        resumed.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message"),
      ).toHaveLength(2);
      expect(resumed.session.sessionManager.buildSessionContext().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Remember this" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      await resumed.dispose();
    }
  });

  it("rejects an unknown persistent session ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    await expect(
      createAgentSessionHost({
        cwd: workspace,
        session: { type: "resume", id: "missing" },
      }),
    ).rejects.toBeInstanceOf(PersistedSessionNotFoundError);
  });

  it("rejects CLI-only arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-http-adapter-"));
    temporaryRoots.push(root);
    process.env.DSCODE_HOME = path.join(root, "home");
    process.env.DSCODE_SESSIONS_DIR = path.join(root, "sessions");

    await expect(
      createAgentSessionHost({ cwd: root, runtimeArgs: ["--thinking", "high"] }),
    ).rejects.toThrow("Unsupported direct session argument");
  });
});
