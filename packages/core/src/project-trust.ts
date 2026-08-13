import path from "node:path";
import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { getDSCodeAgentDir } from "./auth.js";

export function registerDSCodeProjectTrust(
  pi: ExtensionAPI,
  agentDir = getDSCodeAgentDir(),
): void {
  pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
    const store = new ProjectTrustStore(agentDir);
    const saved = store.get(event.cwd);
    if (saved !== null) return { trusted: saved ? "yes" : "no" };
    if (!ctx.hasUI) return { trusted: "no" };

    const parent = path.dirname(event.cwd);
    const parentChoice = parent === event.cwd ? undefined : `Trust parent folder (${parent})`;
    const options = [
      "Trust this project",
      ...(parentChoice ? [parentChoice] : []),
      "Trust for this session only",
      "Do not trust this project",
      "Do not trust for this session only",
    ];
    const choice = await ctx.ui.select(
      [
        "Trust this DSCode project?",
        event.cwd,
        "",
        "Trusted projects may load local settings, instructions, skills, hooks, MCP servers, packages, and extensions.",
      ].join("\n"),
      options,
    );

    if (choice === "Trust this project") return { trusted: "yes", remember: true };
    if (choice === parentChoice && parentChoice) {
      try {
        store.setMany([
          { path: parent, decision: true },
          { path: event.cwd, decision: null },
        ]);
        return { trusted: "yes" };
      } catch (error) {
        ctx.ui.notify(`Could not save project trust: ${(error as Error).message}`, "error");
        return { trusted: "no" };
      }
    }
    if (choice === "Trust for this session only") return { trusted: "yes" };
    if (choice === "Do not trust this project") return { trusted: "no", remember: true };
    return { trusted: "no" };
  });
}

export function setDSCodeProjectTrusted(cwd: string, trusted = true, agentDir = getDSCodeAgentDir()): void {
  new ProjectTrustStore(agentDir).setMany([{ path: path.resolve(cwd), decision: trusted }]);
}
