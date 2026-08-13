import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import path from "node:path";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyLoggerOptions,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  PersistedSessionAlreadyExistsError,
  PersistedSessionNotFoundError,
  createAgentSessionHost,
  listPersistedSessions,
  type PersistedSessionSummary,
} from "./agent-session-host.js";
import { toHttpSessionMessages, type AgentMessage } from "./session-messages.js";
import {
  HttpUiResponseError,
  type HttpUiBroker,
  type HttpUiBrokerEvent,
  type HttpUiBrokerListener,
  type HttpUiEvent,
  type HttpUiRequest,
  type HttpUiResponse,
} from "./ui-broker.js";

export interface HttpAdapterServerHost {
  readonly session: {
    readonly messages: readonly AgentMessage[];
    getLastAssistantText(): string | undefined;
  };
  readonly uiBroker: Pick<HttpUiBroker, "respond">;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  prunePersistedSession?(): boolean;
  subscribe(listener: HttpUiBrokerListener): () => void;
  dispose(): Promise<void>;
}

export interface HttpAdapterHostFactoryOptions {
  cwd: string;
  runtimeArgs?: readonly string[];
  maxSessionFileBytes?: number;
  session:
    | { type: "persistent"; id: string }
    | { type: "resume"; id: string };
}

export type HttpAdapterHostFactory = (
  options: HttpAdapterHostFactoryOptions,
) => Promise<HttpAdapterServerHost>;

export type PersistedSessionLister = (cwd: string) => Promise<PersistedSessionSummary[]>;

export interface CreateHttpAdapterServerOptions {
  workspaces: Readonly<Record<string, string>>;
  runtimeArgs?: readonly string[];
  maxSessionFileBytes?: number;
  createHost?: HttpAdapterHostFactory;
  listPersistedSessions?: PersistedSessionLister;
  logger?: boolean | FastifyLoggerOptions;
}

export type HttpSessionStatus = "idle" | "running" | "aborting";

export interface HttpSessionDescriptor {
  id: string;
  workspaceId: string;
  persisted: true;
  status: HttpSessionStatus;
}

export type HttpSessionListEntry =
  | { workspaceId: string; active: true; session: HttpSessionDescriptor }
  | { workspaceId: string; active: false; session: PersistedSessionSummary | null };

export type HttpTurnStatus =
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted";

export type HttpAdapterEvent =
  | {
      type: "turn";
      turnId: string;
      status: HttpTurnStatus;
      output?: string | null;
      error?: string;
      message?: string;
      clientId?: string;
    }
  | { type: "assistant_text_delta"; turnId: string | null; delta: string }
  | { type: "thinking_start"; turnId: string | null }
  | { type: "thinking_end"; turnId: string | null }
  | { type: "compaction_start"; turnId: string | null }
  | { type: "compaction_end"; turnId: string | null }
  | {
      type: "tool";
      turnId: string | null;
      phase: "started";
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool";
      turnId: string | null;
      phase: "updated";
      toolCallId: string;
      name: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool";
      turnId: string | null;
      phase: "completed";
      toolCallId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "ui_request"; turnId: string | null; request: HttpUiRequest }
  | { type: "ui_event"; turnId: string | null; event: HttpUiEvent }
  | {
      type: "extension_error";
      turnId: string | null;
      error: { extensionPath: string; event: string; message: string };
    };

interface CreateSessionBody {
  workspaceId: string;
  resumeSessionId?: string;
}

interface SessionParams {
  sessionId: string;
}

interface TurnBody {
  message: string;
  clientId?: string;
}

interface TurnParams extends SessionParams {
  turnId: string;
}

interface UiResponseParams extends SessionParams {
  requestId: string;
}

type UiResponseBody =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

interface AbortAttempt {
  ok: boolean;
  error?: unknown;
}

interface ActiveTurn {
  id: string;
  abortAttempt?: Promise<AbortAttempt>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const createSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspaceId"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    resumeSessionId: { type: "string", minLength: 1 },
  },
} as const;

const turnBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 },
    clientId: { type: "string", minLength: 1 },
  },
} as const;

const uiResponseBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["confirmed"],
      properties: { confirmed: { type: "boolean" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["cancelled"],
      properties: { cancelled: { const: true } },
    },
  ],
} as const;

const KEEPALIVE_INTERVAL_MS = 30_000;

class SessionController {
  private readonly eventStreams = new Map<ServerResponse, () => void>();
  private activeTurn: ActiveTurn | undefined;
  private latestTurnEvent:
    | Extract<HttpAdapterEvent, { type: "turn" }>
    | undefined;
  private disposePromise: Promise<void> | undefined;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    private readonly host: HttpAdapterServerHost,
  ) {}

  get descriptor(): HttpSessionDescriptor {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      persisted: true,
      status: this.activeTurn
        ? this.activeTurn.abortAttempt
          ? "aborting"
          : "running"
        : "idle",
    };
  }

  get messages(): readonly AgentMessage[] {
    return this.host.session.messages;
  }

  private closeEventStream(response: ServerResponse): void {
    this.eventStreams.get(response)?.();
    this.eventStreams.delete(response);
  }

  private writeEvent(response: ServerResponse, event: HttpAdapterEvent): void {
    if (response.destroyed || response.writableEnded) {
      this.closeEventStream(response);
      return;
    }
    try {
      const writable = response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      if (!writable) {
        this.closeEventStream(response);
        response.end();
      }
    } catch {
      this.closeEventStream(response);
      response.destroy();
    }
  }

  private publish(event: HttpAdapterEvent): void {
    for (const response of this.eventStreams.keys()) this.writeEvent(response, event);
  }

  private publishTurn(
    turnId: string,
    status: HttpTurnStatus,
    extras: {
      output?: string | null;
      error?: string;
      message?: string;
      clientId?: string;
    } = {},
  ): void {
    const event: Extract<HttpAdapterEvent, { type: "turn" }> = {
      type: "turn",
      turnId,
      status,
      ...(extras.output !== undefined ? { output: extras.output } : {}),
      ...(extras.error !== undefined ? { error: extras.error } : {}),
      ...(extras.message !== undefined ? { message: extras.message } : {}),
      ...(extras.clientId !== undefined ? { clientId: extras.clientId } : {}),
    };
    this.latestTurnEvent = event;
    this.publish(event);
  }

  private translateBrokerEvent(
    brokerEvent: HttpUiBrokerEvent,
  ): HttpAdapterEvent | undefined {
    const turnId = this.activeTurn?.id ?? null;
    if (brokerEvent.type === "ui_request") {
      return { type: "ui_request", turnId, request: brokerEvent.request };
    }
    if (brokerEvent.type === "ui_event") {
      return { type: "ui_event", turnId, event: brokerEvent.event };
    }
    if (brokerEvent.type === "extension_error") {
      return {
        type: "extension_error",
        turnId,
        error: {
          extensionPath: brokerEvent.error.extensionPath,
          event: brokerEvent.error.event,
          message: brokerEvent.error.error,
        },
      };
    }

    const event = brokerEvent.event;
    if (event.type === "message_update") {
      const messageEvent = event.assistantMessageEvent;
      if (messageEvent.type === "text_delta") {
        return {
          type: "assistant_text_delta",
          turnId,
          delta: messageEvent.delta,
        };
      }
      if (messageEvent.type === "thinking_start") {
        return { type: "thinking_start", turnId };
      }
      if (messageEvent.type === "thinking_end") {
        return { type: "thinking_end", turnId };
      }
      return undefined;
    }
    if (event.type === "compaction_start") {
      return { type: "compaction_start", turnId };
    }
    if (event.type === "compaction_end") {
      return { type: "compaction_end", turnId };
    }
    if (event.type === "tool_execution_start") {
      return {
        type: "tool",
        turnId,
        phase: "started",
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: event.args,
      };
    }
    if (event.type === "tool_execution_update") {
      return {
        type: "tool",
        turnId,
        phase: "updated",
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      };
    }
    if (event.type === "tool_execution_end") {
      return {
        type: "tool",
        turnId,
        phase: "completed",
        toolCallId: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    }
    return undefined;
  }

  openEventStream(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();

    if (this.latestTurnEvent) this.writeEvent(response, this.latestTurnEvent);
    const unsubscribe = this.host.subscribe((brokerEvent) => {
      const event = this.translateBrokerEvent(brokerEvent);
      if (event) this.writeEvent(response, event);
    });
    const keepalive = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(": keepalive\n\n");
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.eventStreams.set(response, () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    response.once("close", () => this.closeEventStream(response));
    request.raw.once("error", () => this.closeEventStream(response));
    return reply;
  }

  startTurn(
    message: string,
    clientId: string | undefined,
    log: FastifyBaseLogger,
  ): { id: string; status: "running" } | undefined {
    if (this.activeTurn) return undefined;

    const turn: ActiveTurn = { id: randomUUID() };
    this.activeTurn = turn;
    // The running event carries the submission so every attached client can render
    // the user line; the submitter recognizes itself via clientId.
    this.publishTurn(turn.id, "running", {
      message,
      ...(clientId !== undefined ? { clientId } : {}),
    });

    void (async () => {
      let failed = false;
      let failure: unknown;
      try {
        await this.host.prompt(message);
        await this.host.waitForIdle();
      } catch (error) {
        failed = true;
        failure = error;
      }

      const abortResult = turn.abortAttempt ? await turn.abortAttempt : undefined;
      if (abortResult?.ok) {
        this.publishTurn(turn.id, "aborted");
      } else if (failed) {
        log.error({ err: failure, turnId: turn.id }, "Agent turn failed");
        this.publishTurn(turn.id, "failed", { error: failureMessage(failure) });
      } else {
        try {
          this.publishTurn(turn.id, "completed", {
            output: this.host.session.getLastAssistantText() ?? null,
          });
        } catch (error) {
          log.error({ err: error, turnId: turn.id }, "Agent turn failed");
          this.publishTurn(turn.id, "failed", { error: failureMessage(error) });
        }
      }
      // Prune before releasing activeTurn so no new turn can append to the file
      // while it is being rewritten.
      try {
        this.host.prunePersistedSession?.();
      } catch (error) {
        log.error({ err: error, turnId: turn.id }, "Session file pruning failed");
      }
      if (this.activeTurn === turn) this.activeTurn = undefined;
    })();

    return { id: turn.id, status: "running" };
  }

  respond(response: HttpUiResponse): void {
    this.host.uiBroker.respond(response);
  }

  async abortTurn(
    turnId: string,
    log: FastifyBaseLogger,
  ): Promise<"not_found" | "aborting" | "failed"> {
    const turn = this.activeTurn;
    if (!turn || turn.id !== turnId) return "not_found";

    if (!turn.abortAttempt) {
      this.publishTurn(turn.id, "aborting");
      turn.abortAttempt = this.host.abort().then<AbortAttempt, AbortAttempt>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
    }

    const attempt = turn.abortAttempt;
    const result = await attempt;
    if (result.ok) return "aborting";

    log.error({ err: result.error, turnId: turn.id }, "Agent turn abort failed");
    if (this.activeTurn === turn && turn.abortAttempt === attempt) {
      delete turn.abortAttempt;
      // No extras: re-sending the submission would make clients re-render it.
      this.publishTurn(turn.id, "running");
    }
    return "failed";
  }

  closeEventStreams(): void {
    for (const response of this.eventStreams.keys()) {
      this.closeEventStream(response);
      response.end();
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    const attempt = (async () => {
      this.closeEventStreams();
      try {
        await this.host.abort();
      } finally {
        await this.host.dispose();
      }
    })();
    this.disposePromise = attempt;
    void attempt.catch(() => {
      if (this.disposePromise === attempt) this.disposePromise = undefined;
    });
    return attempt;
  }
}

export function createHttpAdapterServer(
  options: CreateHttpAdapterServerOptions,
): FastifyInstance {
  const server = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  const workspaces = new Map<string, string>();
  for (const [id, cwd] of Object.entries(options.workspaces)) {
    if (id.trim().length === 0) throw new Error("Workspace ID must not be blank");
    if (cwd.trim().length === 0) throw new Error(`Workspace path is blank: ${id}`);
    workspaces.set(id, path.resolve(cwd));
  }

  const createHost: HttpAdapterHostFactory =
    options.createHost ??
    ((hostOptions) => createAgentSessionHost(hostOptions));
  const listSessions: PersistedSessionLister =
    options.listPersistedSessions ?? listPersistedSessions;
  const sessions = new Map<string, SessionController>();
  const disposingSessions = new Map<string, SessionController>();
  const activatingSessions = new Set<string>();
  const activatingWorkspaces = new Set<string>();

  const getSession = (sessionId: string): SessionController | undefined =>
    sessions.get(sessionId);

  server.get("/health", async () => ({ status: "ok" }));

  server.get("/v1/sessions", async (request, reply) => {
    const entries: HttpSessionListEntry[] = [];
    for (const [workspaceId, cwd] of workspaces) {
      const active = [...sessions.values(), ...disposingSessions.values()].find(
        (controller) => controller.workspaceId === workspaceId,
      );
      if (active) {
        entries.push({ workspaceId, active: true, session: active.descriptor });
        continue;
      }
      let summaries: PersistedSessionSummary[];
      try {
        summaries = await listSessions(cwd);
      } catch (error) {
        request.log.error(
          { err: error, workspaceId },
          "Persisted session listing failed",
        );
        return reply.code(500).send({ error: "session_list_failed" });
      }
      entries.push({ workspaceId, active: false, session: summaries[0] ?? null });
    }
    return { sessions: entries };
  });

  server.post<{ Body: CreateSessionBody }>(
    "/v1/sessions",
    {
      schema: { body: createSessionBodySchema },
      errorHandler(error, _request, reply) {
        if (error.validation) {
          return reply.code(400).send({ error: "invalid_session_request" });
        }
        throw error;
      },
    },
    async (request, reply) => {
      const { workspaceId, resumeSessionId } = request.body;
      if (
        workspaceId.trim().length === 0 ||
        resumeSessionId?.trim().length === 0
      ) {
        return reply.code(400).send({ error: "invalid_session_request" });
      }

      const cwd = workspaces.get(workspaceId);
      if (!cwd) return reply.code(404).send({ error: "workspace_not_found" });

      const resumed = resumeSessionId !== undefined;
      const sessionId = resumeSessionId ?? randomUUID();
      if (
        sessions.has(sessionId) ||
        disposingSessions.has(sessionId) ||
        activatingSessions.has(sessionId)
      ) {
        return reply.code(409).send({ error: "session_already_active" });
      }

      const workspaceOccupied =
        activatingWorkspaces.has(workspaceId) ||
        [...sessions.values(), ...disposingSessions.values()].some(
          (controller) => controller.workspaceId === workspaceId,
        );
      if (workspaceOccupied) {
        return reply.code(409).send({ error: "workspace_session_active" });
      }

      activatingSessions.add(sessionId);
      activatingWorkspaces.add(workspaceId);
      try {
        const session: HttpAdapterHostFactoryOptions["session"] = resumed
          ? { type: "resume", id: sessionId }
          : { type: "persistent", id: sessionId };
        const host = await createHost({
          cwd,
          session,
          ...(options.runtimeArgs !== undefined
            ? { runtimeArgs: options.runtimeArgs }
            : {}),
          ...(options.maxSessionFileBytes !== undefined
            ? { maxSessionFileBytes: options.maxSessionFileBytes }
            : {}),
        });
        const controller = new SessionController(sessionId, workspaceId, host);
        sessions.set(sessionId, controller);
        return reply.code(201).send({
          ...controller.descriptor,
          resumed,
        });
      } catch (error) {
        if (error instanceof PersistedSessionAlreadyExistsError) {
          return reply.code(409).send({ error: "session_already_exists" });
        }
        if (error instanceof PersistedSessionNotFoundError) {
          return reply
            .code(404)
            .send({ error: "persistent_session_not_found" });
        }
        request.log.error(
          { err: error, sessionId, workspaceId },
          "Agent session creation failed",
        );
        return reply.code(500).send({ error: "session_creation_failed" });
      } finally {
        activatingSessions.delete(sessionId);
        activatingWorkspaces.delete(workspaceId);
      }
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return controller.descriptor;
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return { messages: toHttpSessionMessages(controller.messages) };
    },
  );

  server.delete<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const controller =
        getSession(request.params.sessionId) ??
        disposingSessions.get(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (sessions.delete(controller.id)) {
        disposingSessions.set(controller.id, controller);
      }
      try {
        await controller.dispose();
        disposingSessions.delete(controller.id);
        return reply.code(204).send();
      } catch (error) {
        request.log.error(
          { err: error, sessionId: controller.id },
          "Agent session disposal failed",
        );
        return reply.code(500).send({ error: "session_disposal_failed" });
      }
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return controller.openEventStream(request, reply);
    },
  );

  server.post<{ Params: SessionParams; Body: TurnBody }>(
    "/v1/sessions/:sessionId/turns",
    { schema: { body: turnBodySchema } },
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (request.body.message.trim().length === 0) {
        return reply.code(400).send({ error: "invalid_message" });
      }

      const turn = controller.startTurn(
        request.body.message,
        request.body.clientId,
        request.log,
      );
      if (!turn) return reply.code(409).send({ error: "turn_in_progress" });
      return reply.code(202).send(turn);
    },
  );

  server.post<{ Params: UiResponseParams; Body: UiResponseBody }>(
    "/v1/sessions/:sessionId/ui-requests/:requestId/responses",
    {
      schema: { body: uiResponseBodySchema },
      errorHandler(error, _request, reply) {
        if (error.validation) {
          return reply.code(400).send({ error: "invalid_ui_response" });
        }
        throw error;
      },
    },
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const response = {
        requestId: request.params.requestId,
        ...request.body,
      } as HttpUiResponse;
      try {
        controller.respond(response);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof HttpUiResponseError) {
          const code = error.code === "not_found" ? 404 : 400;
          const bodyError =
            error.code === "not_found"
              ? "ui_request_not_found"
              : "invalid_ui_response";
          return reply.code(code).send({ error: bodyError });
        }
        request.log.error({ err: error }, "UI response failed");
        return reply.code(500).send({ error: "ui_response_failed" });
      }
    },
  );

  server.post<{ Params: TurnParams }>(
    "/v1/sessions/:sessionId/turns/:turnId/abort",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const result = await controller.abortTurn(request.params.turnId, request.log);
      if (result === "not_found") {
        return reply.code(404).send({ error: "turn_not_found" });
      }
      if (result === "failed") {
        return reply.code(500).send({ error: "turn_abort_failed" });
      }
      return reply
        .code(202)
        .send({ id: request.params.turnId, status: "aborting" });
    },
  );

  server.addHook("preClose", async () => {
    for (const controller of [
      ...sessions.values(),
      ...disposingSessions.values(),
    ]) {
      controller.closeEventStreams();
    }
  });

  server.addHook("onClose", async () => {
    const controllers = new Set([
      ...sessions.values(),
      ...disposingSessions.values(),
    ]);
    sessions.clear();
    disposingSessions.clear();
    const results = await Promise.allSettled(
      [...controllers].map((controller) => controller.dispose()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        server.log.error({ err: result.reason }, "Agent session disposal failed");
      }
    }
  });

  return server;
}
