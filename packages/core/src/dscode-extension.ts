import type { AgentTool, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  SessionEntry,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  commandNeedsNetwork,
  detectSandboxBoundary,
  SessionAccessController,
  type AccessBoundary,
  type EffectiveAccess,
} from "./access.js";
import { classifyCommand } from "./approval.js";
import { brandBlue } from "./brand.js";
import { capturePatchCheckpoint, restoreCheckpoint, type PatchCheckpoint } from "./checkpoint.js";
import { permissionSchema, type PermissionMode } from "./config.js";
import { optimizeDeepSeekResponsesPayload } from "./deepseek.js";
import { registerDiagnosticsTool } from "./diagnostics.js";
import { registerNaturalExit } from "./exit.js";
import { registerHooks } from "./hooks.js";
import { registerLocalImageInput } from "./image-input.js";
import { partitionSessionFile } from "./home.js";
import { ManagedProcessRegistry, type ManagedProcessResult } from "./managed-process.js";
import { MCPManager } from "./mcp.js";
import { applyWorkspacePatch, type ApplyPatchResult } from "./patch.js";
import {
  formatPlanForExecution,
  PLAN_STATE_ENTRY,
  planWidgetLines,
  registerPlanTool,
  restorePlanState,
  type PlanState,
} from "./plan.js";
import { discoverProjectCommands } from "./project-profile.js";
import { registerDSCodeProjectTrust } from "./project-trust.js";
import { defaultModelForProvider } from "./providers.js";
import type { DSCodeRuntimeOptions } from "./runtime-options.js";
import { executeSandboxedCommand, sandboxDescription } from "./sandbox.js";
import { registerSessionCommands } from "./session-commands.js";
import { formatStatusReport } from "./status.js";
import { normalizeDeepSeekBaseUrl, saveDeepSeekBaseUrl } from "./settings.js";
import { registerSubagentTools } from "./subagents.js";
import {
  oneLine,
  renderCollapsibleToolResult,
  renderToolCall,
  type ToolPresentationContext,
} from "./tool-ui.js";
import { createCodingTools } from "./tools.js";
import { formatThinkingLabel, registerCodingTui } from "./tui-experience.js";
import { Workspace } from "./workspace.js";

const CHECKPOINT_ENTRY = "dscode-checkpoint";
const CHECKPOINT_UNDO_ENTRY = "dscode-checkpoint-undone";
const DIFF_ENTRY = "dscode-diff";

const planAllowedTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read_file",
  "list_files",
  "search_files",
  "language_diagnostics",
  "exec_command",
  "write_stdin",
  "update_plan",
]);
const askWithoutPromptTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read_file",
  "list_files",
  "search_files",
  "language_diagnostics",
]);

const execCommandParameters = Type.Object({
  cmd: Type.String({
    minLength: 1,
    description: "Shell command to execute from the current workspace",
  }),
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 30_000,
      description: "Return after this many milliseconds if the process is still running",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 1_000,
      maximum: 600_000,
      description: "Terminate the process after this many milliseconds",
    }),
  ),
});

const writeStdinParameters = Type.Object({
  process_id: Type.String({ minLength: 1 }),
  chars: Type.Optional(Type.String({ description: "Characters to write to stdin" })),
  yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  terminate: Type.Optional(Type.Boolean({ description: "Terminate this process" })),
});

const applyPatchParameters = Type.Object({
  input: Type.String({
    minLength: 1,
    description: "A complete *** Begin Patch / *** End Patch patch",
  }),
});

export function createDSCodeExtension(options: DSCodeRuntimeOptions): InlineExtension {
  return {
    name: "dscode",
    factory(pi) {
      registerDSCodeProjectTrust(pi);
      const processes = new ManagedProcessRegistry();
      const mcp = new MCPManager();
      let permission: PermissionMode = options.permission;
      let permissionBeforePlan: Exclude<PermissionMode, "plan"> =
        options.permission === "plan" ? "auto" : options.permission;
      const checkpoints: PatchCheckpoint[] = [];
      const undone = new Set<string>();
      let toolsBeforePlan: string[] | undefined;
      let projectCommands: string[] = [];
      let lastAgentFailed = false;
      let sessionPartition = Promise.resolve();
      let planState: PlanState | undefined;
      let lastOfferedPlanRevision = 0;
      const access = new SessionAccessController(options.sandbox, options.network);
      const effectiveAccess = (): EffectiveAccess => access.effective(permission);

      const queueSessionPartition = (ctx: ExtensionContext): Promise<void> => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) return sessionPartition;
        sessionPartition = sessionPartition
          .catch(() => undefined)
          .then(async () => {
            await partitionSessionFile(sessionFile);
          })
          .catch(() => undefined);
        return sessionPartition;
      };

      const updateStatus = (ctx: ExtensionContext): void => {
        const currentAccess = effectiveAccess();
        const status = `DSCode · ${permission} · ${sandboxDescription({
          mode: currentAccess.sandbox,
          network: currentAccess.network,
        })}`;
        ctx.ui.setStatus(
          "dscode",
          permission === "plan"
            ? ctx.ui.theme.fg("warning", status)
            : brandBlue(status, ctx.ui.theme),
        );
        ctx.ui.setTitle(`DSCode — ${ctx.cwd}`);
        ctx.ui.setWidget("dscode-plan", planWidgetLines(planState, ctx));
      };

      registerDeepSeekProvider(pi, options);
      registerLocalImageInput(pi);
      registerNaturalExit(pi);
      registerSessionCommands(pi);
      registerCommandTools(
        pi,
        processes,
        () => permission,
        access,
        updateStatus,
      );
      registerPatchTool(pi, checkpoints);
      if (options.harness === "safe") {
        registerSafeHarness(pi, options.cwd);
        registerDiagnosticsTool(
          pi,
          options,
          () => effectiveAccess().sandbox,
        );
      }
      registerSubagentTools(pi, options);
      registerEntryRenderers(pi);
      registerPlanTool(
        pi,
        () => planState,
        (nextPlan, ctx) => {
          planState = nextPlan;
          ctx.ui.setWidget("dscode-plan", planWidgetLines(planState, ctx));
        },
      );
      registerCodingTui(pi, options, () => ({ permission, ...effectiveAccess() }));

      const applyPermissionTools = (): void => {
        if (permission === "plan") {
          const active = pi.getActiveTools();
          if (toolsBeforePlan === undefined) {
            toolsBeforePlan = active;
          } else {
            toolsBeforePlan = [...new Set([...toolsBeforePlan, ...active])];
          }
          pi.setActiveTools(
            [...new Set([...toolsBeforePlan.filter((tool) => planAllowedTools.has(tool)), "update_plan"])],
          );
          return;
        }
        if (toolsBeforePlan !== undefined) {
          pi.setActiveTools(toolsBeforePlan);
          toolsBeforePlan = undefined;
        }
      };

      pi.on("before_provider_request", (event, ctx) => {
        if (ctx.model?.provider !== "deepseek" || options.transport !== "responses") return;
        return optimizeDeepSeekResponsesPayload(event.payload, { webSearch: options.webSearch });
      });

      pi.on("session_start", async (_event, ctx) => {
        checkpoints.length = 0;
        undone.clear();
        projectCommands = await discoverProjectCommands(ctx.cwd);
        restoreCheckpointState(ctx.sessionManager.getBranch(), checkpoints, undone);
        planState = restorePlanState(ctx.sessionManager.getBranch());
        lastOfferedPlanRevision = planState?.revision ?? 0;
        updateStatus(ctx);
        ctx.ui.setHiddenThinkingLabel(
          formatThinkingLabel(ctx.model?.name ?? ctx.model?.id ?? options.modelId),
        );
        const staleMcpTools = new Set(mcp.toolNames());
        if (staleMcpTools.size > 0) {
          pi.setActiveTools(
            pi.getActiveTools().filter((tool) => !staleMcpTools.has(tool)),
          );
          toolsBeforePlan = toolsBeforePlan?.filter((tool) => !staleMcpTools.has(tool));
        }
        await mcp.close();
        try {
          await mcp.connectConfigured(pi, ctx);
        } catch (error) {
          ctx.ui.notify(`MCP initialization failed: ${(error as Error).message}`, "warning");
        }
        const intendedTools = options.toolsExplicit
          ? options.activeTools
          : [...new Set([...options.activeTools, ...mcp.toolNames()])];
        pi.setActiveTools(intendedTools);
        toolsBeforePlan = undefined;
        applyPermissionTools();
        await queueSessionPartition(ctx);
      });

      pi.on("session_info_changed", async (_event, ctx) => {
        await queueSessionPartition(ctx);
      });

      pi.on("agent_settled", async (_event, ctx) => {
        await queueSessionPartition(ctx);
      });

      pi.on("session_shutdown", async (_event, ctx) => {
        await queueSessionPartition(ctx);
        processes.dispose();
        await mcp.close();
      });

      pi.on("before_agent_start", async (event) => {
        lastAgentFailed = false;
        const currentAccess = effectiveAccess();
        const systemPrompt = `${event.systemPrompt}\n\n${engineeringInstructions(projectCommands, currentAccess)}`;
        if (permission !== "plan") return { systemPrompt };
        return {
          systemPrompt,
          message: {
            customType: "dscode-plan-context",
            display: false,
            content: [
              "[PLAN MODE ACTIVE]",
              "Explore and reason only. File mutation tools are unavailable.",
              `Commands run in a read-only OS sandbox with network ${currentAccess.network ? "enabled" : "subject to scoped approval"}.`,
              "Use update_plan to publish a concrete implementation plan after exploration.",
              "Include validation and important risks in the plan steps or explanation.",
              "Do not claim to have changed or tested anything you could not actually run.",
            ].join("\n"),
          },
        };
      });

      pi.on("tool_call", async (event, ctx) => {
        if (
          event.toolName === "bash" ||
          event.toolName === "run_command" ||
          event.toolName === "edit" ||
          event.toolName === "write"
        ) {
          return {
            block: true,
            reason:
              event.toolName === "bash" || event.toolName === "run_command"
                ? "This shell tool bypasses DSCode's managed OS sandbox. Use exec_command instead."
                : "This write tool bypasses DSCode checkpoints. Use apply_patch instead.",
          };
        }
        if (permission === "plan" && !planAllowedTools.has(event.toolName)) {
          return {
            block: true,
            reason: `Plan mode does not allow ${event.toolName}. Run /plan to leave plan mode.`,
          };
        }
        const externalMcp = event.toolName.startsWith("mcp__");
        const command =
          event.toolName === "exec_command" &&
          isRecord(event.input) &&
          typeof event.input.cmd === "string"
            ? event.input.cmd
            : undefined;
        const dangerousCommand = command !== undefined && classifyCommand(command) === "dangerous";
        if (permission === "plan" && dangerousCommand) {
          return {
            block: true,
            reason: "Plan mode blocks destructive commands. Leave plan mode before running this command.",
          };
        }
        const needsApproval =
          permission === "ask" ||
          (permission === "auto" && (externalMcp || dangerousCommand));
        if (!needsApproval) return;
        if (!externalMcp && askWithoutPromptTools.has(event.toolName)) return;
        if (
          event.toolName === "write_stdin" &&
          isRecord(event.input) &&
          typeof event.input.chars !== "string" &&
          event.input.terminate !== true
        ) {
          return;
        }
        if (
          command !== undefined &&
          !dangerousCommand &&
          !effectiveAccess().network &&
          commandNeedsNetwork(command)
        ) {
          // The scoped network selector in exec_command is the approval UI for this action.
          return;
        }
        if (!ctx.hasUI) {
          return {
            block: true,
            reason:
              "This action requires an interactive approval UI. Use --permission full for an explicitly trusted non-interactive run.",
          };
        }
        if (dangerousCommand) {
          const approved = await ctx.ui.confirm(
            "Run destructive command?",
            `${command}\n\nThis may delete data or alter system/process state.`,
          );
          if (!approved) return { block: true, reason: "Destructive command denied by user" };
        } else if (
          event.toolName === "apply_patch" &&
          isRecord(event.input) &&
          typeof event.input.input === "string"
        ) {
          for (const section of patchApprovalSections(event.input.input)) {
            const approved = await ctx.ui.confirm(`Apply ${section.file}?`, section.patch);
            if (!approved) return { block: true, reason: `Denied ${section.file} by user` };
          }
        } else {
          const approved = await ctx.ui.confirm(
            `Allow ${event.toolName}?`,
            approvalSummary(event.toolName, event.input),
          );
          if (!approved) return { block: true, reason: "Denied by user" };
        }
      });

      pi.on("user_bash", (_event, ctx) => {
        const operations: BashOperations = {
          exec: async (command, cwd, execution) => {
            let commandAccess = access.forCommand(permission, command);
            if (!commandAccess.network && commandNeedsNetwork(command)) {
              commandAccess = await requestCommandAccess(
                "network",
                command,
                ctx,
                permission,
                commandAccess,
                access,
                updateStatus,
              );
            }
            return executeSandboxedCommand(
              command,
              cwd,
              {
                mode: commandAccess.sandbox,
                network: commandAccess.network,
              },
              execution,
            );
          },
        };
        return { operations };
      });

      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        lastAgentFailed =
          "stopReason" in event.message &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted");
      });

      pi.on("agent_end", async (_event, ctx) => {
        if (
          permission !== "plan" ||
          ctx.mode !== "tui" ||
          !planState ||
          planState.revision <= lastOfferedPlanRevision
        ) {
          return;
        }
        lastOfferedPlanRevision = planState.revision;
        ctx.ui.setWorkingVisible(false);
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select("Plan ready — what next?", [
            "Execute the plan",
            "Stay in plan mode",
            "Refine the plan",
          ]);
        } finally {
          ctx.ui.setWorkingVisible(true);
        }
        if (choice === "Execute the plan") {
          permission = permissionBeforePlan;
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          pi.sendUserMessage(
            [
              "Execute the approved plan below. Keep update_plan statuses current as you work.",
              "Maintain at most one in_progress step and only mark completed after verification.",
              "",
              formatPlanForExecution(planState),
            ].join("\n"),
            { deliverAs: "followUp" },
          );
        } else if (choice === "Refine the plan") {
          const refinement = await ctx.ui.editor("How should the plan change?", "");
          if (refinement?.trim()) {
            pi.sendUserMessage(
              `Refine the current plan using update_plan. Requested changes:\n${refinement.trim()}`,
              { deliverAs: "followUp" },
            );
          }
        }
      });

      pi.on("agent_settled", (_event, ctx) => {
        if (ctx.mode === "json" || ctx.mode === "print") {
          process.exitCode = lastAgentFailed ? 1 : 0;
        }
      });

      pi.registerCommand("plan", {
        description: "Toggle read-only planning; use /plan show or /plan clear",
        handler: async (args, ctx) => {
          const action = args.trim();
          if (action === "show") {
            ctx.ui.notify(
              planState ? formatPlanForExecution(planState) : "No structured plan is available.",
              "info",
            );
            return;
          }
          if (action === "clear") {
            planState = undefined;
            pi.appendEntry(PLAN_STATE_ENTRY, { cleared: true, updatedAt: new Date().toISOString() });
            ctx.ui.setWidget("dscode-plan", undefined);
            ctx.ui.notify("Structured plan cleared.", "info");
            return;
          }
          if (action) {
            ctx.ui.notify("Expected /plan, /plan show, or /plan clear", "warning");
            return;
          }
          if (permission === "plan") {
            permission = permissionBeforePlan;
          } else {
            permissionBeforePlan = permission;
            permission = "plan";
          }
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("permissions", {
        description: "Show or set plan|ask|auto|full",
        handler: async (args, ctx) => {
          if (!args.trim()) {
            const currentAccess = effectiveAccess();
            ctx.ui.notify(
              [
                `permission: ${permission}`,
                `sandbox: ${currentAccess.sandbox}`,
                `network: ${currentAccess.network ? "enabled" : "blocked"}`,
                `session grants: ${access.describeGrants().join(", ") || "none"}`,
                "Escalation: allow once / allow for session / deny",
              ].join("\n"),
              "info",
            );
            return;
          }
          const parsed = permissionSchema.safeParse(args.trim());
          if (!parsed.success) {
            ctx.ui.notify("Expected /permissions plan|ask|auto|full", "warning");
            return;
          }
          if (parsed.data === "full" && permission !== "full" && ctx.hasUI) {
            const approved = await ctx.ui.confirm(
              "Enable full access?",
              "Commands will run on the host with unrestricted filesystem and network access. Use only in a trusted workspace.",
            );
            if (!approved) return;
          }
          if (parsed.data === "plan" && permission !== "plan") {
            permissionBeforePlan = permission;
          }
          permission = parsed.data;
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("effort", {
        description: "Show or set model thinking effort",
        handler: async (args, ctx) => {
          const value = args.trim();
          if (!value) {
            ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
            return;
          }
          if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
            ctx.ui.notify(
              "Expected /effort off|minimal|low|medium|high|xhigh|max",
              "warning",
            );
            return;
          }
          pi.setThinkingLevel(value as ThinkingLevel);
          ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
        },
      });

      pi.registerCommand("base-url", {
        description: "Show or save the DeepSeek-compatible API base URL",
        handler: async (args, ctx) => {
          const requested = args.trim() ||
            (ctx.hasUI
              ? await ctx.ui.input("DeepSeek API base URL", options.baseUrl)
              : undefined);
          if (requested === undefined) return;
          try {
            const baseUrl = normalizeDeepSeekBaseUrl(requested || options.baseUrl);
            await saveDeepSeekBaseUrl(baseUrl);
            ctx.ui.notify(
              `${baseUrl}\nSaved. Restart DSCode to use this API endpoint.`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify((error as Error).message, "error");
          }
        },
      });

      pi.registerCommand("undo", {
        description: "Restore the last patch checkpoint; add --force to override conflicts",
        handler: async (args, ctx) => {
          const checkpoint = [...checkpoints]
            .reverse()
            .find((candidate) => !undone.has(candidate.id));
          if (!checkpoint) {
            ctx.ui.notify("No patch checkpoint is available to undo.", "info");
            return;
          }
          const force = args.trim() === "--force";
          if (ctx.hasUI) {
            const confirmed = await ctx.ui.confirm(
              `Undo ${checkpoint.id}?`,
              `${checkpoint.before.map((file) => file.path).join("\n")}\n\nChanges made after this checkpoint are protected unless --force is used.`,
            );
            if (!confirmed) return;
          }
          const workspace = new Workspace(ctx.cwd);
          await workspace.initialize();
          try {
            const restored = await restoreCheckpoint(workspace, checkpoint, force);
            undone.add(checkpoint.id);
            pi.appendEntry(CHECKPOINT_UNDO_ENTRY, {
              checkpointId: checkpoint.id,
              restoredAt: new Date().toISOString(),
            });
            ctx.ui.notify(`Restored ${restored.join(", ")}`, "info");
          } catch (error) {
            ctx.ui.notify((error as Error).message, "error");
          }
        },
      });

      pi.registerCommand("checkpoints", {
        description: "List durable patch checkpoints in the current branch",
        handler: async (_args, ctx) => {
          if (checkpoints.length === 0) {
            ctx.ui.notify("No patch checkpoints in this branch.", "info");
            return;
          }
          ctx.ui.notify(
            checkpoints
              .map(
                (checkpoint) =>
                  `${undone.has(checkpoint.id) ? "↶" : "●"} ${checkpoint.id}  ${checkpoint.before
                    .map((file) => file.path)
                    .join(", ")}`,
              )
              .join("\n"),
            "info",
          );
        },
      });

      pi.registerCommand("diff", {
        description: "Show the latest patch diff in the transcript",
        handler: async (_args, ctx) => {
          const checkpoint = [...checkpoints]
            .reverse()
            .find((candidate) => !undone.has(candidate.id));
          if (!checkpoint) {
            ctx.ui.notify("No active patch diff is available.", "info");
            return;
          }
          pi.appendEntry(DIFF_ENTRY, {
            checkpointId: checkpoint.id,
            patch: checkpoint.patch,
          });
        },
      });

      pi.registerCommand("jobs", {
        description: "List managed background command processes",
        handler: async (_args, ctx) => {
          const jobs = processes.list();
          ctx.ui.notify(
            jobs.length
              ? jobs
                  .map(
                    (job) =>
                      `${job.running ? "●" : "○"} ${job.processId} — ${job.sandbox}`,
                  )
                  .join("\n")
              : "No managed background processes.",
            "info",
          );
        },
      });

      pi.registerCommand("mcp", {
        description: "Show MCP server and tool status",
        handler: async (_args, ctx) => ctx.ui.notify(mcp.status(), "info"),
      });

      pi.registerCommand("status", {
        description: "Show model, access, context, cache, token, and cost details",
        handler: async (_args, ctx) => {
          const usage = ctx.getContextUsage();
          const currentAccess = effectiveAccess();
          const git = await pi
            .exec("git", ["branch", "--show-current"], { cwd: ctx.cwd })
            .catch(() => undefined);
          ctx.ui.notify(
            formatStatusReport({
              provider: ctx.model?.provider ?? options.providerId,
              model: ctx.model?.id ?? options.modelId,
              transport: ctx.model?.api ?? options.transport,
              effort: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              permission,
              sandbox: sandboxDescription({
                mode: currentAccess.sandbox,
                network: currentAccess.network,
              }),
              network: currentAccess.network,
              cwd: ctx.cwd,
              branch: git?.stdout.trim() || undefined,
              sessionName: ctx.sessionManager.getSessionName(),
              sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
              context: usage
                ? {
                    tokens: usage.tokens ?? 0,
                    contextWindow: usage.contextWindow,
                    percent: usage.percent,
                  }
                : undefined,
              entries: ctx.sessionManager.getEntries(),
            }),
            "info",
          );
        },
      });

      pi.registerCommand("doctor", {
        description: "Show DSCode runtime diagnostics",
        handler: async (_args, ctx) => {
          const usage = ctx.getContextUsage();
          const currentAccess = effectiveAccess();
          ctx.ui.notify(
            [
              `model: ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
              `transport: ${ctx.model?.api ?? options.transport}`,
              `image input: ${ctx.model?.input.includes("image") ? "supported" : "not supported"}`,
              `thinking: ${ctx.thinkingLevel ?? pi.getThinkingLevel()}`,
              `permission: ${permission}`,
              `sandbox: ${sandboxDescription({
                mode: currentAccess.sandbox,
                network: currentAccess.network,
              })}`,
              `session grants: ${access.describeGrants().join(", ") || "none"}`,
              `workspace trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`,
              `session: ${ctx.sessionManager.getSessionFile() ?? "memory only"}`,
              `tools: ${pi.getActiveTools().join(", ")}`,
              usage
                ? `context: ${usage.tokens?.toLocaleString() ?? "?"}/${usage.contextWindow.toLocaleString()}`
                : "context: unavailable",
              `checkpoints: ${checkpoints.length - undone.size} active`,
              `mcp:\n${mcp.status()}`,
            ].join("\n"),
            "info",
          );
        },
      });

      registerHooks(pi, effectiveAccess);
    },
  };
}

function registerDeepSeekProvider(pi: ExtensionAPI, options: DSCodeRuntimeOptions): void {
  const api = options.transport === "responses" ? "openai-responses" : "openai-completions";
  const modelId =
    options.providerId === "deepseek" ? options.modelId : defaultModelForProvider("deepseek");
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: options.baseUrl,
    apiKey: "$DEEPSEEK_API_KEY",
    api,
    authHeader: true,
    models: [
      {
        id: modelId,
        name: modelId === "deepseek-v4-flash" ? "DeepSeek V4 Flash" : modelId,
        api,
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0,
        },
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "max",
        },
        compat:
          options.transport === "responses"
            ? {
                supportsDeveloperRole: true,
                supportsLongCacheRetention: false,
                supportsStrictMode: false,
                supportsOpenAIGrammarTools: true,
                sessionAffinityFormat: "openai-nosession",
              }
            : {
                supportsStore: false,
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: true,
                thinkingFormat: "deepseek",
              },
      },
    ],
  });
}

function registerCommandTools(
  pi: ExtensionAPI,
  registry: ManagedProcessRegistry,
  getPermission: () => PermissionMode,
  accessController: SessionAccessController,
  onAccessChanged: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "exec_command",
    label: "Execute command",
    description:
      "Run a shell command in a managed OS sandbox. Long-running commands yield a process_id for write_stdin.",
    promptSnippet: "exec_command: run tests, builds, git, and other shell commands in an OS sandbox",
    promptGuidelines: [
      "Use rg or rg --files first for repository search.",
      "Use focused checks first, then broader validation.",
      "When a process is still running, use write_stdin with its process_id.",
    ],
    parameters: execCommandParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      let commandAccess = accessController.forCommand(getPermission(), params.cmd);
      if (!commandAccess.network && commandNeedsNetwork(params.cmd)) {
        commandAccess = await requestCommandAccess(
          "network",
          params.cmd,
          ctx,
          getPermission(),
          commandAccess,
          accessController,
          onAccessChanged,
        );
      }
      const run = (current: EffectiveAccess) => registry.start(params.cmd, {
        cwd: ctx.cwd,
        sandbox: { mode: current.sandbox, network: current.network },
        yieldTimeMs: params.yield_time_ms ?? 10_000,
        timeoutMs: params.timeout_ms ?? 120_000,
        ...(signal ? { signal } : {}),
      });
      let result = await run(commandAccess);
      const boundary = detectSandboxBoundary(params.cmd, result, commandAccess);
      if (boundary && !(getPermission() === "plan" && boundary === "host")) {
        commandAccess = await requestCommandAccess(
          boundary,
          params.cmd,
          ctx,
          getPermission(),
          commandAccess,
          accessController,
          onAccessChanged,
        );
        result = await run(commandAccess);
      }
      return {
        content: [{ type: "text", text: formatManagedResult(result) }],
        details: result,
      };
    },
    renderCall(args, theme, context) {
      return renderToolCall(context.isPartial ? "Run" : "Ran", args.cmd, theme, context);
    },
    renderResult(result, renderOptions, theme, context) {
      const details = result.details as ManagedProcessResult;
      return renderCollapsibleToolResult(result, renderOptions, theme, context, {
        collapsedSummary: managedProcessSummary(details),
        forceError: managedProcessFailed(details),
      });
    },
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Write to process",
    description:
      "Write characters to, poll, or terminate a managed process returned by exec_command.",
    promptSnippet: "write_stdin: interact with or poll a managed background process",
    parameters: writeStdinParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const result = await registry.interact(params.process_id, {
        ...(params.chars === undefined ? {} : { chars: params.chars }),
        yieldTimeMs: params.yield_time_ms ?? 5_000,
        terminate: params.terminate ?? false,
      });
      return {
        content: [{ type: "text", text: formatManagedResult(result) }],
        details: result,
      };
    },
    renderCall(args, theme, context) {
      const action = args.terminate ? "Stop" : args.chars === undefined ? "Poll" : "Write to";
      return renderToolCall(action, `process ${args.process_id}`, theme, context);
    },
    renderResult(result, renderOptions, theme, context) {
      const details = result.details as ManagedProcessResult;
      return renderCollapsibleToolResult(result, renderOptions, theme, context, {
        collapsedSummary: managedProcessSummary(details),
        forceError: managedProcessFailed(details),
      });
    },
  });
}

function managedProcessSummary(result: ManagedProcessResult): string {
  if (result.running) return `running · process ${result.processId} · ${result.sandbox}`;
  const lines = result.output.trimEnd() ? result.output.trimEnd().split("\n").length : 0;
  return [
    result.exitCode === 0 ? "exit 0" : `exit ${result.exitCode ?? "?"}`,
    lines > 0 ? `${lines} output ${lines === 1 ? "line" : "lines"}` : "no output",
    result.sandbox,
  ].join(" · ");
}

function managedProcessFailed(result: ManagedProcessResult): boolean {
  return result.timedOut === true ||
    (!result.running && result.exitCode !== undefined && result.exitCode !== 0);
}

async function requestCommandAccess(
  boundary: AccessBoundary,
  command: string,
  ctx: ExtensionContext,
  permission: PermissionMode,
  current: EffectiveAccess,
  controller: SessionAccessController,
  onAccessChanged: (ctx: ExtensionContext) => void,
): Promise<EffectiveAccess> {
  if (permission === "full") return controller.effective(permission);
  if (permission === "plan" && boundary === "host") {
    throw new Error("Plan mode cannot grant write access outside the read-only sandbox.");
  }
  const boundaryLabel =
    boundary === "network"
      ? "network access"
      : "unrestricted host filesystem and network access";
  if (!ctx.hasUI) {
    throw new Error(
      `Command requires ${boundaryLabel}. Re-run with ${
        boundary === "network" ? "--network" : "--permission full"
      } for an explicitly trusted non-interactive task.`,
    );
  }
  const sandbox = sandboxDescription({ mode: current.sandbox, network: current.network });
  ctx.ui.setWorkingVisible(false);
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      `${boundary === "network" ? "Allow network access?" : "Allow unrestricted host access?"}\n${oneLine(command, 100)}\nCurrent: ${sandbox}`,
      ["Allow once", "Allow this command for this session", "Deny"],
    );
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
  if (choice === "Allow once") return controller.grantOnce(permission, boundary);
  if (choice === "Allow this command for this session") {
    controller.grantForSession(boundary, command);
    onAccessChanged(ctx);
    ctx.ui.notify(`${boundaryLabel} allowed for this command during this session.`, "warning");
    return controller.forCommand(permission, command);
  }
  throw new Error(`User denied ${boundaryLabel} for: ${oneLine(command, 120)}`);
}

function registerPatchTool(pi: ExtensionAPI, checkpoints: PatchCheckpoint[]): void {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply an atomic, workspace-confined patch. Every successful patch creates a durable checkpoint that /undo can restore.",
    promptSnippet: "apply_patch: atomically add, update, move, or delete workspace files",
    promptGuidelines: [
      "Use apply_patch for file changes; keep each patch focused and reviewable.",
      "Never report a change as complete before running relevant validation.",
    ],
    parameters: applyPatchParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workspace = new Workspace(ctx.cwd);
      await workspace.initialize();
      let applied: ApplyPatchResult | undefined;
      const checkpoint = await capturePatchCheckpoint(workspace, params.input, async () => {
        applied = await applyWorkspacePatch(workspace, params.input);
      });
      checkpoints.push(checkpoint);
      pi.appendEntry(CHECKPOINT_ENTRY, checkpoint);
      const result = applied!;
      return {
        content: [
          {
            type: "text",
            text: [
              `Applied checkpoint ${checkpoint.id}.`,
              `files: ${result.files.join(", ")}`,
              `diff: +${result.additions} -${result.deletions}`,
              "Use /diff to inspect or /undo to restore this checkpoint.",
            ].join("\n"),
          },
        ],
        details: { ...result, checkpointId: checkpoint.id, patch: params.input },
      };
    },
    renderCall(args, theme, context) {
      const summary = summarizePatch(args.input);
      const header = renderToolCall("Updated", summary, theme, context);
      if (!context.expanded) return header;
      return new Text(
        `${header.render(10_000)[0]?.trimEnd() ?? ""}\n${colorPatch(args.input, theme)}`,
        0,
        0,
      );
    },
    renderResult(result, renderOptions, theme, context) {
      const details = result.details as ApplyPatchResult & { checkpointId: string };
      return renderCollapsibleToolResult(result, renderOptions, theme, context, {
        collapsedSummary: `checkpoint ${details.checkpointId} · +${details.additions} -${details.deletions}`,
      });
    },
  });
}

function registerSafeHarness(pi: ExtensionAPI, initialCwd: string): void {
  const initialWorkspace = new Workspace(initialCwd);
  const safeTools = createCodingTools(initialWorkspace, "safe").filter((tool) =>
    ["read_file", "list_files", "search_files"].includes(tool.name),
  );
  for (const template of safeTools) {
    const definition = {
      ...template,
      renderShell: "self" as const,
      async execute(
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: Parameters<AgentTool["execute"]>[3],
        ctx: ExtensionContext,
      ) {
        const workspace = new Workspace(ctx.cwd);
        await workspace.initialize();
        const live = createCodingTools(workspace, "safe").find(
          (tool) => tool.name === template.name,
        );
        if (!live) throw new Error(`Tool disappeared: ${template.name}`);
        return live.execute(id, params as never, signal, onUpdate);
      },
      renderCall(
        args: Record<string, unknown>,
        theme: Theme,
        context: ToolPresentationContext,
      ) {
        const { label, detail } = safeToolSummary(template.name, args);
        return renderToolCall(label, detail, theme, context);
      },
      renderResult(
        result: AgentToolResult<unknown>,
        renderOptions: ToolRenderResultOptions,
        theme: Theme,
        context: ToolPresentationContext,
      ) {
        return renderCollapsibleToolResult(result, renderOptions, theme, context, {
          collapsedSummary: false,
        });
      },
    } as ToolDefinition;
    pi.registerTool(definition);
  }
}

function safeToolSummary(
  name: string,
  args: Record<string, unknown>,
): { label: string; detail: string } {
  if (name === "read_file") {
    const range = args.line_start || args.line_end
      ? `:${String(args.line_start ?? 1)}-${String(args.line_end ?? "")}`
      : "";
    return { label: "Read", detail: `${String(args.path ?? "file")}${range}` };
  }
  if (name === "list_files") {
    return { label: "Listed", detail: String(args.pattern ?? "workspace files") };
  }
  if (name === "search_files") {
    return {
      label: "Searched",
      detail: `${oneLine(String(args.query ?? ""), 80)} in ${String(args.path ?? ".")}`,
    };
  }
  return { label: name, detail: "" };
}

function registerEntryRenderers(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<PatchCheckpoint>(
    CHECKPOINT_ENTRY,
    (entry, { expanded }, theme) => {
      if (!entry.data) return undefined;
      const files = entry.data.before.map((file) => file.path).join(", ");
      return new Text(
        [
          `${theme.fg("success", "✓ checkpoint")} ${entry.data.id} ${theme.fg("muted", files)}`,
          ...(expanded ? [colorPatch(entry.data.patch, theme)] : []),
        ].join("\n"),
        0,
        0,
      );
    },
  );
  pi.registerEntryRenderer<{ checkpointId: string; restoredAt: string }>(
    CHECKPOINT_UNDO_ENTRY,
    (entry, _options, theme) =>
      entry.data
        ? new Text(
            `${theme.fg("warning", "↶ undo")} ${entry.data.checkpointId}`,
            0,
            0,
          )
        : undefined,
  );
  pi.registerEntryRenderer<{ checkpointId: string; patch: string }>(
    DIFF_ENTRY,
    (entry, _options, theme) =>
      entry.data
        ? new Text(
            `${brandBlue(`diff ${entry.data.checkpointId}`, theme)}\n${colorPatch(entry.data.patch, theme)}`,
            0,
            0,
          )
        : undefined,
  );
}

function restoreCheckpointState(
  entries: SessionEntry[],
  checkpoints: PatchCheckpoint[],
  undone: Set<string>,
): void {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CHECKPOINT_ENTRY && isCheckpoint(entry.data)) {
      checkpoints.push(entry.data);
    } else if (
      entry.customType === CHECKPOINT_UNDO_ENTRY &&
      isRecord(entry.data) &&
      typeof entry.data.checkpointId === "string"
    ) {
      undone.add(entry.data.checkpointId);
    }
  }
}

function isCheckpoint(value: unknown): value is PatchCheckpoint {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.patch === "string" &&
    Array.isArray(value.before) &&
    Array.isArray(value.after)
  );
}

function approvalSummary(tool: string, input: unknown): string {
  if (!isRecord(input)) return `Tool: ${tool}`;
  if (tool === "apply_patch" && typeof input.input === "string") {
    return `${summarizePatch(input.input)}\n\n${input.input.slice(0, 8_000)}`;
  }
  if (tool === "exec_command" && typeof input.cmd === "string") return input.cmd;
  return JSON.stringify(input, null, 2).slice(0, 8_000);
}

function summarizePatch(input: string): string {
  const files = input
    .split("\n")
    .flatMap((line) => {
      const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
  const additions = input.split("\n").filter((line) => line.startsWith("+")).length;
  const deletions = input.split("\n").filter((line) => line.startsWith("-")).length;
  return `${[...new Set(files)].join(", ") || "patch"} (+${additions} -${deletions})`;
}

function patchApprovalSections(input: string): Array<{ file: string; patch: string }> {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const sections: Array<{ file: string; lines: string[] }> = [];
  let current: { file: string; lines: string[] } | undefined;
  for (const line of lines) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File): (.+)$/.exec(line);
    if (match?.[1]) {
      if (current) sections.push(current);
      current = { file: match[1], lines: [line] };
      continue;
    }
    if (!current || line === "*** Begin Patch" || line === "*** End Patch") continue;
    current.lines.push(line);
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    return [{ file: "patch", patch: input.slice(0, 8_000) }];
  }
  return sections.map((section) => ({
    file: section.file,
    patch: section.lines.join("\n").slice(0, 8_000),
  }));
}

function colorPatch(
  patch: string,
  theme: ExtensionContext["ui"]["theme"],
): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function formatManagedResult(result: ManagedProcessResult): string {
  return [
    result.output.trimEnd(),
    `process_id: ${result.processId}`,
    `status: ${result.running ? "running" : "completed"}`,
    ...(result.running ? ["Use write_stdin to poll or interact."] : []),
    ...(result.exitCode === undefined ? [] : [`exit_code: ${result.exitCode}`]),
    ...(result.timedOut ? ["timed_out: true"] : []),
    `sandbox: ${result.sandbox}`,
  ].join("\n");
}

function engineeringInstructions(
  projectCommands: string[],
  access: EffectiveAccess,
): string {
  const commandSandbox = sandboxDescription({ mode: access.sandbox, network: access.network });
  const instructions = [
    "# DSCode engineering contract",
    "- Work to a verified repository outcome: inspect first, make focused changes, run the narrowest relevant checks, then broaden validation in proportion to risk.",
    "- When a check fails, diagnose the evidence and keep repairing while a safe in-scope next step remains. Never hide, truncate in prose, or reinterpret a failing exit code as success.",
    "- Before changing files below nested directories, discover applicable AGENTS.md and CLAUDE.md files and obey them from broadest to most specific scope.",
    "- Preserve user changes and unrelated dirty-worktree edits. Never use destructive Git recovery commands unless explicitly requested.",
    "- Prefer rg and rg --files for search. Use apply_patch for focused writes so changes are checkpointed and undoable.",
    "- Use update_plan for complex multi-step work. Keep at most one step in_progress and update statuses as verified work advances.",
    "- Use delegate only for genuinely independent work. The parent agent owns integration and final verification.",
    `- Commands execute locally in ${commandSandbox}; this is the DSCode OS sandbox, not a model-provider cloud sandbox.`,
    `- Command network access is ${access.network ? "enabled" : "disabled until the user grants scoped access"}; do not work around this boundary.`,
    ...(access.network
      ? []
      : [
          "- DSCode handles recognized network and sandbox denials with an allow-once / allow-for-session / deny prompt and retries approved commands automatically. If the user denies access, report that decision; do not suggest bypassing the sandbox.",
        ]),
    "- Keep the final answer evidence-based: changed files, checks actually run, failures or limitations, and the shortest useful next action.",
  ];
  if (projectCommands.length > 0) {
    instructions.push(
      "- Detected project commands (inspect their definitions before relying on them):",
      ...projectCommands.map((command) => `  - ${command}`),
    );
  }
  return instructions.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
