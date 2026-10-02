import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeTrace, summarizeValue } from "../packages/core/src/observability.js";
import { evaluateTrace } from "../packages/core/src/evaluation.js";
import { readTraceFile, replayTraceLines } from "../packages/core/src/replay.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("agent runtime observability", () => {
  it("writes a redacted, replayable JSONL trace without blocking record calls", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-trace-"));
    temporaryDirectories.push(directory);
    let timestamp = 1_700_000_000_000;
    const ids = ["trace-1", "run-1"];
    const trace = new AgentRuntimeTrace({
      traceDir: directory,
      now: () => new Date(timestamp += 10),
      createId: () => ids.shift() ?? "generated-id",
    });
    trace.setSession("session-1");
    trace.startRun({ provider: "deepseek", model: "test-model" });
    trace.record({
      type: "agent_start",
      spanId: "agent:run-1",
      status: "started",
      input: summarizeValue("api_key=do-not-store-this"),
    });
    trace.record({
      type: "model_request",
      spanId: "model:1",
      status: "started",
      input: summarizeValue({ prompt: "private prompt" }),
    });
    trace.record({
      type: "model_response",
      spanId: "model:1",
      status: "completed",
      usage: { input: 10, output: 4, total: 14, cost: 0.002 },
    });
    trace.record({
      type: "tool_call",
      spanId: "tool:1",
      status: "started",
      toolCallId: "call-1",
      toolName: "read_file",
      input: summarizeValue({ path: "/private/file.txt" }),
    });
    trace.record({
      type: "tool_result",
      spanId: "tool:1",
      status: "completed",
      toolCallId: "call-1",
      toolName: "read_file",
      output: summarizeValue("private file contents"),
    });
    trace.record({ type: "agent_end", spanId: "agent:run-1", status: "completed" });
    trace.endRun("completed");
    await trace.flush();

    const tracePath = trace.getTracePath();
    expect(tracePath).toBeDefined();
    const raw = await fs.readFile(tracePath!, "utf8");
    expect(raw).not.toContain("private prompt");
    expect(raw).not.toContain("private file contents");
    expect(raw).not.toContain("do-not-store-this");

    const report = await readTraceFile(tracePath!);
    expect(report.valid).toBe(true);
    expect(report.counts.modelRequests).toBe(1);
    expect(report.counts.toolCalls).toBe(1);
    expect(report.counts.toolFailures).toBe(0);
    expect(report.usage.totalTokens).toBe(14);
    expect(report.usage.cost).toBe(0.002);
  });

  it("reports malformed and structurally incomplete traces", () => {
    const report = replayTraceLines([
      JSON.stringify({
        schemaVersion: 1,
        traceId: "trace-1",
        runId: "run-1",
        spanId: "run:run-1",
        timestamp: new Date().toISOString(),
        type: "run_start",
        status: "started",
      }),
      JSON.stringify({
        schemaVersion: 1,
        traceId: "trace-1",
        runId: "run-1",
        spanId: "tool:call-1",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        status: "started",
        toolCallId: "call-1",
      }),
      "not-json",
    ]);

    expect(report.valid).toBe(false);
    expect(report.invalidLines).toBe(1);
    expect(report.unmatchedToolCalls).toEqual(["call-1"]);
    expect(report.missingRunEnds).toEqual(["run-1"]);
    expect(report.violations.join("\n")).toContain("trace parse error");
  });

  it("evaluates success and budget constraints from the same event projection", () => {
    const timestamp = new Date().toISOString();
    const events = [
      {
        schemaVersion: 1 as const,
        traceId: "trace-1",
        runId: "run-1",
        spanId: "run:run-1",
        timestamp,
        type: "run_start" as const,
        status: "started" as const,
      },
      {
        schemaVersion: 1 as const,
        traceId: "trace-1",
        runId: "run-1",
        spanId: "run:run-1",
        timestamp,
        type: "run_end" as const,
        status: "completed" as const,
      },
    ];
    const result = evaluateTrace(events, { maxToolCalls: 0 });
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(evaluateTrace(events, { maxToolCalls: -1 }).passed).toBe(false);
  });
});
