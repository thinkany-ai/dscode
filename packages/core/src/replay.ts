import fs from "node:fs/promises";
import type {
  AgentTraceEvent,
  AgentTraceEventType,
  AgentTraceStatus,
  AgentTraceUsage,
} from "./observability.js";
import { AGENT_TRACE_SCHEMA_VERSION } from "./observability.js";

export interface TraceUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface TraceCounts {
  runs: number;
  turns: number;
  modelRequests: number;
  providerResponses: number;
  modelResponses: number;
  toolCalls: number;
  toolResults: number;
  toolFailures: number;
  approvals: number;
  errors: number;
  compactions: number;
}

export interface TraceReplayReport {
  source?: string;
  valid: boolean;
  events: number;
  invalidLines: number;
  parseErrors: string[];
  traceIds: string[];
  durationMs: number;
  counts: TraceCounts;
  usage: TraceUsageSummary;
  spans: {
    total: number;
    closed: number;
    unclosed: string[];
  };
  unmatchedToolCalls: string[];
  missingRunEnds: string[];
  finalStatus?: AgentTraceStatus;
  violations: string[];
}

export interface TraceComparison {
  baseline: TraceReplayReport;
  candidate: TraceReplayReport;
  deltas: Record<string, number>;
  differences: string[];
}

const TRACE_EVENT_TYPES = new Set<AgentTraceEventType>([
  "run_start",
  "agent_start",
  "turn_start",
  "turn_end",
  "model_request",
  "provider_response",
  "model_response",
  "tool_call",
  "tool_result",
  "approval",
  "compaction",
  "agent_end",
  "run_end",
  "error",
  "session_shutdown",
]);

export async function readTraceFile(filePath: string): Promise<TraceReplayReport> {
  const content = await fs.readFile(filePath, "utf8");
  return replayTraceLines(content.split(/\r?\n/), filePath);
}

export function replayTraceLines(lines: string[], source?: string): TraceReplayReport {
  const events: AgentTraceEvent[] = [];
  const parseErrors: string[] = [];
  let invalidLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isTraceEvent(value)) throw new Error("invalid event envelope");
      events.push(value);
    } catch (error) {
      invalidLines += 1;
      if (parseErrors.length < 10) {
        parseErrors.push(`line ${index + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`);
      }
    }
  }
  return summarizeTrace(events, {
    ...(source ? { source } : {}),
    parseErrors,
    invalidLines,
  });
}

export function summarizeTrace(
  events: AgentTraceEvent[],
  options: { source?: string; parseErrors?: string[]; invalidLines?: number } = {},
): TraceReplayReport {
  const counts: TraceCounts = {
    runs: 0,
    turns: 0,
    modelRequests: 0,
    providerResponses: 0,
    modelResponses: 0,
    toolCalls: 0,
    toolResults: 0,
    toolFailures: 0,
    approvals: 0,
    errors: 0,
    compactions: 0,
  };
  const usage: TraceUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  const traceIds = new Set<string>();
  const starts = new Map<string, AgentTraceEvent>();
  const closed = new Set<string>();
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  const runStarts = new Set<string>();
  const runEnds = new Set<string>();
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  let finalStatus: AgentTraceStatus | undefined;

  for (const event of events) {
    traceIds.add(event.traceId);
    const timestamp = Date.parse(event.timestamp);
    if (Number.isFinite(timestamp)) {
      firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp);
      lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp);
    }
    if (event.status === "started") starts.set(event.spanId, event);
    if (event.status !== "started") closed.add(event.spanId);
    addUsage(usage, event.usage);
    switch (event.type) {
      case "run_start":
        counts.runs += 1;
        runStarts.add(event.runId ?? event.spanId);
        break;
      case "turn_start":
        counts.turns += 1;
        break;
      case "model_request":
        counts.modelRequests += 1;
        break;
      case "provider_response":
        counts.providerResponses += 1;
        break;
      case "model_response":
        counts.modelResponses += 1;
        break;
      case "tool_call":
        counts.toolCalls += 1;
        if (event.toolCallId) toolCalls.add(event.toolCallId);
        break;
      case "tool_result":
        counts.toolResults += 1;
        if (event.status === "failed") counts.toolFailures += 1;
        if (event.toolCallId) toolResults.add(event.toolCallId);
        break;
      case "approval":
        counts.approvals += 1;
        break;
      case "error":
        counts.errors += 1;
        break;
      case "compaction":
        counts.compactions += 1;
        break;
      case "run_end":
        runEnds.add(event.runId ?? event.spanId);
        finalStatus = event.status;
        break;
      default:
        break;
    }
  }

  const unclosed = [...starts.keys()].filter((spanId) => !closed.has(spanId));
  const unmatchedToolCalls = [...toolCalls].filter((toolCallId) => !toolResults.has(toolCallId));
  const missingRunEnds = [...runStarts].filter((runId) => !runEnds.has(runId));
  const parseErrors = options.parseErrors ?? [];
  const violations = [
    ...parseErrors.map((error) => `trace parse error: ${error}`),
    ...(unclosed.length ? [`unclosed spans: ${unclosed.join(", ")}`] : []),
    ...(unmatchedToolCalls.length
      ? [`unmatched tool calls: ${unmatchedToolCalls.join(", ")}`]
      : []),
    ...(missingRunEnds.length ? [`runs without run_end: ${missingRunEnds.join(", ")}`] : []),
  ];
  return {
    ...(options.source ? { source: options.source } : {}),
    valid: violations.length === 0,
    events: events.length,
    invalidLines: options.invalidLines ?? 0,
    parseErrors,
    traceIds: [...traceIds],
    durationMs:
      firstTimestamp === undefined || lastTimestamp === undefined
        ? 0
        : Math.max(0, lastTimestamp - firstTimestamp),
    counts,
    usage,
    spans: { total: starts.size + [...closed].filter((spanId) => !starts.has(spanId)).length, closed: closed.size, unclosed },
    unmatchedToolCalls,
    missingRunEnds,
    ...(finalStatus ? { finalStatus } : {}),
    violations,
  };
}

export function compareTraceReports(
  baseline: TraceReplayReport,
  candidate: TraceReplayReport,
): TraceComparison {
  const deltas: Record<string, number> = {
    durationMs: candidate.durationMs - baseline.durationMs,
    modelRequests: candidate.counts.modelRequests - baseline.counts.modelRequests,
    modelResponses: candidate.counts.modelResponses - baseline.counts.modelResponses,
    toolCalls: candidate.counts.toolCalls - baseline.counts.toolCalls,
    toolFailures: candidate.counts.toolFailures - baseline.counts.toolFailures,
    errors: candidate.counts.errors - baseline.counts.errors,
    totalTokens: candidate.usage.totalTokens - baseline.usage.totalTokens,
    cost: candidate.usage.cost - baseline.usage.cost,
  };
  const differences = Object.entries(deltas)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}: ${formatDelta(value)}`);
  if (baseline.valid !== candidate.valid) differences.push(`valid: ${String(baseline.valid)} -> ${String(candidate.valid)}`);
  if (baseline.finalStatus !== candidate.finalStatus) {
    differences.push(`finalStatus: ${baseline.finalStatus ?? "none"} -> ${candidate.finalStatus ?? "none"}`);
  }
  return { baseline, candidate, deltas, differences };
}

export function formatReplayReport(report: TraceReplayReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    `Trace ${report.source ?? report.traceIds[0] ?? "unknown"}`,
    `valid       ${report.valid ? "yes" : "no"}`,
    `events      ${report.events}`,
    `duration    ${report.durationMs}ms`,
    `runs        ${report.counts.runs} (${report.finalStatus ?? "open"})`,
    `turns       ${report.counts.turns}`,
    `models      ${report.counts.modelRequests} request(s), ${report.counts.modelResponses} response(s)`,
    `tools       ${report.counts.toolCalls} call(s), ${report.counts.toolFailures} failure(s)`,
    `usage       ${report.usage.totalTokens} tokens · $${report.usage.cost.toFixed(4)}`,
    `spans       ${report.spans.closed}/${report.spans.total} closed`,
    ...(report.violations.length ? ["violations  ", ...report.violations.map((value) => `  ${value}`)] : []),
  ].join("\n");
}

function isTraceEvent(value: unknown): value is AgentTraceEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<AgentTraceEvent>;
  return (
    event.schemaVersion === AGENT_TRACE_SCHEMA_VERSION &&
    typeof event.traceId === "string" &&
    typeof event.spanId === "string" &&
    typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    typeof event.type === "string" &&
    TRACE_EVENT_TYPES.has(event.type as AgentTraceEventType)
  );
}

function addUsage(summary: TraceUsageSummary, usage: AgentTraceUsage | undefined): void {
  if (!usage) return;
  summary.inputTokens += usage.input ?? 0;
  summary.outputTokens += usage.output ?? 0;
  summary.cacheReadTokens += usage.cacheRead ?? 0;
  summary.cacheWriteTokens += usage.cacheWrite ?? 0;
  summary.totalTokens += usage.total ?? 0;
  summary.cost += usage.cost ?? 0;
}

function formatDelta(value: number): string {
  return Number.isInteger(value) ? (value > 0 ? `+${value}` : String(value)) : `${value > 0 ? "+" : ""}${value.toFixed(4)}`;
}
