import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { PermissionMode } from "./config.js";
import type { RoutePhaseState, RouteState } from "./route-profile.js";
import { formatRoutePhaseStatus, formatRouteStatus } from "./route-profile.js";
import { formatCwd } from "./welcome.js";

export interface SessionUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

export interface StatusReportDetails {
  provider: string;
  model: string;
  transport: string;
  effort: string;
  permission: PermissionMode;
  sandbox: string;
  network: boolean;
  cwd: string;
  branch?: string | undefined;
  sessionName?: string | undefined;
  sessionFile?: string | undefined;
  route?: RouteState | undefined;
  routePhase?: RoutePhaseState | undefined;
  context?: {
    tokens?: number | undefined;
    contextWindow: number;
    percent: number | null;
  } | undefined;
  entries: SessionEntry[];
}

export function summarizeSessionUsage(entries: SessionEntry[]): SessionUsageSummary {
  const summary: SessionUsageSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const entry of entries) {
    const usage = usageFromEntry(entry);
    if (!usage) continue;
    summary.input += usage.input;
    summary.output += usage.output;
    summary.cacheRead += usage.cacheRead;
    summary.cacheWrite += usage.cacheWrite;
    summary.cost += usage.cost.total;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      if (prompt > 0) summary.latestCacheHitRate = (usage.cacheRead / prompt) * 100;
    }
  }
  return summary;
}

export function formatStatusReport(details: StatusReportDetails): string {
  const usage = summarizeSessionUsage(details.entries);
  const workspace = `${formatCwd(details.cwd)}${details.branch ? ` (${details.branch})` : ""}`;
  const context = details.context
    ? `${details.context.percent === null ? "?" : `${details.context.percent.toFixed(1)}%`} · ${formatTokenCount(
        details.context.tokens ?? 0,
      )} / ${formatTokenCount(details.context.contextWindow)} · auto compact`
    : "not reported yet";
  const cache =
    usage.latestCacheHitRate === undefined && usage.cacheRead === 0 && usage.cacheWrite === 0
      ? "not reported yet"
      : `${usage.latestCacheHitRate === undefined ? "?" : `${usage.latestCacheHitRate.toFixed(1)}%`} latest hit · ${formatTokenCount(
          usage.cacheRead,
        )} read${usage.cacheWrite ? ` · ${formatTokenCount(usage.cacheWrite)} write` : ""}`;
  const session = details.sessionName || details.sessionFile || "memory only";
  return [
    "DSCode status",
    `model      ${details.provider}/${details.model} · ${details.effort} · ${details.transport}`,
    `workspace  ${workspace}`,
    `access     ${details.permission} · ${details.sandbox} · network ${details.network ? "enabled" : "blocked"}`,
    `route      ${formatRouteStatus(details.route)} · ${formatRoutePhaseStatus(details.routePhase)}`,
    `context    ${context}`,
    `cache      ${cache}`,
    `tokens     ${formatTokenCount(usage.input)} uncached input · ${formatTokenCount(usage.output)} output`,
    `cost       $${usage.cost.toFixed(3)}`,
    `session    ${session}`,
  ].join("\n");
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function usageFromEntry(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message" && entry.message.role === "assistant") return entry.message.usage;
  if (entry.type === "message" && entry.message.role === "toolResult") return entry.message.usage;
  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    return entry.usage;
  }
  return undefined;
}
