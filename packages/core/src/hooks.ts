import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { EffectiveAccess } from "./access.js";
import { runProcess } from "./process.js";
import { sandboxCommand } from "./sandbox.js";
import { getDSCodeHome } from "./home.js";

const hookSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
});
const hooksConfigSchema = z.object({
  hooks: z
    .object({
      sessionStart: z.array(hookSchema).default([]),
      beforeTool: z.array(hookSchema).default([]),
      afterTool: z.array(hookSchema).default([]),
      agentEnd: z.array(hookSchema).default([]),
    })
    .default({
      sessionStart: [],
      beforeTool: [],
      afterTool: [],
      agentEnd: [],
    }),
});
type Hook = z.infer<typeof hookSchema>;
type HookConfig = z.infer<typeof hooksConfigSchema>["hooks"];

export function registerHooks(
  pi: ExtensionAPI,
  getAccess: () => EffectiveAccess,
): void {
  let config: HookConfig = {
    sessionStart: [],
    beforeTool: [],
    afterTool: [],
    agentEnd: [],
  };

  pi.on("session_start", async (_event, ctx) => {
    config = await loadHookConfig(ctx.cwd, ctx.isProjectTrusted());
    await runHooks(
      config.sessionStart,
      ctx,
      { event: "sessionStart" },
      getAccess(),
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    const result = await runHooks(config.beforeTool, ctx, {
      event: "beforeTool",
      tool: event.toolName,
      input: event.input,
    }, getAccess());
    if (result) return { block: true, reason: result };
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    await runHooks(config.afterTool, ctx, {
      event: "afterTool",
      tool: event.toolName,
      isError: event.isError,
    }, getAccess());
  });

  pi.on("agent_end", async (_event, ctx) => {
    await runHooks(config.agentEnd, ctx, { event: "agentEnd" }, getAccess());
  });
}

async function loadHookConfig(cwd: string, includeProject: boolean): Promise<HookConfig> {
  const merged: HookConfig = {
    sessionStart: [],
    beforeTool: [],
    afterTool: [],
    agentEnd: [],
  };
  const files = [path.join(getDSCodeHome(), "hooks.json")];
  if (includeProject) files.push(path.join(cwd, ".dscode", "hooks.json"));
  for (const file of files) {
    try {
      const parsed = hooksConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      for (const key of Object.keys(merged) as Array<keyof HookConfig>) {
        merged[key].push(...parsed.hooks[key]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid hooks configuration ${file}: ${(error as Error).message}`);
    }
  }
  return merged;
}

async function runHooks(
  hooks: Hook[],
  ctx: ExtensionContext,
  payload: Record<string, unknown>,
  access: EffectiveAccess,
): Promise<string | undefined> {
  for (const hook of hooks) {
    const args = hook.args.map((argument) =>
      argument
        .replaceAll("{cwd}", ctx.cwd)
        .replaceAll("{payload}", JSON.stringify(payload))
        .replaceAll("{tool}", typeof payload.tool === "string" ? payload.tool : ""),
    );
    const command =
      process.platform === "win32" && access.sandbox === "danger-full-access"
        ? `& ${[hook.command, ...args].map(powerShellQuote).join(" ")}`
        : [hook.command, ...args].map(shellQuote).join(" ");
    const invocation = sandboxCommand(command, ctx.cwd, {
      mode: access.sandbox,
      network: access.network,
    });
    const result = await runProcess(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: hook.timeoutMs,
      maxOutputBytes: 20_000,
    });
    if (result.exitCode !== 0) {
      return (
        result.stderr.trim() ||
        result.stdout.trim() ||
        `Hook ${hook.command} exited with ${result.exitCode}`
      );
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
