import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type TextContent,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type { AgentTraceStatus } from "./observability.js";

export const AGENT_FIXTURE_SCHEMA_VERSION = 1 as const;
export const AGENT_FIXTURE_KIND = "dscode-agent-fixture" as const;

export type FixtureContentBlock = TextContent | ThinkingContent | ToolCall;
export type FixtureStopReason = Exclude<StopReason, "pending">;

export interface FixtureUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Usage["cost"];
}

export interface AgentFixtureResponse {
  content: FixtureContentBlock[];
  stopReason: FixtureStopReason;
  usage?: FixtureUsage;
  responseId?: string;
  errorMessage?: string;
  delayMs?: number;
}

export interface AgentFixtureEvaluation {
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxTotalTokens?: number;
  maxCost?: number;
  requireSuccessfulRun?: boolean;
  failOnErrors?: boolean;
}

export interface AgentFixtureAssertions {
  finalStatus?: AgentTraceStatus;
  toolNames?: string[];
  modelResponses?: number;
}

export interface AgentFixture {
  schemaVersion: typeof AGENT_FIXTURE_SCHEMA_VERSION;
  kind: typeof AGENT_FIXTURE_KIND;
  provider: string;
  model: string;
  responses: AgentFixtureResponse[];
  evaluation?: AgentFixtureEvaluation;
  assertions?: AgentFixtureAssertions;
}

export class AgentFixtureRecorder {
  private readonly responses: AgentFixtureResponse[] = [];
  private finished = false;

  constructor(
    private readonly filePath: string,
    private readonly provider: string,
    private readonly model: string,
  ) {}

  record(message: AssistantMessage): void {
    if (this.finished || message.role !== "assistant") return;
    this.responses.push({
      content: message.content.map(cloneFixtureContent),
      stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
      usage: cloneUsage(message.usage),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    });
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await writeAgentFixture(this.filePath, {
      schemaVersion: AGENT_FIXTURE_SCHEMA_VERSION,
      kind: AGENT_FIXTURE_KIND,
      provider: this.provider,
      model: this.model,
      responses: this.responses,
    });
  }
}

export class AgentFixtureReplay {
  private nextResponse = 0;
  private calls = 0;

  constructor(private readonly fixture: AgentFixture) {}

  stream(
    model: Model<Api>,
    _context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const response = this.fixture.responses[this.nextResponse++];
    this.calls += 1;
    void this.resolve(stream, model, response, options?.signal);
    return stream;
  }

  consumedResponses(): number {
    return this.nextResponse;
  }

  callCount(): number {
    return this.calls;
  }

  pendingResponses(): number {
    return Math.max(0, this.fixture.responses.length - this.nextResponse);
  }

  private async resolve(
    stream: AssistantMessageEventStream,
    model: Model<Api>,
    response: AgentFixtureResponse | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      if (response?.delayMs) await delay(response.delayMs, signal);
      const message = response
        ? messageFromFixture(response, model)
        : errorMessage(model, "Fixture has no response for this model request");
      if (signal?.aborted) {
        const aborted = { ...message, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
        return;
      }
      const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
      stream.push({ type: "start", partial });
      if (message.stopReason === "pending") {
        const error = { ...message, stopReason: "error" as const };
        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
        return;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
        stream.end(message);
        return;
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    } catch (error) {
      const message = errorMessage(model, error instanceof Error ? error.message : String(error));
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
  }
}

export function readAgentFixtureFileSync(filePath: string): AgentFixture {
  return parseAgentFixture(fs.readFileSync(filePath, "utf8"), filePath);
}

export async function readAgentFixtureFile(filePath: string): Promise<AgentFixture> {
  return parseAgentFixture(await fsp.readFile(filePath, "utf8"), filePath);
}

export async function writeAgentFixture(filePath: string, fixture: AgentFixture): Promise<void> {
  await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsp.chmod(filePath, 0o600).catch(() => undefined);
}

function parseAgentFixture(raw: string, source: string): AgentFixture {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid agent fixture JSON: ${source}`);
  }
  if (!isRecord(value)) throw new Error(`Invalid agent fixture envelope: ${source}`);
  if (
    value.schemaVersion !== AGENT_FIXTURE_SCHEMA_VERSION ||
    value.kind !== AGENT_FIXTURE_KIND ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    !Array.isArray(value.responses) ||
    value.responses.length === 0
  ) {
    throw new Error(`Invalid agent fixture schema: ${source}`);
  }
  const responses = value.responses.map((response, index) => parseResponse(response, `${source} response ${index + 1}`));
  return {
    schemaVersion: AGENT_FIXTURE_SCHEMA_VERSION,
    kind: AGENT_FIXTURE_KIND,
    provider: value.provider,
    model: value.model,
    responses,
    ...(isRecord(value.evaluation) ? { evaluation: parseEvaluation(value.evaluation) } : {}),
    ...(isRecord(value.assertions) ? { assertions: parseAssertions(value.assertions) } : {}),
  };
}

function parseResponse(value: unknown, source: string): AgentFixtureResponse {
  if (!isRecord(value) || !Array.isArray(value.content) || typeof value.stopReason !== "string") {
    throw new Error(`Invalid agent fixture response: ${source}`);
  }
  if (!["stop", "length", "toolUse", "error", "aborted"].includes(value.stopReason)) {
    throw new Error(`Invalid fixture stopReason: ${source}`);
  }
  const content = value.content.map((block, index) => parseContent(block, `${source} content ${index + 1}`));
  const response: AgentFixtureResponse = {
    content,
    stopReason: value.stopReason as FixtureStopReason,
    ...(typeof value.responseId === "string" ? { responseId: value.responseId } : {}),
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    ...(typeof value.delayMs === "number" && value.delayMs >= 0 ? { delayMs: value.delayMs } : {}),
  };
  if (isRecord(value.usage)) response.usage = parseUsage(value.usage, source);
  return response;
}

function parseContent(value: unknown, source: string): FixtureContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid fixture content: ${source}`);
  if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
  if (value.type === "thinking" && typeof value.thinking === "string") {
    return { type: "thinking", thinking: value.thinking };
  }
  if (
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  ) {
    return { type: "toolCall", id: value.id, name: value.name, arguments: value.arguments };
  }
  throw new Error(`Invalid fixture content: ${source}`);
}

function parseUsage(value: Record<string, unknown>, source: string): FixtureUsage {
  const cost = isRecord(value.cost) ? value.cost : undefined;
  const numbers = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!numbers.every((key) => typeof value[key] === "number") || !cost) {
    throw new Error(`Invalid fixture usage: ${source}`);
  }
  const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (!costKeys.every((key) => typeof cost[key] === "number")) {
    throw new Error(`Invalid fixture cost: ${source}`);
  }
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    totalTokens: value.totalTokens as number,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
      total: cost.total as number,
    },
  };
}

function parseEvaluation(value: Record<string, unknown>): AgentFixtureEvaluation {
  const result: AgentFixtureEvaluation = {};
  for (const key of ["maxToolCalls", "maxDurationMs", "maxTotalTokens", "maxCost"] as const) {
    if (typeof value[key] === "number" && value[key] >= 0) result[key] = value[key];
  }
  if (typeof value.requireSuccessfulRun === "boolean") result.requireSuccessfulRun = value.requireSuccessfulRun;
  if (typeof value.failOnErrors === "boolean") result.failOnErrors = value.failOnErrors;
  return result;
}

function parseAssertions(value: Record<string, unknown>): AgentFixtureAssertions {
  const result: AgentFixtureAssertions = {};
  if (value.finalStatus === "completed" || value.finalStatus === "failed" || value.finalStatus === "cancelled") {
    result.finalStatus = value.finalStatus;
  }
  if (Array.isArray(value.toolNames) && value.toolNames.every((name) => typeof name === "string")) {
    result.toolNames = value.toolNames as string[];
  }
  if (typeof value.modelResponses === "number" && value.modelResponses >= 0) result.modelResponses = value.modelResponses;
  return result;
}

function messageFromFixture(response: AgentFixtureResponse, model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: response.content.map(cloneFixtureContent),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: response.usage ?? emptyUsage(),
    stopReason: response.stopReason,
    ...(response.responseId ? { responseId: response.responseId } : {}),
    ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function cloneUsage(usage: Usage): FixtureUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function cloneFixtureContent(block: FixtureContentBlock): FixtureContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
  return { type: "toolCall", id: block.id, name: block.name, arguments: structuredClone(block.arguments) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    }, { once: true });
  });
}
