import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runProcess } from "./process.js";
import type { DSCodeRuntimeOptions } from "./runtime-options.js";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.js";

const agentTaskSchema = Type.Object({
  role: Type.Union([
    Type.Literal("explorer"),
    Type.Literal("implementer"),
    Type.Literal("reviewer"),
    Type.Literal("tester"),
  ]),
  task: Type.String({ minLength: 1 }),
});
const delegateSchema = Type.Object({
  tasks: Type.Array(agentTaskSchema, { minItems: 1, maxItems: 8 }),
});

type AgentRole = "explorer" | "implementer" | "reviewer" | "tester";

interface SubagentResult {
  role: AgentRole;
  task: string;
  success: boolean;
  output: string;
  worktree?: string;
  diff?: string;
}

export function registerSubagentTools(
  pi: ExtensionAPI,
  runtime: DSCodeRuntimeOptions,
): void {
  if (Number(process.env.DSCODE_SUBAGENT_DEPTH ?? "0") >= 1) return;

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run independent explorer, implementer, reviewer, or tester agents in parallel. Implementers work in isolated Git worktrees.",
    promptSnippet: "delegate: run independent repository tasks in parallel agents",
    promptGuidelines: [
      "Delegate only independent work with a concrete deliverable.",
      "Use explorer/reviewer for read-only evidence and implementer for isolated candidate changes.",
      "The main agent owns final integration and verification.",
    ],
    parameters: delegateSchema,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      const results = await mapLimited(params.tasks, 4, async (task) => {
        let result: SubagentResult;
        try {
          result = await runSubagent(ctx.cwd, task.role, task.task, runtime, signal);
        } catch (error) {
          result = {
            role: task.role,
            task: task.task,
            success: false,
            output: (error as Error).message,
          };
        }
        onUpdate?.({
          content: [
            {
              type: "text",
              text: resultsSummary([result]),
            },
          ],
          details: { results: [result] },
        });
        return result;
      });
      return {
        content: [{ type: "text", text: resultsSummary(results) }],
        details: { results },
      };
    },
    renderCall(args, theme, context) {
      const roles = [...new Set(args.tasks.map((task) => task.role))].join(", ");
      return renderToolCall(
        "Delegated",
        `${args.tasks.length} ${args.tasks.length === 1 ? "task" : "tasks"} · ${roles}`,
        theme,
        context,
      );
    },
    renderResult(result, renderOptions, theme, context) {
      const results = (result.details as { results?: SubagentResult[] } | undefined)?.results ?? [];
      const failures = results.filter((item) => !item.success).length;
      return renderCollapsibleToolResult(result, renderOptions, theme, context, {
        collapsedSummary: `${results.length - failures}/${results.length} agents succeeded`,
        forceError: failures > 0,
      });
    },
  });

  pi.registerCommand("agents", {
    description: "Show subagent roles and worktree behavior",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "explorer: read-only repository investigation",
          "reviewer: read-only review",
          "tester: sandboxed test/diagnostic run",
          "implementer: isolated detached Git worktree; returns diff",
        ].join("\n"),
        "info",
      );
    },
  });
}

async function runSubagent(
  cwd: string,
  role: AgentRole,
  task: string,
  runtime: DSCodeRuntimeOptions,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  let agentCwd = cwd;
  let worktree: string | undefined;
  if (role === "implementer") {
    worktree = await createWorktree(cwd);
    agentCwd = worktree;
  }

  const readOnly = role === "explorer" || role === "reviewer";
  const rolePrompt = `${roleInstructions(role)}

Task:
${task}

Return concise evidence, exact file paths, commands/checks, and any unresolved risks.`;
  const invocation = childInvocation();
  const args = [
    ...invocation.prefix,
    "-C",
    agentCwd,
    "--provider",
    runtime.providerId,
    "--base-url",
    runtime.baseUrl,
    "--transport",
    runtime.transport,
    "--model",
    runtime.modelId,
    "--harness",
    runtime.harness,
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--permission",
    readOnly ? "plan" : "auto",
    "--sandbox",
    readOnly ? "read-only" : "workspace-write",
    "--thinking",
    role === "explorer" ? "low" : "max",
    "--route",
    runtime.route,
    ...(runtime.network ? ["--network"] : []),
    ...(runtime.webSearch ? ["--web"] : []),
    rolePrompt,
  ];
  const env = {
    ...process.env,
    DSCODE_SUBAGENT_DEPTH: String(Number(process.env.DSCODE_SUBAGENT_DEPTH ?? "0") + 1),
  };
  const execution = await spawnCapture(invocation.command, args, agentCwd, env, signal);
  let diff: string | undefined;
  if (worktree) {
    await runProcess("git", ["add", "-N", "--", "."], {
      cwd: worktree,
      timeoutMs: 30_000,
      maxOutputBytes: 10_000,
    });
    const diffResult = await runProcess("git", ["diff", "--binary", "--no-ext-diff"], {
      cwd: worktree,
      timeoutMs: 30_000,
      maxOutputBytes: 100_000,
    });
    diff = diffResult.stdout;
  }
  return {
    role,
    task,
    success: execution.exitCode === 0,
    output: extractJsonFinalOutput(execution.stdout) || execution.stderr || "(no output)",
    ...(worktree ? { worktree } : {}),
    ...(diff ? { diff } : {}),
  };
}

async function createWorktree(cwd: string): Promise<string> {
  const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
  });
  if (rootResult.exitCode !== 0) {
    throw new Error("Implementer agents require a Git repository");
  }
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dscode-worktree-"));
  const target = path.join(parent, "workspace");
  const result = await runProcess("git", ["worktree", "add", "--detach", target, "HEAD"], {
    cwd: rootResult.stdout.trim(),
    timeoutMs: 60_000,
    maxOutputBytes: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Could not create isolated worktree");
  }
  return target;
}

function childInvocation(): { command: string; prefix: string[] } {
  const script = process.argv[1];
  if (!script) throw new Error("Cannot locate the DSCode entrypoint");
  if (script.endsWith(".ts")) {
    const executable = path.resolve(path.dirname(script), "..", "node_modules", ".bin", "tsx");
    if (!fs.existsSync(executable)) throw new Error("tsx executable is unavailable for subagents");
    return { command: executable, prefix: [script] };
  }
  return { command: process.execPath, prefix: [script] };
}

function spawnCapture(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-500_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-100_000);
    });
    const abort = (): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall back to the direct child.
        }
      }
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", reject);
    child.once("close", (exitCode) => {
      signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function extractJsonFinalOutput(jsonl: string): string {
  const assistantTexts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const text = event.message.content
        ?.filter((part: Record<string, unknown>) => part.type === "text")
        .map((part: Record<string, unknown>) => String(part.text ?? ""))
        .join("\n");
      if (text) assistantTexts.push(text);
    } catch {
      // Ignore non-protocol stderr/noise accidentally written to stdout.
    }
  }
  return assistantTexts.at(-1) ?? "";
}

function roleInstructions(role: AgentRole): string {
  switch (role) {
    case "explorer":
      return "You are a read-only repository explorer. Do not modify files.";
    case "reviewer":
      return "You are an independent code reviewer. Do not modify files; prioritize correctness and regressions.";
    case "tester":
      return "You are a test and diagnostics agent. Run focused checks and diagnose failures.";
    case "implementer":
      return "You are an implementation agent in an isolated Git worktree. Make focused changes and run relevant checks.";
  }
}

function resultsSummary(results: SubagentResult[]): string {
  return results
    .map((result, index) => {
      const sections = [
        `## ${index + 1}. ${result.role} — ${result.success ? "completed" : "failed"}`,
        result.output,
        result.worktree ? `worktree: ${result.worktree}` : "",
        result.diff ? `candidate diff:\n\`\`\`diff\n${result.diff}\n\`\`\`` : "",
      ].filter(Boolean);
      return sections.join("\n\n");
    })
    .join("\n\n");
}

async function mapLimited<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
