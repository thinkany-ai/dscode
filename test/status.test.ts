import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createRoutePhaseState, createRouteState } from "../packages/core/src/route-profile.js";
import { formatStatusReport, summarizeSessionUsage } from "../packages/core/src/status.js";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: input / 1_000_000,
      output: output / 1_000_000,
      cacheRead: cacheRead / 10_000_000,
      cacheWrite: 0,
      total: (input + output) / 1_000_000 + cacheRead / 10_000_000,
    },
  };
}

describe("/status", () => {
  const entries = [
    {
      type: "message",
      message: { role: "assistant", usage: usage(2_000, 500, 8_000) },
    },
    {
      type: "message",
      message: { role: "assistant", usage: usage(1_000, 250, 19_000) },
    },
    { type: "compaction", usage: usage(200, 100) },
  ] as unknown as SessionEntry[];

  it("summarizes cumulative use and the latest prompt cache rate", () => {
    const summary = summarizeSessionUsage(entries);
    expect(summary.input).toBe(3_200);
    expect(summary.output).toBe(850);
    expect(summary.cacheRead).toBe(27_000);
    expect(summary.latestCacheHitRate).toBe(95);
  });

  it("explains the stats that are hidden from the default footer", () => {
    const route = createRouteState("repair-react", "auto", "repair/debug keywords", 0.75);
    const report = formatStatusReport({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      transport: "responses",
      effort: "max",
      permission: "auto",
      sandbox: "Seatbelt workspace-write",
      network: false,
      cwd: "/work/dscode",
      branch: "main",
      route,
      routePhase: createRoutePhaseState(route, 1),
      context: { tokens: 59_000, contextWindow: 1_000_000, percent: 5.9 },
      entries,
    });
    expect(report).toContain("95.0% latest hit");
    expect(report).toContain("59k / 1.0M");
    expect(report).toContain("3.2k uncached input");
    expect(report).toContain("network blocked");
    expect(report).toContain("route      repair react · auto · 75% · repair/debug keywords · thinking high · working · turn 1");
  });
});
