import { describe, expect, it } from "vitest";
import {
  commandNeedsNetwork,
  detectSandboxBoundary,
  SessionAccessController,
} from "../packages/core/src/access.js";

describe("Codex-style scoped access escalation", () => {
  it("maps full permission to host and network access", () => {
    const access = new SessionAccessController("workspace-write", false);
    expect(access.effective("auto")).toEqual({ sandbox: "workspace-write", network: false });
    expect(access.effective("full")).toEqual({ sandbox: "danger-full-access", network: true });
  });

  it("keeps the workspace boundary for the trusted Weixin runtime", () => {
    const access = new SessionAccessController("workspace-write", false);
    expect(access.effective("trusted-workspace")).toEqual({ sandbox: "workspace-write", network: true });
    expect(access.forCommand("trusted-workspace", "curl https://example.com")).toEqual({
      sandbox: "workspace-write",
      network: true,
    });
  });

  it("supports one-shot and session network grants", () => {
    const access = new SessionAccessController("workspace-write", false);
    expect(access.grantOnce("auto", "network")).toEqual({
      sandbox: "workspace-write",
      network: true,
    });
    expect(access.effective("auto").network).toBe(false);
    access.grantForSession("network", "git push origin main");
    expect(access.effective("auto").network).toBe(false);
    expect(access.forCommand("auto", "git   push origin main").network).toBe(true);
    expect(access.forCommand("auto", "pnpm test").network).toBe(false);
    expect(access.describeGrants()).toContain("network (1 command)");
  });

  it("keeps plan mode read-only while retaining an explicit network grant", () => {
    const access = new SessionAccessController("workspace-write", true);
    expect(access.effective("plan")).toEqual({ sandbox: "read-only", network: true });
  });

  it("scopes session host access to one command and never carries it into plan mode", () => {
    const access = new SessionAccessController("workspace-write", false);
    access.grantForSession("host", "touch ~/.config/tool/config.json");
    expect(access.forCommand("auto", "touch ~/.config/tool/config.json")).toEqual({
      sandbox: "danger-full-access",
      network: true,
    });
    expect(access.forCommand("auto", "pnpm test")).toEqual({
      sandbox: "workspace-write",
      network: false,
    });
    expect(access.forCommand("plan", "touch ~/.config/tool/config.json")).toEqual({
      sandbox: "read-only",
      network: false,
    });
  });

  it("recognizes common commands that need network access", () => {
    for (const command of [
      "git push -u origin main",
      "pnpm install",
      "curl https://example.com",
      "gh pr create",
    ]) {
      expect(commandNeedsNetwork(command), command).toBe(true);
    }
    expect(commandNeedsNetwork("pnpm test")).toBe(false);
    expect(commandNeedsNetwork("git status")).toBe(false);
  });

  it("classifies Seatbelt network and filesystem denials", () => {
    const base = {
      processId: "p1",
      running: false,
      exitCode: 1,
      timedOut: false,
      sandbox: "macOS Seatbelt (workspace-write, no network)",
    };
    expect(
      detectSandboxBoundary(
        "git push origin main",
        { ...base, output: "ssh: connect to host github.com: Operation not permitted" },
        { sandbox: "workspace-write", network: false },
      ),
    ).toBe("network");
    expect(
      detectSandboxBoundary(
        "touch ~/.config/file",
        { ...base, output: "touch: Operation not permitted" },
        { sandbox: "workspace-write", network: false },
      ),
    ).toBe("host");
  });
});
