import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDSCodeTracesDir } from "./home.js";

export const AGENT_TRACE_SCHEMA_VERSION = 1 as const;

export type AgentTraceEventType =
  | "run_start"
  | "agent_start"
  | "turn_start"
  | "turn_end"
  | "model_request"
  | "provider_response"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "compaction"
  | "agent_end"
  | "run_end"
  | "error"
  | "session_shutdown";

export type AgentTraceStatus = "started" | "completed" | "failed" | "cancelled";

export interface AgentTraceUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
}

export interface TraceValueSummary {
  kind: "text" | "json" | "binary" | "unknown";
  bytes: number;
  sha256: string;
}

export interface TraceContentSummary {
  items: number;
  textItems: number;
  imageItems: number;
  bytes: number;
  sha256: string;
}

export interface AgentTraceError {
  code: string;
  message: string;
}

export interface AgentTraceEvent {
  schemaVersion: typeof AGENT_TRACE_SCHEMA_VERSION;
  traceId: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  type: AgentTraceEventType;
  status?: AgentTraceStatus;
  durationMs?: number;
  provider?: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  usage?: AgentTraceUsage;
  error?: AgentTraceError;
  input?: TraceValueSummary;
  output?: TraceValueSummary;
  content?: TraceContentSummary;
  attributes?: Record<string, string | number | boolean>;
}

export type AgentTraceEventInput = Omit<
  AgentTraceEvent,
  "schemaVersion" | "traceId" | "sessionId" | "runId" | "timestamp" | "durationMs"
> & {
  durationMs?: number;
};

export interface AgentRuntimeTraceOptions {
  traceDir?: string;
  enabled?: boolean;
  now?: () => Date;
  createId?: () => string;
}

interface ActiveRun {
  traceId: string;
  runId: string;
  sessionId?: string;
  spanId: string;
  filePath: string;
  startedAt: number;
  closed: boolean;
}

/**
 * Small, local-first event sink for agent runs. Writes are queued so telemetry
 * cannot block the agent loop; callers can await flush at lifecycle boundaries.
 */
export class AgentRuntimeTrace {
  private readonly traceDir: string;
  private readonly enabled: boolean;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private sessionId: string | undefined;
  private activeRun: ActiveRun | undefined;
  private readonly spanStarts = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AgentRuntimeTraceOptions = {}) {
    this.traceDir = path.resolve(options.traceDir ?? getDSCodeTracesDir());
    this.enabled =
      options.enabled ??
      !["0", "false", "off"].includes((process.env.DSCODE_TRACE ?? "1").toLowerCase());
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  setSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  startRun(metadata: {
    sessionId?: string;
    provider?: string;
    model?: string;
  } = {}): string {
    if (this.activeRun && !this.activeRun.closed) this.endRun("cancelled");
    this.spanStarts.clear();
    const traceId = this.createId();
    const runId = this.createId();
    const sessionId = metadata.sessionId ?? this.sessionId;
    const startedAt = this.now().getTime();
    this.activeRun = {
      traceId,
      runId,
      ...(sessionId ? { sessionId } : {}),
      spanId: `run:${runId}`,
      filePath: path.join(this.traceDir, `${traceFileTimestamp(startedAt)}-${traceId}.jsonl`),
      startedAt,
      closed: false,
    };
    this.record({
      type: "run_start",
      spanId: `run:${runId}`,
      status: "started",
      ...(metadata.provider ? { provider: metadata.provider } : {}),
      ...(metadata.model ? { model: metadata.model } : {}),
    });
    return traceId;
  }

  record(event: AgentTraceEventInput): void {
    const run = this.activeRun;
    if (!run || run.closed) return;
    const timestamp = this.now();
    const timestampMs = timestamp.getTime();
    const durationMs =
      event.durationMs ??
      (event.status !== "started" && this.spanStarts.has(event.spanId)
        ? Math.max(0, timestampMs - this.spanStarts.get(event.spanId)!)
        : undefined);
    if (event.status === "started") this.spanStarts.set(event.spanId, timestampMs);
    if (event.status !== "started") this.spanStarts.delete(event.spanId);

    const traceEvent: AgentTraceEvent = {
      schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
      traceId: run.traceId,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      runId: run.runId,
      timestamp: timestamp.toISOString(),
      ...event,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    this.enqueue(traceEvent, run.filePath);
  }

  recordError(
    spanId: string,
    code: string,
    message = "runtime error",
    attributes?: Record<string, string | number | boolean>,
  ): void {
    this.record({
      type: "error",
      spanId,
      status: "failed",
      error: { code, message: sanitizeErrorMessage(message) },
      ...(attributes ? { attributes } : {}),
    });
  }

  endRun(status: Exclude<AgentTraceStatus, "started"> = "completed"): void {
    const run = this.activeRun;
    if (!run || run.closed) return;
    this.record({ type: "run_end", spanId: run.spanId, status });
    run.closed = true;
    this.spanStarts.delete(run.spanId);
  }

  shutdown(reason: "completed" | "cancelled" = "cancelled"): void {
    if (this.activeRun && !this.activeRun.closed) {
      this.record({
        type: "session_shutdown",
        spanId: `shutdown:${this.activeRun.runId}`,
        status: reason === "completed" ? "completed" : "cancelled",
      });
      this.endRun(reason);
    }
  }

  getTracePath(): string | undefined {
    return this.activeRun?.filePath;
  }

  getTraceId(): string | undefined {
    return this.activeRun?.traceId;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueue(event: AgentTraceEvent, filePath: string): void {
    if (!this.enabled) return;
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(this.traceDir, { recursive: true, mode: 0o700 });
        await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(filePath, 0o600).catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

export function summarizeValue(value: unknown): TraceValueSummary {
  if (typeof value === "string") return summarizeBytes("text", value);
  if (isBinaryValue(value)) return summarizeBytes("binary", value);
  const serialized = safeSerialize(value);
  return summarizeBytes(serialized === undefined ? "unknown" : "json", serialized ?? "");
}

export function summarizeContent(content: unknown): TraceContentSummary {
  const items = Array.isArray(content) ? content : [];
  let textItems = 0;
  let imageItems = 0;
  let bytes = 0;
  const digests: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      digests.push(safeSerialize(item) ?? "unknown");
      continue;
    }
    if (item.type === "text" || item.type === "output_text") {
      textItems += 1;
      const text = typeof item.text === "string" ? item.text : "";
      bytes += Buffer.byteLength(text, "utf8");
      digests.push(text);
    } else if (item.type === "image" || item.type === "input_image") {
      imageItems += 1;
      const data = typeof item.data === "string" ? item.data : "";
      bytes += Buffer.byteLength(data, "utf8");
      digests.push(data);
    } else {
      const serialized = safeSerialize(item) ?? "unknown";
      bytes += Buffer.byteLength(serialized, "utf8");
      digests.push(serialized);
    }
  }
  return {
    items: items.length,
    textItems,
    imageItems,
    bytes,
    sha256: digest(digests.join("\n")),
  };
}

export function usageFromPiUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}): AgentTraceUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
    cost: usage.cost.total,
  };
}

export function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "provider_request";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

function summarizeBytes(kind: TraceValueSummary["kind"], value: string | Uint8Array): TraceValueSummary {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  return { kind, bytes, sha256: digest(value) };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? `${nested.toString()}n` : nested,
    );
  } catch {
    return undefined;
  }
}

function isBinaryValue(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(?:sk|key|token|secret)[-_a-z0-9]*\s*[:=]\s*\S+/gi, "<redacted>")
    .slice(0, 160);
}

function traceFileTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}
