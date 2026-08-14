import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MCPManager } from "../packages/core/src/mcp.js";
import { MODEL_CREDENTIAL_ENV_KEYS } from "../packages/core/src/providers.js";

describe("MCPManager", () => {
  let root: string | undefined;
  const originalCredentials = Object.fromEntries(
    MODEL_CREDENTIAL_ENV_KEYS.map((name) => [name, process.env[name]]),
  );

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
    for (const name of MODEL_CREDENTIAL_ENV_KEYS) restore(name, originalCredentials[name]);
  });

  it("loads trusted project tools and strips the model key from stdio", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-mcp-"));
    await fs.mkdir(path.join(root, ".dscode"));
    await fs.writeFile(
      path.join(root, ".dscode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [path.resolve("test/fixtures/mcp-server.mjs")],
          },
        },
      }),
    );
    for (const name of MODEL_CREDENTIAL_ENV_KEYS) process.env[name] = "must-not-leak";

    const tools = new Map<string, ToolDefinition>();
    let active: string[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      getActiveTools() {
        return active;
      },
      setActiveTools(names: string[]) {
        active = names;
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const manager = new MCPManager();
    try {
      await manager.connectConfigured(pi, ctx);
      expect(manager.status()).toContain("fixture: connected (1 tools)");
      expect(active).toContain("mcp__fixture__echo");
      const tool = tools.get("mcp__fixture__echo");
      expect(tool).toBeDefined();
      const result = await tool!.execute("call-1", { text: "hello" }, undefined, undefined, ctx);
      expect(result.content).toEqual([
        {
          type: "text",
          text: `hello|${MODEL_CREDENTIAL_ENV_KEYS.map((name) => `${name}=unset`).join("|")}`,
        },
      ]);
    } finally {
      await manager.close();
    }
  });

  it("preserves standard MCP image content for the agent", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-mcp-"));
    await fs.mkdir(path.join(root, ".dscode"));
    await fs.writeFile(
      path.join(root, ".dscode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [path.resolve("test/fixtures/mcp-server.mjs")],
          },
        },
      }),
    );

    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      getActiveTools: () => [],
      setActiveTools: () => undefined,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const manager = new MCPManager();
    try {
      await manager.connectConfigured(pi, ctx);
      const tool = tools.get("mcp__fixture__echo");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        "call-1",
        { text: "inspect", includeImage: true },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: `inspect|${MODEL_CREDENTIAL_ENV_KEYS.map((name) => `${name}=unset`).join("|")}`,
        },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZBv8AAAAASUVORK5CYII=",
        },
      ]);
    } finally {
      await manager.close();
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
