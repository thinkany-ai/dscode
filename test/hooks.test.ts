import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerHooks } from "../packages/core/src/hooks.js";

describe("DSCode hooks", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it(
    "runs trusted hooks in the sandbox and blocks on beforeTool failure",
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-hooks-"));
      await fs.mkdir(path.join(root, ".dscode"));
      await fs.writeFile(
        path.join(root, ".dscode", "hooks.json"),
        JSON.stringify({
          hooks: {
            sessionStart: [
              {
                command: "node",
                args: [
                  "-e",
                  "require('fs').writeFileSync('hook.txt', process.env.DEEPSEEK_API_KEY ?? 'unset')",
                ],
              },
            ],
            beforeTool: [
              {
                command: "node",
                args: ["-e", "process.stderr.write('policy blocked'); process.exit(7)"],
              },
            ],
          },
        }),
      );
      process.env.DEEPSEEK_API_KEY = "must-not-leak";

      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = {
        on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: root,
        signal: undefined,
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext;
      registerHooks(pi, () => ({
        sandbox: process.platform === "win32" ? "danger-full-access" : "workspace-write",
        network: false,
      }));

      await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
      await expect(fs.readFile(path.join(root, "hook.txt"), "utf8")).resolves.toBe("unset");

      const decision = await handlers.get("tool_call")![0]!(
        { type: "tool_call", toolName: "apply_patch", input: {} },
        ctx,
      );
      expect(decision).toEqual({ block: true, reason: expect.stringContaining("policy blocked") });
    },
    30_000,
  );
});
