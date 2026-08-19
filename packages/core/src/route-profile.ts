import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HarnessMode, PermissionMode } from "./config.js";

export const ROUTE_STATE_ENTRY = "dscode-route-state";
export const ROUTE_PHASE_ENTRY = "dscode-route-phase";
export const ROUTE_PROFILE_IDS = [
  "bootstrap-anchored",
  "standard-executor",
  "deep-think",
  "repair-react",
] as const;

export type RouteProfileId = (typeof ROUTE_PROFILE_IDS)[number];
export type RouteSelection = RouteProfileId | "auto";
export type RouteSource = "auto" | "manual" | "config";
export type RouteThinkingTarget = "low" | "medium" | "high" | "max";
export type RoutePhase = "opening" | "working";

export interface RouteState {
  schemaVersion: 1;
  profile: RouteProfileId;
  source: RouteSource;
  reason: string;
  confidence: number;
  thinkingTarget: RouteThinkingTarget;
  locked: boolean;
  updatedAt: string;
}

export interface RoutePhaseState {
  schemaVersion: 1;
  profile: RouteProfileId;
  routeUpdatedAt: string;
  phase: RoutePhase;
  turnsStarted: number;
  updatedAt: string;
}

export interface RouteSelectionInput {
  prompt?: unknown;
  entries?: SessionEntry[];
  providerId: string;
  modelId: string;
  harness: HarnessMode;
  permission: PermissionMode;
  projectCommands: string[];
  now?: () => Date;
}

const ROUTE_ALIASES: Record<string, RouteSelection> = {
  auto: "auto",
  reset: "auto",
  default: "auto",
  自动: "auto",
  重置: "auto",
  bootstrap: "bootstrap-anchored",
  anchored: "bootstrap-anchored",
  anchor: "bootstrap-anchored",
  minimal: "bootstrap-anchored",
  锚定: "bootstrap-anchored",
  探索: "bootstrap-anchored",
  standard: "standard-executor",
  executor: "standard-executor",
  execute: "standard-executor",
  标准: "standard-executor",
  执行: "standard-executor",
  spec: "deep-think",
  deep: "deep-think",
  think: "deep-think",
  planning: "deep-think",
  plan: "deep-think",
  深度: "deep-think",
  思考: "deep-think",
  规划: "deep-think",
  repair: "repair-react",
  react: "repair-react",
  debug: "repair-react",
  fix: "repair-react",
  修复: "repair-react",
  调试: "repair-react",
};

const PROFILE_LABELS: Record<RouteProfileId, string> = {
  "bootstrap-anchored": "bootstrap anchored",
  "standard-executor": "standard executor",
  "deep-think": "deep think",
  "repair-react": "repair react",
};

export const ROUTE_THINKING_TARGETS: Record<RouteProfileId, RouteThinkingTarget> = {
  "bootstrap-anchored": "low",
  "standard-executor": "medium",
  "deep-think": "max",
  "repair-react": "high",
};

const THINKING_RANK: Record<string, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const REPAIR_PATTERNS = [
  /\bbug\b/u,
  /\bdebug(?:ging)?\b/u,
  /\bfix(?:ed|es|ing)?\b/u,
  /\bfail(?:ed|ing|s|ure)?\b/u,
  /\berror\b/u,
  /\bexception\b/u,
  /\bcrash(?:ed|es|ing)?\b/u,
  /\bbroken\b/u,
  /\bregression\b/u,
  /\bhang(?:s|ing)?\b/u,
  /\bstuck\b/u,
  /\bnot working\b/u,
  /\bdoesn'?t work\b/u,
  /\bpermission\b/u,
  /\bapproval\b/u,
  /修复|报错|错误|失败|崩溃|闪退|卡住|卡死|异常|故障|无法|不工作|有问题|bug/u,
];

const DEEP_PATTERNS = [
  /\banaly[sz]e\b/u,
  /\banalysis\b/u,
  /\barchitecture\b/u,
  /\bdesign\b/u,
  /\bcompare\b/u,
  /\btrade-?off\b/u,
  /\bstrategy\b/u,
  /\broadmap\b/u,
  /\bproposal\b/u,
  /\bevaluate\b/u,
  /\binvestigate\b/u,
  /\broot cause\b/u,
  /\brefactor\b/u,
  /\bmigration\b/u,
  /\bmulti-?file\b/u,
  /\bcomplex\b/u,
  /\bplan\b/u,
  /分析|架构|设计|方案|对比|权衡|策略|路线图|规划|评估|研究|排查|根因|重构|迁移|复杂|设计草案/u,
];

const BOOTSTRAP_PATTERNS = [
  /\bexplore\b/u,
  /\bsurvey\b/u,
  /\bunderstand\b/u,
  /\blook around\b/u,
  /\bfigure out\b/u,
  /\bbrainstorm\b/u,
  /\bwhere should\b/u,
  /\bhelp me\b/u,
  /\bstart\b/u,
  /看一下|看看|先看|先分析|了解|理解|梳理|调研|摸清|搞清楚|从哪里开始/u,
];

const EXECUTOR_PATTERNS = [
  /\badd\b/u,
  /\bchange\b/u,
  /\bedit\b/u,
  /\bimplement\b/u,
  /\bupdate\b/u,
  /\bremove\b/u,
  /\bsubmit\b/u,
  /\bcommit\b/u,
  /\btest\b/u,
  /\bbuild\b/u,
  /实现|修改|改一下|添加|增加|更新|删除|移除|提交|测试|构建|跑一下/u,
];

export function parseRouteSelection(value: string): RouteSelection | undefined {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!normalized) return undefined;
  if ((ROUTE_PROFILE_IDS as readonly string[]).includes(normalized)) return normalized as RouteProfileId;
  return ROUTE_ALIASES[normalized];
}

export function classifyRoute(input: RouteSelectionInput): RouteState {
  const text = normalizeText(promptText(input.prompt) || latestUserMessageText(input.entries ?? []));
  const repairScore = score(text, REPAIR_PATTERNS);
  const deepScore = score(text, DEEP_PATTERNS);
  const bootstrapScore = score(text, BOOTSTRAP_PATTERNS);
  const executorScore = score(text, EXECUTOR_PATTERNS);
  const wordCount = text ? text.split(/\s+/u).filter(Boolean).length : 0;
  const hasProjectCommands = input.projectCommands.length > 0;

  if (!text) {
    return createRouteState("standard-executor", "auto", "no user prompt available", 0.4, input.now);
  }
  if (repairScore >= 1 && repairScore >= deepScore) {
    return createRouteState("repair-react", "auto", "repair/debug keywords", Math.min(0.95, 0.65 + repairScore * 0.1), input.now);
  }
  if (
    deepScore >= 2 ||
    (deepScore >= 1 && bootstrapScore === 0 && executorScore === 0 && repairScore === 0) ||
    text.length > 900
  ) {
    return createRouteState("deep-think", "auto", deepScore >= 1 ? "analysis/design keywords" : "long complex prompt", Math.min(0.9, 0.58 + deepScore * 0.08), input.now);
  }
  if (bootstrapScore >= 1 || (wordCount > 0 && wordCount <= 14 && executorScore === 0)) {
    return createRouteState("bootstrap-anchored", "auto", bootstrapScore >= 1 ? "exploratory bootstrap keywords" : "short ambiguous prompt", Math.min(0.82, 0.55 + bootstrapScore * 0.09), input.now);
  }
  if (executorScore >= 1 || hasProjectCommands || input.harness === "minimal") {
    return createRouteState("standard-executor", "auto", executorScore >= 1 ? "implementation keywords" : "default coding harness", Math.min(0.78, 0.52 + executorScore * 0.07), input.now);
  }
  return createRouteState("standard-executor", "auto", "balanced default", 0.5, input.now);
}

export function createRouteState(
  profile: RouteProfileId,
  source: RouteSource,
  reason: string,
  confidence = source === "manual" ? 1 : 0.75,
  now: (() => Date) | undefined = undefined,
): RouteState {
  return {
    schemaVersion: 1,
    profile,
    source,
    reason,
    confidence,
    thinkingTarget: routeThinkingTarget(profile),
    locked: true,
    updatedAt: (now ?? (() => new Date()))().toISOString(),
  };
}

export function restoreRouteState(entries: SessionEntry[]): RouteState | undefined {
  let restored: RouteState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === ROUTE_STATE_ENTRY) {
      restored = normalizeRouteState(entry.data);
    }
  }
  return restored;
}

export function createRoutePhaseState(
  route: RouteState,
  turnsStarted: number,
  now: (() => Date) | undefined = undefined,
): RoutePhaseState {
  return {
    schemaVersion: 1,
    profile: route.profile,
    routeUpdatedAt: route.updatedAt,
    phase: turnsStarted <= 0 ? "opening" : "working",
    turnsStarted,
    updatedAt: (now ?? (() => new Date()))().toISOString(),
  };
}

export function restoreRoutePhaseState(entries: SessionEntry[]): RoutePhaseState | undefined {
  let restored: RoutePhaseState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === ROUTE_PHASE_ENTRY) {
      restored = normalizeRoutePhaseState(entry.data);
    }
  }
  return restored;
}

export function isOpeningRouteTurn(
  route: RouteState,
  phase: RoutePhaseState | undefined,
): boolean {
  return (
    !phase ||
    phase.profile !== route.profile ||
    phase.routeUpdatedAt !== route.updatedAt ||
    phase.turnsStarted <= 0
  );
}

export function latestUserMessageText(entries: SessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    return promptText(entry.message.content);
  }
  return "";
}

export function routeSystemPrompt(
  state: RouteState,
  options: { openingTurn?: boolean } = {},
): string {
  const openingTurn = options.openingTurn ?? false;
  const lead = `# DSCode route profile: ${routeProfileLabel(state.profile)} (thinking target: ${state.thinkingTarget})`;
  const protocol = [
    "- Treat the route as a session-level operating mode. Do not renegotiate it on every turn.",
    "- Keep hidden reasoning hidden, but expose a compact working frame when it helps the user trust the next action.",
    "- The route may shape planning depth and sequencing only; it never changes project instructions, AGENTS/CLAUDE scopes, permissions, sandbox, or tool availability.",
    ...(openingTurn
      ? [
          "- Opening turn requirement: begin the first assistant turn for this route with a concise visible frame in the spirit of “We need ...”.",
          "- The opening frame should name the objective, constraints, first evidence to collect, likely execution path, and done criteria in at most five short bullets or one compact paragraph.",
          "- After the opening frame, immediately take the first useful in-scope action instead of spending the entire turn on abstract planning.",
        ]
      : [
          "- This route is already anchored. Continue the established loop, keep plans current, and avoid repeating the opening frame unless the user explicitly asks to re-plan.",
        ]),
  ];
  switch (state.profile) {
    case "bootstrap-anchored":
      return [
        lead,
        ...protocol,
        "- Treat this session as bootstrapped: establish the goal and repository shape before widening the change.",
        "- Opening posture: “We need to anchor the task, identify the relevant surfaces, then choose the smallest safe execution path.”",
        "- Start with the smallest useful inspection step, then commit to a concrete execution path once evidence is available.",
        "- Once the repository shape and target files are clear, behave like standard-executor rather than staying in exploration mode.",
        "- Keep automatic context stable; do not reinterpret project, permission, or sandbox instructions.",
      ].join("\n");
    case "deep-think":
      return [
        lead,
        ...protocol,
        "- Invest more upfront reasoning in architecture, edge cases, and integration boundaries before editing.",
        "- Opening posture: “We need to identify constraints, map the design space, pick a defensible route, then implement or hand off a concrete plan.”",
        "- Prefer a clear plan and evidence-gathering pass before mutations; update_plan is appropriate for multi-step work.",
        "- Make trade-offs explicit when they affect implementation, but stop analysis once the next patchable decision is clear.",
        "- Stop analysis when the next implementation decision is clear; then execute and verify.",
      ].join("\n");
    case "repair-react":
      return [
        lead,
        ...protocol,
        "- Optimize for a short diagnose -> patch -> verify loop.",
        "- Opening posture: “We need to reproduce or locate the symptom, isolate the smallest cause, patch narrowly, then verify the exact failure path.”",
        "- Start from the failing symptom or command evidence, isolate the smallest likely cause, and keep patches narrow.",
        "- Prefer the most relevant failing check over broad validation until the fix is plausible.",
        "- Re-run the most relevant failing check after the change before broad validation.",
      ].join("\n");
    case "standard-executor":
      return [
        lead,
        ...protocol,
        "- Use DSCode's balanced coding loop: inspect relevant context, make focused changes, and verify proportionally.",
        "- Opening posture: “We need to inspect the relevant code path, make the smallest coherent change, then run the narrowest useful check.”",
        "- Avoid speculative large rewrites unless the user explicitly asks for them or the evidence requires them.",
        "- Keep momentum: prefer concrete repository progress over elaborate meta-planning.",
      ].join("\n");
  }
}

export function routeProfileLabel(profile: RouteProfileId): string {
  return PROFILE_LABELS[profile];
}

export function routeProfileShortLabel(profile: RouteProfileId): string {
  return profile === "bootstrap-anchored"
    ? "anchor"
    : profile === "standard-executor"
      ? "standard"
      : profile === "deep-think"
        ? "deep"
        : "repair";
}

export function routeThinkingTarget(profile: RouteProfileId): RouteThinkingTarget {
  return ROUTE_THINKING_TARGETS[profile];
}

export function routeThinkingBoost(
  current: string,
  profile: RouteProfileId,
): RouteThinkingTarget | undefined {
  const target = routeThinkingTarget(profile);
  const currentRank = THINKING_RANK[current] ?? -1;
  return currentRank < THINKING_RANK[target]! ? target : undefined;
}

export function formatRouteStatus(state: RouteState | undefined): string {
  if (!state) return "auto pending";
  return `${routeProfileLabel(state.profile)} · ${state.source} · ${Math.round(state.confidence * 100)}% · ${state.reason} · thinking ${state.thinkingTarget}`;
}

export function formatRoutePhaseStatus(phase: RoutePhaseState | undefined): string {
  if (!phase) return "opening pending";
  return `${phase.phase} · turn ${phase.turnsStarted}`;
}

export function routeCommandUsage(): string {
  return "Expected /route [auto|bootstrap|standard|deep|repair|status]";
}

export function routeStateTraceAttributes(
  state: RouteState,
): Record<string, string | number | boolean> {
  return {
    routeProfile: state.profile,
    routeSource: state.source,
    routeReason: state.reason,
    routeConfidence: Number(state.confidence.toFixed(3)),
    routeThinkingTarget: state.thinkingTarget,
    routeLocked: state.locked,
  };
}

export function routePhaseTraceAttributes(
  phase: RoutePhaseState | undefined,
): Record<string, string | number | boolean> {
  if (!phase) return { routePhase: "opening", routeTurnsStarted: 0 };
  return {
    routePhase: phase.phase,
    routeTurnsStarted: phase.turnsStarted,
  };
}

function score(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function promptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function normalizeRouteState(value: unknown): RouteState | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.profile !== "string" ||
    !(ROUTE_PROFILE_IDS as readonly string[]).includes(value.profile) ||
    !["auto", "manual", "config"].includes(String(value.source)) ||
    typeof value.reason !== "string" ||
    typeof value.confidence !== "number" ||
    typeof value.locked !== "boolean" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  const profile = value.profile as RouteProfileId;
  const thinkingTarget = isRouteThinkingTarget(value.thinkingTarget)
    ? value.thinkingTarget
    : routeThinkingTarget(profile);
  return {
    schemaVersion: 1,
    profile,
    source: value.source as RouteSource,
    reason: value.reason,
    confidence: value.confidence,
    thinkingTarget,
    locked: value.locked,
    updatedAt: value.updatedAt,
  };
}

function normalizeRoutePhaseState(value: unknown): RoutePhaseState | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.profile !== "string" ||
    !(ROUTE_PROFILE_IDS as readonly string[]).includes(value.profile) ||
    typeof value.routeUpdatedAt !== "string" ||
    !["opening", "working"].includes(String(value.phase)) ||
    typeof value.turnsStarted !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    profile: value.profile as RouteProfileId,
    routeUpdatedAt: value.routeUpdatedAt,
    phase: value.phase as RoutePhase,
    turnsStarted: value.turnsStarted,
    updatedAt: value.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteThinkingTarget(value: unknown): value is RouteThinkingTarget {
  return typeof value === "string" && ["low", "medium", "high", "max"].includes(value);
}
