import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistedSessionNotFoundError } from "../src/agent-session-host.js";
import {
  createHttpAdapterServer,
  type HttpAdapterEvent,
  type HttpAdapterHostFactoryOptions,
  type HttpAdapterServerHost,
  type PersistedSessionLister,
} from "../src/http-server.js";
import type { AgentMessage } from "../src/session-messages.js";
import {
  createHttpUiBroker,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "../src/ui-broker.js";

interface FakeHost extends HttpAdapterServerHost {
  calls: string[];
  abortCount: number;
  disposeCount: number;
  subscribeCount: number;
  unsubscribeCount: number;
  pruneCalls: number;
  uiBroker: HttpUiBroker;
}

interface EventStream {
  response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  next(): Promise<HttpAdapterEvent>;
  close(): void;
}

interface Harness {
  server: FastifyInstance;
  hosts: Map<string, FakeHost>;
  factoryCalls: HttpAdapterHostFactoryOptions[];
  createSession(workspaceId?: string): Promise<string>;
}

const WORKSPACES = {
  main: "/workspace/main",
  other: "/workspace/other",
} as const;
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFakeHost(options?: {
  output?: string;
  messages?: readonly AgentMessage[];
  prompt?: (message: string) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  abort?: () => Promise<void>;
  dispose?: () => Promise<void>;
  broker?: HttpUiBroker;
}): FakeHost {
  const broker = options?.broker ?? createHttpUiBroker();
  const host: FakeHost = {
    calls: [],
    abortCount: 0,
    disposeCount: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
    pruneCalls: 0,
    uiBroker: broker,
    session: {
      messages: options?.messages ?? [],
      getLastAssistantText() {
        host.calls.push("output");
        return options?.output;
      },
    },
    async prompt(message) {
      host.calls.push(`prompt:${message}`);
      await options?.prompt?.(message);
    },
    async waitForIdle() {
      host.calls.push("wait");
      await options?.waitForIdle?.();
    },
    async abort() {
      host.abortCount += 1;
      await options?.abort?.();
    },
    prunePersistedSession() {
      host.pruneCalls += 1;
      return false;
    },
    subscribe(listener: HttpUiBrokerListener) {
      host.subscribeCount += 1;
      const unsubscribe = broker.subscribe(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        host.unsubscribeCount += 1;
        unsubscribe();
      };
    },
    async dispose() {
      host.disposeCount += 1;
      try {
        await options?.dispose?.();
      } finally {
        broker.dispose();
      }
    },
  };
  return host;
}

function createHarness(options?: {
  factory?: (factoryOptions: HttpAdapterHostFactoryOptions) => Promise<FakeHost>;
  runtimeArgs?: readonly string[];
  workspaces?: Readonly<Record<string, string>>;
  listPersistedSessions?: PersistedSessionLister;
}): Harness {
  const hosts = new Map<string, FakeHost>();
  const factoryCalls: HttpAdapterHostFactoryOptions[] = [];
  const server = createHttpAdapterServer({
    workspaces: options?.workspaces ?? WORKSPACES,
    ...(options?.runtimeArgs !== undefined
      ? { runtimeArgs: options.runtimeArgs }
      : {}),
    ...(options?.listPersistedSessions !== undefined
      ? { listPersistedSessions: options.listPersistedSessions }
      : {}),
    createHost: async (factoryOptions) => {
      factoryCalls.push(factoryOptions);
      const host = options?.factory
        ? await options.factory(factoryOptions)
        : createFakeHost();
      hosts.set(factoryOptions.session.id, host);
      return host;
    },
  });
  servers.push(server);

  return {
    server,
    hosts,
    factoryCalls,
    async createSession(workspaceId = "main") {
      const response = await server.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { workspaceId },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    },
  };
}

async function openEventStream(
  server: FastifyInstance,
  sessionId: string,
): Promise<EventStream> {
  const controller = new AbortController();
  const response = await server.inject({
    method: "GET",
    url: `/v1/sessions/${sessionId}/events`,
    payloadAsStream: true,
    signal: controller.signal,
  });
  const stream = response.stream();
  const events: HttpAdapterEvent[] = [];
  const waiters: Array<(event: HttpAdapterEvent) => void> = [];
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data) as HttpAdapterEvent;
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else events.push(event);
    }
  });

  return {
    response,
    next() {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      return new Promise<HttpAdapterEvent>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for SSE event")),
          2000,
        );
        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
    close() {
      controller.abort();
      stream.destroy();
    },
  };
}

async function waitForCall(host: FakeHost, call: string): Promise<void> {
  await vi.waitFor(() => expect(host.calls).toContain(call));
}

function turnUrl(sessionId: string): string {
  return `/v1/sessions/${sessionId}/turns`;
}

describe("createHttpAdapterServer", () => {
  it("reports health and manages an active persistent session", async () => {
    const harness = createHarness({ runtimeArgs: ["--permission", "auto"] });

    const health = await harness.server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const created = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    const body = created.json<{
      id: string;
      workspaceId: string;
      persisted: boolean;
      resumed: boolean;
      status: string;
    }>();
    expect(created.statusCode).toBe(201);
    expect(body).toMatchObject({
      workspaceId: "main",
      persisted: true,
      resumed: false,
      status: "idle",
    });
    expect(harness.factoryCalls[0]).toEqual({
      cwd: path.resolve(WORKSPACES.main),
      runtimeArgs: ["--permission", "auto"],
      session: { type: "persistent", id: body.id },
    });

    const fetched = await harness.server.inject({
      method: "GET",
      url: `/v1/sessions/${body.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: body.id, status: "idle" });

    const host = harness.hosts.get(body.id)!;
    const deleted = await harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${body.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(host.abortCount).toBe(1);
    expect(host.disposeCount).toBe(1);

    const missing = await harness.server.inject({
      method: "GET",
      url: `/v1/sessions/${body.id}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "session_not_found" });
  });

  it.each([
    ["missing body", undefined],
    ["missing workspace", {}],
    ["wrong workspace type", { workspaceId: 1 }],
    ["blank workspace", { workspaceId: "   " }],
    ["blank resume ID", { workspaceId: "main", resumeSessionId: "   " }],
    ["extra property", { workspaceId: "main", extra: true }],
  ])("rejects an invalid session request: %s", async (_label, payload) => {
    const harness = createHarness();
    const response = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_session_request" });
  });

  it("rejects unknown workspaces, sessions, and old unscoped routes", async () => {
    const harness = createHarness();
    const workspace = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "missing" },
    });
    expect(workspace.statusCode).toBe(404);
    expect(workspace.json()).toEqual({ error: "workspace_not_found" });

    for (const request of [
      { method: "GET" as const, url: "/v1/sessions/missing" },
      { method: "GET" as const, url: "/v1/sessions/missing/messages" },
      { method: "GET" as const, url: "/v1/sessions/missing/events" },
      {
        method: "POST" as const,
        url: "/v1/sessions/missing/turns",
        payload: { message: "Hello" },
      },
    ]) {
      const response = await harness.server.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "session_not_found" });
    }

    expect(
      (await harness.server.inject({ method: "POST", url: "/v1/turns" }))
        .statusCode,
    ).toBe(404);
  });

  it("resumes by exact ID and rejects duplicate activation", async () => {
    const harness = createHarness();
    const first = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      id: "saved-session",
      resumed: true,
      persisted: true,
    });
    expect(harness.factoryCalls[0]?.session).toEqual({
      type: "resume",
      id: "saved-session",
    });

    const duplicate = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "session_already_active" });
  });

  it("maps a missing persisted session and releases failed activation", async () => {
    let attempts = 0;
    const harness = createHarness({
      factory: async (options) => {
        attempts += 1;
        if (attempts === 1) {
          throw new PersistedSessionNotFoundError(options.session.id);
        }
        return createFakeHost();
      },
    });

    const missing = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "persistent_session_not_found" });

    const retried = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(retried.statusCode).toBe(201);
  });

  it("rejects concurrent activation of the same persisted session", async () => {
    const blocked = deferred();
    let started!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createHarness({
      factory: async () => {
        started();
        await blocked.promise;
        return createFakeHost();
      },
    });

    const first = harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    await factoryStarted;
    const second = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(second.statusCode).toBe(409);

    blocked.resolve();
    expect((await first).statusCode).toBe(201);
  });

  it("allows at most one active session per workspace", async () => {
    const harness = createHarness();
    const first = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "workspace_session_active" });

    const elsewhere = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "other" },
    });
    expect(elsewhere.statusCode).toBe(201);
  });

  it("rejects resuming a different session into an occupied workspace", async () => {
    const harness = createHarness();
    await harness.createSession("main");

    const resume = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: "saved-session" },
    });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toEqual({ error: "workspace_session_active" });
    expect(harness.factoryCalls).toHaveLength(1);
  });

  it("keeps the workspace occupied until disposal finishes", async () => {
    const disposeBlocked = deferred();
    const harness = createHarness({
      factory: async () =>
        createFakeHost({ dispose: async () => disposeBlocked.promise }),
    });
    const sessionId = await harness.createSession("main");

    const deletion = harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    await vi.waitFor(() =>
      expect(harness.hosts.get(sessionId)!.disposeCount).toBe(1),
    );

    const blocked = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "workspace_session_active" });

    disposeBlocked.resolve();
    expect((await deletion).statusCode).toBe(204);

    const created = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    expect(created.statusCode).toBe(201);
  });

  it("rejects concurrent activation of the same workspace", async () => {
    const blocked = deferred();
    let started!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createHarness({
      factory: async () => {
        started();
        await blocked.promise;
        return createFakeHost();
      },
    });

    const first = harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    await factoryStarted;
    const second = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "workspace_session_active" });

    blocked.resolve();
    expect((await first).statusCode).toBe(201);
  });

  it("lists sessions with live status or the most recent resume target", async () => {
    const mainSummary = {
      id: "saved-main",
      firstMessage: "Hello from main",
      messageCount: 4,
      modified: new Date("2026-08-04T12:00:00Z"),
    };
    const listCalls: string[] = [];
    const harness = createHarness({
      listPersistedSessions: async (cwd) => {
        listCalls.push(cwd);
        if (cwd === "/workspace/main") {
          return [
            mainSummary,
            { ...mainSummary, id: "older-main", messageCount: 2 },
          ];
        }
        return [];
      },
    });

    const empty = await harness.server.inject({ method: "GET", url: "/v1/sessions" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      sessions: [
        { workspaceId: "main", active: false, session: { ...mainSummary, modified: "2026-08-04T12:00:00.000Z" } },
        { workspaceId: "other", active: false, session: null },
      ],
    });
    expect(listCalls).toEqual(["/workspace/main", "/workspace/other"]);

    const sessionId = await harness.createSession("main");
    const withActive = await harness.server.inject({ method: "GET", url: "/v1/sessions" });
    expect(withActive.statusCode).toBe(200);
    expect(withActive.json()).toEqual({
      sessions: [
        {
          workspaceId: "main",
          active: true,
          session: { id: sessionId, workspaceId: "main", persisted: true, status: "idle" },
        },
        { workspaceId: "other", active: false, session: null },
      ],
    });
    // The occupied workspace is served from live state, so only `other` is scanned again.
    expect(listCalls).toEqual([
      "/workspace/main",
      "/workspace/other",
      "/workspace/other",
    ]);
  });

  it("reports session_list_failed when the persisted store scan fails", async () => {
    const harness = createHarness({
      listPersistedSessions: async () => {
        throw new Error("store unavailable");
      },
    });
    const listed = await harness.server.inject({ method: "GET", url: "/v1/sessions" });
    expect(listed.statusCode).toBe(500);
    expect(listed.json()).toEqual({ error: "session_list_failed" });
  });

  it("returns the mapped transcript of an active session", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Fix the login form", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "On it." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "login.ts" } },
        ],
        api: "openai-completions",
        provider: "openrouter",
        model: "qwen3.7-plus",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [
          { type: "text", text: "file body" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 3,
      },
    ];
    const harness = createHarness({
      factory: async () => createFakeHost({ messages }),
    });
    const sessionId = await harness.createSession();

    const fetched = await harness.server.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/messages`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual({
      messages: [
        { role: "user", timestamp: 1, content: [{ type: "text", text: "Fix the login form" }] },
        {
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "text", text: "On it." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "login.ts" } },
          ],
        },
        {
          role: "toolResult",
          timestamp: 3,
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file body" }],
        },
      ],
    });
  });

  it("runs turns independently across sessions", async () => {
    const blockers = new Map<string, ReturnType<typeof deferred>>();
    const harness = createHarness({
      factory: async (options) => {
        const blocked = deferred();
        blockers.set(options.session.id, blocked);
        return createFakeHost({ prompt: async () => blocked.promise });
      },
    });
    const firstId = await harness.createSession("main");
    const secondId = await harness.createSession("other");

    const first = await harness.server.inject({
      method: "POST",
      url: turnUrl(firstId),
      payload: { message: "First" },
    });
    const second = await harness.server.inject({
      method: "POST",
      url: turnUrl(secondId),
      payload: { message: "Second" },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    const overlapping = await harness.server.inject({
      method: "POST",
      url: turnUrl(firstId),
      payload: { message: "Overlap" },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toEqual({ error: "turn_in_progress" });

    for (const id of [firstId, secondId]) {
      const status = await harness.server.inject({
        method: "GET",
        url: `/v1/sessions/${id}`,
      });
      expect(status.json()).toMatchObject({ status: "running" });
      blockers.get(id)!.resolve();
      await waitForCall(harness.hosts.get(id)!, "output");
    }
  });

  it("returns completion through session-scoped SSE replay", async () => {
    const host = createFakeHost({ output: "Completed" });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();
    const accepted = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "Review" },
    });
    const turnId = accepted.json<{ id: string }>().id;
    await waitForCall(host, "output");

    const events = await openEventStream(harness.server, sessionId);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: "Completed",
    });
    expect(events.response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );
    events.close();
    await vi.waitFor(() => expect(host.pruneCalls).toBe(1));
  });

  it("broadcasts the submitted message with the client id", async () => {
    const promptBlocked = deferred();
    const harness = createHarness({
      factory: async () =>
        createFakeHost({ prompt: async () => promptBlocked.promise }),
    });
    const sessionId = await harness.createSession();
    const firstEvents = await openEventStream(harness.server, sessionId);
    const secondEvents = await openEventStream(harness.server, sessionId);

    const accepted = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "Hello", clientId: "client-a" },
    });
    expect(accepted.statusCode).toBe(202);
    const turnId = accepted.json<{ id: string }>().id;

    const running = {
      type: "turn",
      turnId,
      status: "running",
      message: "Hello",
      clientId: "client-a",
    };
    expect(await firstEvents.next()).toEqual(running);
    expect(await secondEvents.next()).toEqual(running);

    const lateEvents = await openEventStream(harness.server, sessionId);
    expect(await lateEvents.next()).toEqual(running);

    promptBlocked.resolve();
    firstEvents.close();
    secondEvents.close();
    lateEvents.close();
  });

  it.each([
    ["missing body", undefined],
    ["missing message", {}],
    ["wrong type", { message: 1 }],
    ["empty", { message: "" }],
    ["blank", { message: "   " }],
    ["extra", { message: "Hello", extra: true }],
  ])("rejects an invalid scoped turn: %s", async (_label, payload) => {
    const harness = createHarness();
    const sessionId = await harness.createSession();
    const response = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(response.statusCode).toBe(400);
  });

  it("publishes failure and releases only that session guard", async () => {
    let attempts = 0;
    const host = createFakeHost({
      output: "Recovered",
      prompt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider failed");
      },
    });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();
    const failed = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "First" },
    });
    const failedId = failed.json<{ id: string }>().id;
    await vi.waitFor(() => expect(attempts).toBe(1));

    const events = await openEventStream(harness.server, sessionId);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId: failedId,
      status: "failed",
      error: "provider failed",
    });
    events.close();

    const recovered = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "Second" },
    });
    expect(recovered.statusCode).toBe(202);
    await waitForCall(host, "output");
  });

  it("keeps broker events and UI responses isolated by session", async () => {
    const brokers = new Map<string, HttpUiBroker>();
    const harness = createHarness({
      factory: async (options) => {
        const broker = createHttpUiBroker();
        brokers.set(options.session.id, broker);
        return createFakeHost({ broker });
      },
    });
    const firstId = await harness.createSession("main");
    const secondId = await harness.createSession("other");
    const firstEvents = await openEventStream(harness.server, firstId);
    const secondEvents = await openEventStream(harness.server, secondId);

    brokers.get(firstId)!.uiContext.setStatus("agent", "first");
    brokers.get(secondId)!.uiContext.setStatus("agent", "second");
    expect(await firstEvents.next()).toEqual({
      type: "ui_event",
      turnId: null,
      event: { method: "status", key: "agent", text: "first" },
    });
    expect(await secondEvents.next()).toEqual({
      type: "ui_event",
      turnId: null,
      event: { method: "status", key: "agent", text: "second" },
    });

    let requestId = "";
    brokers.get(firstId)!.subscribe((event) => {
      if (event.type === "ui_request") requestId = event.request.id;
    });
    const confirmation = brokers
      .get(firstId)!
      .uiContext.confirm("Continue?", "First session");

    const wrongSession = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${secondId}/ui-requests/${requestId}/responses`,
      payload: { confirmed: true },
    });
    expect(wrongSession.statusCode).toBe(404);
    expect(wrongSession.json()).toEqual({ error: "ui_request_not_found" });

    const correct = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${firstId}/ui-requests/${requestId}/responses`,
      payload: { confirmed: true },
    });
    expect(correct.statusCode).toBe(204);
    await expect(confirmation).resolves.toBe(true);
    firstEvents.close();
    secondEvents.close();
  });

  it("streams translated assistant, tool, and extension events", async () => {
    const broker = createHttpUiBroker();
    const harness = createHarness({
      factory: async () => createFakeHost({ broker }),
    });
    const sessionId = await harness.createSession();
    const events = await openEventStream(harness.server, sessionId);

    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "internal" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "internal" },
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "compaction_start",
      reason: "threshold",
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    broker.publishSessionEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    } as AgentSessionEvent);
    broker.publishExtensionError({
      extensionPath: "extension.ts",
      event: "tool_call",
      error: "Extension failed",
      stack: "hidden",
    });

    expect(await events.next()).toMatchObject({
      type: "assistant_text_delta",
      delta: "Hello",
    });
    expect(await events.next()).toMatchObject({
      type: "thinking_start",
      turnId: null,
    });
    expect(await events.next()).toMatchObject({
      type: "thinking_end",
      turnId: null,
    });
    expect(await events.next()).toMatchObject({
      type: "compaction_start",
      turnId: null,
    });
    expect(await events.next()).toMatchObject({
      type: "compaction_end",
      turnId: null,
    });
    expect(await events.next()).toMatchObject({
      type: "tool",
      phase: "started",
      toolCallId: "tool-1",
    });
    expect(await events.next()).toEqual({
      type: "extension_error",
      turnId: null,
      error: {
        extensionPath: "extension.ts",
        event: "tool_call",
        message: "Extension failed",
      },
    });
    events.close();
  });

  it("delivers and resolves a confirmation during a scoped turn", async () => {
    const broker = createHttpUiBroker();
    let confirmed: boolean | undefined;
    const host = createFakeHost({
      broker,
      output: "Approved",
      prompt: async () => {
        confirmed = await broker.uiContext.confirm("Apply patch?", "src/auth.ts");
      },
    });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();
    const events = await openEventStream(harness.server, sessionId);
    const accepted = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "Apply the fix" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "running",
      message: "Apply the fix",
    });
    const requestEvent = await events.next();
    if (requestEvent.type !== "ui_request") throw new Error("Missing UI request");

    const invalid = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/ui-requests/${requestEvent.request.id}/responses`,
      payload: { value: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_ui_response" });

    const response = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/ui-requests/${requestEvent.request.id}/responses`,
      payload: { confirmed: true },
    });
    expect(response.statusCode).toBe(204);
    expect(confirmed).toBe(true);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: "Approved",
    });
    events.close();
  });

  it.each([
    {},
    { confirmed: "yes" },
    { cancelled: false },
    { value: "yes", confirmed: true },
    { value: "yes", extra: true },
  ])("rejects an invalid scoped UI response", async (payload) => {
    const harness = createHarness();
    const sessionId = await harness.createSession();
    const response = await harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/ui-requests/request/responses`,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_ui_response" });
  });

  it("aborts only the selected session and shares repeated aborts", async () => {
    const promptBlocked = new Map<string, ReturnType<typeof deferred>>();
    const abortBlocked = deferred();
    const harness = createHarness({
      factory: async (options) => {
        const prompt = deferred();
        promptBlocked.set(options.session.id, prompt);
        return createFakeHost({
          prompt: async () => prompt.promise,
          ...(options.cwd === path.resolve(WORKSPACES.main)
            ? { abort: async () => abortBlocked.promise }
            : {}),
        });
      },
    });
    const firstId = await harness.createSession("main");
    const secondId = await harness.createSession("other");
    const firstTurn = await harness.server.inject({
      method: "POST",
      url: turnUrl(firstId),
      payload: { message: "First" },
    });
    await harness.server.inject({
      method: "POST",
      url: turnUrl(secondId),
      payload: { message: "Second" },
    });
    const turnId = firstTurn.json<{ id: string }>().id;

    const firstAbort = harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${firstId}/turns/${turnId}/abort`,
    });
    await vi.waitFor(() => expect(harness.hosts.get(firstId)!.abortCount).toBe(1));
    const repeated = harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${firstId}/turns/${turnId}/abort`,
    });
    expect(harness.hosts.get(secondId)!.abortCount).toBe(0);

    abortBlocked.resolve();
    expect((await firstAbort).statusCode).toBe(202);
    expect((await repeated).statusCode).toBe(202);
    promptBlocked.get(firstId)!.resolve();
    promptBlocked.get(secondId)!.resolve();
  });

  it("does not report aborted when abort fails after turn settlement", async () => {
    const promptBlocked = deferred();
    const abortBlocked = deferred();
    let abortAttempts = 0;
    const host = createFakeHost({
      output: "Finished",
      prompt: async () => promptBlocked.promise,
      abort: async () => {
        abortAttempts += 1;
        if (abortAttempts === 1) await abortBlocked.promise;
      },
    });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();
    const accepted = await harness.server.inject({
      method: "POST",
      url: turnUrl(sessionId),
      payload: { message: "Long task" },
    });
    const turnId = accepted.json<{ id: string }>().id;

    const abortRequest = harness.server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns/${turnId}/abort`,
    });
    await vi.waitFor(() => expect(host.abortCount).toBe(1));
    promptBlocked.resolve();
    await waitForCall(host, "wait");
    abortBlocked.reject(new Error("abort failed"));

    expect((await abortRequest).statusCode).toBe(500);
    await waitForCall(host, "output");
    const events = await openEventStream(harness.server, sessionId);
    expect(await events.next()).toEqual({
      type: "turn",
      turnId,
      status: "completed",
      output: "Finished",
    });
    events.close();
  });

  it("blocks resume while deletion is still disposing the host", async () => {
    const abortBlocked = deferred();
    const host = createFakeHost({ abort: async () => abortBlocked.promise });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();

    const deletion = harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    await vi.waitFor(() => expect(host.abortCount).toBe(1));
    const resume = await harness.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspaceId: "main", resumeSessionId: sessionId },
    });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toEqual({ error: "session_already_active" });

    abortBlocked.resolve();
    expect((await deletion).statusCode).toBe(204);
  });

  it("retains failed disposal so deletion can be retried", async () => {
    let disposeAttempts = 0;
    const host = createFakeHost({
      dispose: async () => {
        disposeAttempts += 1;
        if (disposeAttempts === 1) throw new Error("dispose failed");
      },
    });
    const harness = createHarness({ factory: async () => host });
    const sessionId = await harness.createSession();

    const failed = await harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "session_disposal_failed" });

    const retry = await harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    expect(retry.statusCode).toBe(204);
    expect(host.abortCount).toBe(2);
    expect(host.disposeCount).toBe(2);
  });

  it("deleting one session closes only its stream", async () => {
    const harness = createHarness();
    const firstId = await harness.createSession("main");
    const secondId = await harness.createSession("other");
    await openEventStream(harness.server, firstId);
    const secondEvents = await openEventStream(harness.server, secondId);

    const deleted = await harness.server.inject({
      method: "DELETE",
      url: `/v1/sessions/${firstId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(harness.hosts.get(firstId)!.unsubscribeCount).toBe(1);
    expect(harness.hosts.get(firstId)!.disposeCount).toBe(1);
    expect(harness.hosts.get(secondId)!.disposeCount).toBe(0);

    harness.hosts.get(secondId)!.uiBroker.uiContext.setStatus("agent", "ready");
    expect(await secondEvents.next()).toMatchObject({
      type: "ui_event",
      event: { method: "status", text: "ready" },
    });
    secondEvents.close();
  });

  it("shuts down every session even when one disposal fails", async () => {
    let created = 0;
    const harness = createHarness({
      factory: async () => {
        created += 1;
        return createFakeHost({
          ...(created === 1
            ? {
                dispose: async () => {
                  throw new Error("dispose failed");
                },
              }
            : {}),
        });
      },
    });
    const firstId = await harness.createSession("main");
    const secondId = await harness.createSession("other");
    await openEventStream(harness.server, firstId);
    await openEventStream(harness.server, secondId);

    await harness.server.close();
    await harness.server.close();

    for (const id of [firstId, secondId]) {
      const host = harness.hosts.get(id)!;
      expect(host.unsubscribeCount).toBe(1);
      expect(host.abortCount).toBe(1);
      expect(host.disposeCount).toBe(1);
    }
  });
});
