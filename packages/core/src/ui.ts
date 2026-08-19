import type { Agent } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import pc from "picocolors";

export interface Ui {
  dispose(): void;
}

export function attachUi(agent: Agent, verbose: boolean): Ui {
  let streamedText = false;
  let thinkingOpen = false;
  let lastUsage: Usage | undefined;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        if (thinkingOpen) {
          process.stdout.write("\n");
          thinkingOpen = false;
        }
        process.stdout.write(update.delta);
        streamedText = true;
      } else if (verbose && update.type === "thinking_delta") {
        if (!thinkingOpen) {
          process.stdout.write(pc.dim("thinking: "));
          thinkingOpen = true;
        }
        process.stdout.write(pc.dim(update.delta));
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      if (streamedText || thinkingOpen) process.stdout.write("\n");
      thinkingOpen = false;
      streamedText = false;
      process.stdout.write(
        `${pc.cyan("→")} ${pc.bold(event.toolName)} ${pc.dim(summarizeArgs(event.args))}\n`,
      );
      return;
    }

    if (event.type === "tool_execution_end") {
      const failed = "isError" in event && event.isError;
      process.stdout.write(failed ? pc.red("  failed\n") : pc.green("  done\n"));
      return;
    }

    if (event.type === "turn_end" && event.message.role === "assistant") {
      lastUsage = event.message.usage;
      return;
    }

    if (event.type === "agent_end") {
      if (streamedText || thinkingOpen) process.stdout.write("\n");
      if (lastUsage && lastUsage.totalTokens > 0) {
        const promptTokens = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite;
        const cacheRate = promptTokens > 0 ? (lastUsage.cacheRead / promptTokens) * 100 : 0;
        const reasoning = lastUsage.reasoning ?? 0;
        process.stdout.write(
          pc.dim(
            `tokens ${formatNumber(promptTokens)} in (${cacheRate.toFixed(0)}% cached) · ${formatNumber(lastUsage.output)} out · ${formatNumber(reasoning)} reasoning · $${lastUsage.cost.total.toFixed(4)}\n`,
          ),
        );
      }
      streamedText = false;
      thinkingOpen = false;
      lastUsage = undefined;
    }
  });

  return { dispose: unsubscribe };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

interface BannerDetails {
  transport: string;
  harness: string;
  permission: string;
  effort: string;
}

export function printBanner(
  workspace: string,
  model: string,
  resumedMessages: number,
  details?: BannerDetails,
): void {
  process.stdout.write(
    [
      pc.bold(pc.cyan("DSCode")),
      `${pc.dim("model")}      ${model}`,
      details ? `${pc.dim("runtime")}    ${details.transport} · ${details.harness} harness` : "",
      details ? `${pc.dim("mode")}       ${details.permission} · effort ${details.effort}` : "",
      `${pc.dim("workspace")}  ${workspace}`,
      resumedMessages > 0 ? `${pc.dim("session")}    resumed (${resumedMessages} messages)` : "",
      pc.dim("Type /help for commands, Ctrl-C to interrupt, /exit to quit."),
      "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

export function printHelp(): void {
  process.stdout.write(
    [
      "/help       Show this help",
      "/clear      Clear the current conversation and saved session",
      "/compact    Summarize old context and keep recent work",
      "/plan       Toggle read-only plan mode",
      "/permissions [mode]  Show or set plan/ask/auto/full",
      "/effort [level]      Show or set low/high/max",
      "/route [profile]     Show or set auto/bootstrap/standard/deep/repair",
      "/status     Show model, workspace, and context size",
      "/exit       Save and quit",
      "",
    ].join("\n"),
  );
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "content" || key === "old_text" || key === "new_text" || key === "input") {
      summary[key] = typeof value === "string" ? `<${value.length} chars>` : value;
    } else {
      summary[key] = value;
    }
  }
  const json = JSON.stringify(summary);
  return json.length > 180 ? `${json.slice(0, 177)}...` : json;
}
