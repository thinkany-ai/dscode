import type { AgentTraceEvent } from "./observability.js";
import { replayTraceLines, summarizeTrace, type TraceReplayReport } from "./replay.js";

export interface EvaluationOptions {
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxTotalTokens?: number;
  maxCost?: number;
  requireSuccessfulRun?: boolean;
  failOnErrors?: boolean;
}

export interface EvaluationResult {
  passed: boolean;
  turns: number;
  modelRequests: number;
  toolCalls: number;
  toolFailures: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  approvals: number;
  errors: number;
  violations: string[];
  replay: TraceReplayReport;
}

export function evaluateTrace(
  events: AgentTraceEvent[],
  options: EvaluationOptions = {},
): EvaluationResult {
  return evaluateReplay(summarizeTrace(events), options);
}

export function evaluateTraceLines(
  lines: string[],
  options: EvaluationOptions = {},
): EvaluationResult {
  return evaluateReplay(replayTraceLines(lines), options);
}

export function evaluateReplay(
  replay: TraceReplayReport,
  options: EvaluationOptions = {},
): EvaluationResult {
  const violations = [...replay.violations];
  const requireSuccessfulRun = options.requireSuccessfulRun ?? true;
  const failOnErrors = options.failOnErrors ?? true;
  if (requireSuccessfulRun && replay.finalStatus !== "completed") {
    violations.push(`run did not complete successfully: ${replay.finalStatus ?? "missing"}`);
  }
  if (failOnErrors && replay.counts.errors > 0) {
    violations.push(`runtime errors: ${replay.counts.errors}`);
  }
  if (options.maxToolCalls !== undefined && replay.counts.toolCalls > options.maxToolCalls) {
    violations.push(`tool call budget exceeded: ${replay.counts.toolCalls} > ${options.maxToolCalls}`);
  }
  if (options.maxDurationMs !== undefined && replay.durationMs > options.maxDurationMs) {
    violations.push(`duration budget exceeded: ${replay.durationMs}ms > ${options.maxDurationMs}ms`);
  }
  if (options.maxTotalTokens !== undefined && replay.usage.totalTokens > options.maxTotalTokens) {
    violations.push(
      `token budget exceeded: ${replay.usage.totalTokens} > ${options.maxTotalTokens}`,
    );
  }
  if (options.maxCost !== undefined && replay.usage.cost > options.maxCost) {
    violations.push(`cost budget exceeded: $${replay.usage.cost} > $${options.maxCost}`);
  }
  return {
    passed: violations.length === 0,
    turns: replay.counts.turns,
    modelRequests: replay.counts.modelRequests,
    toolCalls: replay.counts.toolCalls,
    toolFailures: replay.counts.toolFailures,
    durationMs: replay.durationMs,
    inputTokens: replay.usage.inputTokens,
    outputTokens: replay.usage.outputTokens,
    cacheReadTokens: replay.usage.cacheReadTokens,
    cost: replay.usage.cost,
    approvals: replay.counts.approvals,
    errors: replay.counts.errors,
    violations,
    replay,
  };
}

export function formatEvaluationResult(result: EvaluationResult, json = false): string {
  if (json) {
    return JSON.stringify(
      {
        passed: result.passed,
        turns: result.turns,
        modelRequests: result.modelRequests,
        toolCalls: result.toolCalls,
        toolFailures: result.toolFailures,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cost: result.cost,
        approvals: result.approvals,
        errors: result.errors,
        violations: result.violations,
      },
      null,
      2,
    );
  }
  return [
    `Evaluation ${result.passed ? "PASSED" : "FAILED"}`,
    `turns       ${result.turns}`,
    `models      ${result.modelRequests}`,
    `tools       ${result.toolCalls} (${result.toolFailures} failure(s))`,
    `duration    ${result.durationMs}ms`,
    `tokens      ${result.inputTokens} input · ${result.outputTokens} output · ${result.cacheReadTokens} cache read`,
    `cost        $${result.cost.toFixed(4)}`,
    `approvals   ${result.approvals}`,
    `errors      ${result.errors}`,
    ...(result.violations.length ? ["violations  ", ...result.violations.map((value) => `  ${value}`)] : []),
  ].join("\n");
}
