import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.js";

describe("command access escalation", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.runIf(process.platform === "darwin")(
    "asks for scoped host access and retries the blocked command once approved",
    async () => {
      root = await fs.mkdtemp(path.join(process.cwd(), ".dscode-access-test-"));
      const nestedWorkspace = path.join(root, "workspace");
      const outsideWorkspace = path.join(root, "host-write.txt");
      await fs.mkdir(nestedWorkspace);

      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = new Proxy(
        {
          registerTool(tool: { name: string }) {
            tools.set(tool.name, tool);
          },
          on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          getActiveTools: () => [],
          setActiveTools: () => undefined,
          getThinkingLevel: () => "max",
        },
        {
          get(target, property) {
            if (property in target) return target[property as keyof typeof target];
            return () => undefined;
          },
        },
      ) as unknown as ExtensionAPI;
      createDSCodeExtension(options(nestedWorkspace)).factory(pi);

      const prompts: string[] = [];
      const ctx = {
        cwd: nestedWorkspace,
        hasUI: true,
        ui: {
          setWorkingVisible: () => undefined,
          select: async (prompt: string) => {
            prompts.push(prompt);
            return "Allow once";
          },
        },
      } as unknown as ExtensionContext;
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(outsideWorkspace)}, 'approved')`,
      )}`;
      const result = await tools.get("exec_command").execute(
        "access-test",
        { cmd: command, yield_time_ms: 10_000, timeout_ms: 30_000 },
        undefined,
        undefined,
        ctx,
      );

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Allow unrestricted host access?");
      expect(result.details).toMatchObject({ running: false, exitCode: 0, sandbox: "host" });
      await expect(fs.readFile(outsideWorkspace, "utf8")).resolves.toBe("approved");
    },
  );
});

function options(cwd: string): DSCodeRuntimeOptions {
  return {
    cwd,
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-v4-flash",
    transport: "responses",
    harness: "minimal",
    permission: "auto",
    effortExplicit: false,
    sandbox: "workspace-write",
    network: false,
    webSearch: false,
    route: "auto",
    activeTools: ["update_plan", "exec_command", "write_stdin", "apply_patch"],
    toolsExplicit: false,
  };
}
