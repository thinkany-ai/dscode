import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  createRoutePhaseState,
  createRouteState,
  formatRoutePhaseStatus,
  isOpeningRouteTurn,
  parseRouteSelection,
  restoreRoutePhaseState,
  restoreRouteState,
  routeSystemPrompt,
  routeThinkingBoost,
  routeThinkingTarget,
  ROUTE_PHASE_ENTRY,
  ROUTE_STATE_ENTRY,
} from "../packages/core/src/route-profile.js";

const now = (): Date => new Date("2026-08-17T00:00:00.000Z");

function classify(prompt: string) {
  return classifyRoute({
    prompt,
    entries: [],
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    harness: "minimal",
    permission: "auto",
    projectCommands: [],
    now,
  });
}

describe("route profile selection", () => {
  it("routes repair and debugging requests to repair-react", () => {
    expect(classify("修复这个报错，发送后会崩溃").profile).toBe("repair-react");
    expect(classify("debug this failing regression").profile).toBe("repair-react");
  });

  it("routes design and analysis requests to deep-think", () => {
    expect(classify("给我拆一个设计草案，分析架构权衡").profile).toBe("deep-think");
    expect(classify("compare the architecture trade-offs").profile).toBe("deep-think");
  });

  it("keeps exploratory short prompts anchored", () => {
    expect(classify("先看一下这个项目").profile).toBe("bootstrap-anchored");
    expect(classify("where should we start?").profile).toBe("bootstrap-anchored");
  });

  it("routes implementation requests to the standard executor", () => {
    expect(classify("实现这个功能并跑一下测试").profile).toBe("standard-executor");
    expect(classify("add tests and build").profile).toBe("standard-executor");
  });

  it("parses friendly route aliases", () => {
    expect(parseRouteSelection("auto")).toBe("auto");
    expect(parseRouteSelection("bootstrap")).toBe("bootstrap-anchored");
    expect(parseRouteSelection("标准")).toBe("standard-executor");
    expect(parseRouteSelection("deep")).toBe("deep-think");
    expect(parseRouteSelection("修复")).toBe("repair-react");
    expect(parseRouteSelection("unknown")).toBeUndefined();
  });

  it("restores the latest persisted route state", () => {
    const first = createRouteState("standard-executor", "auto", "first", 0.5, now);
    const second = createRouteState("deep-think", "manual", "manual override", 1, now);
    const entries = [
      { type: "custom", customType: ROUTE_STATE_ENTRY, data: first },
      { type: "custom", customType: "other", data: { ignored: true } },
      { type: "custom", customType: ROUTE_STATE_ENTRY, data: second },
    ] as unknown as SessionEntry[];

    expect(restoreRouteState(entries)).toEqual(second);
  });

  it("normalizes older route state entries without thinking targets", () => {
    const entries = [
      {
        type: "custom",
        customType: ROUTE_STATE_ENTRY,
        data: {
          schemaVersion: 1,
          profile: "deep-think",
          source: "auto",
          reason: "legacy",
          confidence: 0.8,
          locked: true,
          updatedAt: "2026-08-17T00:00:00.000Z",
        },
      },
    ] as unknown as SessionEntry[];

    expect(restoreRouteState(entries)).toMatchObject({
      profile: "deep-think",
      thinkingTarget: "max",
    });
  });

  it("tracks opening versus working route phases", () => {
    const route = createRouteState("deep-think", "auto", "analysis/design keywords", 0.8, now);
    const opening = createRoutePhaseState(route, 0, now);
    const working = createRoutePhaseState(route, 1, now);

    expect(isOpeningRouteTurn(route, undefined)).toBe(true);
    expect(isOpeningRouteTurn(route, opening)).toBe(true);
    expect(isOpeningRouteTurn(route, working)).toBe(false);
    expect(formatRoutePhaseStatus(opening)).toBe("opening · turn 0");
    expect(formatRoutePhaseStatus(working)).toBe("working · turn 1");
  });

  it("restores the latest persisted route phase state", () => {
    const route = createRouteState("repair-react", "manual", "manual override", 1, now);
    const phase = createRoutePhaseState(route, 2, now);
    const entries = [
      { type: "custom", customType: ROUTE_PHASE_ENTRY, data: createRoutePhaseState(route, 1, now) },
      { type: "custom", customType: ROUTE_PHASE_ENTRY, data: phase },
    ] as unknown as SessionEntry[];

    expect(restoreRoutePhaseState(entries)).toEqual(phase);
  });

  it("adds a strong opening frame without replacing safety or project instructions", () => {
    const prompt = routeSystemPrompt(
      createRouteState("repair-react", "auto", "repair/debug keywords", 0.75, now),
      { openingTurn: true },
    );
    expect(prompt).toContain("DSCode route profile: repair react (thinking target: high)");
    expect(prompt).toContain("Opening turn requirement");
    expect(prompt).toContain("We need");
    expect(prompt).toContain("diagnose -> patch -> verify");
  });

  it("keeps later turns anchored without repeating the opening frame", () => {
    const prompt = routeSystemPrompt(
      createRouteState("standard-executor", "auto", "implementation keywords", 0.75, now),
      { openingTurn: false },
    );
    expect(prompt).toContain("This route is already anchored");
    expect(prompt).not.toContain("Opening turn requirement");
  });

  it("maps profiles to thinking targets and boosts only upward", () => {
    expect(routeThinkingTarget("bootstrap-anchored")).toBe("low");
    expect(routeThinkingTarget("standard-executor")).toBe("medium");
    expect(routeThinkingTarget("repair-react")).toBe("high");
    expect(routeThinkingTarget("deep-think")).toBe("max");
    expect(routeThinkingBoost("low", "deep-think")).toBe("max");
    expect(routeThinkingBoost("max", "deep-think")).toBeUndefined();
    expect(routeThinkingBoost("medium", "bootstrap-anchored")).toBeUndefined();
  });
});
