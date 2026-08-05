import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsSandboxCommand,
  parseWindowsSandboxLifecycleCommand,
} from "../packages/core/src/windows-sandbox.js";

describe("Windows native sandbox protocol", () => {
  const requests: string[] = [];

  afterEach(async () => {
    await Promise.all(requests.splice(0).map((request) => fs.rm(request, { force: true })));
  });

  it("writes a structured helper request without host credentials", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-windows-request-"));
    try {
      const invocation = buildWindowsSandboxCommand(
        "Write-Output 'hello world'",
        cwd,
        { mode: "workspace-write", network: false },
        {
          helperPath: "C:\\DSCode\\dscode-windows-sandbox.exe",
          statePath: "C:\\DSCode\\state.bin",
          shell: {
            command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            args: ["-NoProfile", "-Command", "Write-Output 'hello world'"],
            description: "PowerShell 7",
          },
        },
      );
      const requestPath = invocation.args[1]!;
      requests.push(requestPath);
      const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as Record<string, unknown>;

      expect(invocation.args[0]).toBe("run");
      expect(invocation.description).toBe(
        "Windows native sandbox (workspace-write, no network)",
      );
      expect(request).toMatchObject({
        version: 1,
        state_path: "C:\\DSCode\\state.bin",
        mode: "workspace-write",
        network: false,
        cwd: path.resolve(cwd),
      });
      expect(request.command).toBeTruthy();
      expect(request.args).toBeInstanceOf(Array);
      expect(request).not.toHaveProperty("env");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("parses only explicit lifecycle commands", () => {
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "setup"])).toBe("setup");
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "status"])).toBe("status");
    expect(parseWindowsSandboxLifecycleCommand(["sandbox", "uninstall"])).toBe("uninstall");
    expect(parseWindowsSandboxLifecycleCommand(["--sandbox", "read-only"])).toBeUndefined();
    expect(() => parseWindowsSandboxLifecycleCommand(["sandbox", "repair"])).toThrow(
      "Usage: dscode sandbox <setup|status|uninstall>",
    );
  });
});
