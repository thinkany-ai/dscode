import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSessionCommands } from "../packages/core/src/session-commands.js";

describe("DSCode session commands", () => {
  it("registers /clear as a new-session alias without reusing the stale context", async () => {
    let command:
      | {
          description?: string;
          handler(args: string, ctx: any): Promise<void>;
        }
      | undefined;
    const pi = {
      registerCommand(name: string, definition: typeof command) {
        if (name === "clear") command = definition;
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    const newSession = vi.fn(async () => ({ cancelled: false }));
    const ui = new Proxy(
      {},
      {
        get() {
          throw new Error("stale context accessed after session replacement");
        },
      },
    );
    await command!.handler("", { newSession, ui });

    expect(command?.description).toContain("alias for /new");
    expect(newSession).toHaveBeenCalledOnce();
  });

  it("does not report success when session replacement is cancelled", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      registerCommand(name: string, definition: { handler: typeof handler }) {
        if (name === "clear") handler = definition.handler;
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    await handler!("", {
      newSession: async () => ({ cancelled: true }),
      ui: new Proxy(
        {},
        {
          get() {
            throw new Error("stale context accessed after cancelled replacement");
          },
        },
      ),
    });
  });

  it("registers edit-last separately from the new-session alias", () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, definition);
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    expect(commands.has("clear")).toBe(true);
    expect(commands.get("edit-last")).toBeDefined();
  });

  it("rewrites the same session path and switches back to it", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, definition);
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "old" }] } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
      { type: "message", id: "user-2", parentId: "assistant-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "latest" }] } },
      { type: "message", id: "assistant-2", parentId: "user-2", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "latest answer" }] } },
    ] as const;
    const switchSession = vi.fn(async () => ({ cancelled: false }));
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-session-test-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(sessionFile, "old\n");
    const manager = {
      getBranch: vi.fn((fromId?: string) => fromId === "assistant-1" ? entries.slice(0, 2) : [...entries]),
      getSessionFile: vi.fn(() => sessionFile),
      getHeader: vi.fn(() => null),
    };

    await commands.get("edit-last")!.handler("", {
      isIdle: () => true,
      sessionManager: manager,
      switchSession,
    });

    const rewritten = await fs.readFile(sessionFile, "utf8");
    expect(rewritten).toContain('"user-1"');
    expect(rewritten).toContain('"assistant-1"');
    expect(rewritten).not.toContain('"user-2"');
    expect(rewritten).not.toContain('"assistant-2"');
    expect(switchSession).toHaveBeenCalledWith(sessionFile);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
