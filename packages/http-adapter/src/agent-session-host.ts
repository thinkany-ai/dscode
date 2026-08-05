import path from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  createDSCodeExtension,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  parseRuntimeArgs,
} from "@thinkany/dscode-core";
import {
  createHttpUiBroker,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "./ui-broker.js";

export type AgentSessionStorage =
  | { type: "memory" }
  | { type: "persistent"; id?: string }
  | { type: "resume"; id: string };

export class PersistedSessionAlreadyExistsError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Persisted session already exists: ${sessionId}`);
    this.name = "PersistedSessionAlreadyExistsError";
    this.sessionId = sessionId;
  }
}

export class PersistedSessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Persisted session not found: ${sessionId}`);
    this.name = "PersistedSessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export interface CreateAgentSessionHostOptions {
  cwd: string;
  runtimeArgs?: readonly string[];
  uiBroker?: HttpUiBroker;
  session?: AgentSessionStorage;
}

export interface AgentSessionHost {
  readonly session: AgentSession;
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  readonly uiBroker: HttpUiBroker;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: HttpUiBrokerListener): () => void;
  dispose(): Promise<void>;
}

export async function createAgentSessionHost(
  options: CreateAgentSessionHostOptions,
): Promise<AgentSessionHost> {
  const cwd = path.resolve(options.cwd);
  validateRuntimeArgs(options.runtimeArgs ?? []);
  const parsed = parseRuntimeArgs(["-C", cwd, ...(options.runtimeArgs ?? [])]);
  if (parsed.help || parsed.version) {
    throw new Error("Help and version flags are not supported by the direct session host");
  }
  const thinkingLevel = getThinkingLevel(parsed.piArgs);

  const agentDir = await initializeDSCodeHome();
  ensureThemeInitialized();
  const uiBroker = options.uiBroker ?? createHttpUiBroker();
  const sessionManager = await createSessionManager(cwd, options.session);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  }) => {
    const runtimeOptions = { ...parsed.options, cwd: runtimeCwd };
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        extensionFactories: [createDSCodeExtension(runtimeOptions)],
      },
    });
    const model = services.modelRuntime.getModel(
      runtimeOptions.providerId,
      runtimeOptions.modelId,
    );
    if (!model) {
      throw new Error(
        `Model not found: ${runtimeOptions.providerId}/${runtimeOptions.modelId}`,
      );
    }

    const result = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      tools: runtimeOptions.activeTools,
    });

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  let runtime: AgentSessionRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });
    const session = runtime.session;
    uiBroker.attachBaseContext(session.extensionRunner.getUIContext());
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      uiBroker.publishSessionEvent(event);
    });
    await session.bindExtensions({
      mode: "rpc",
      uiContext: uiBroker.uiContext,
      onError(error) {
        uiBroker.publishExtensionError(error);
      },
    });
    return createHost(runtime, uiBroker, unsubscribe);
  } catch (error) {
    unsubscribe?.();
    uiBroker.dispose();
    await runtime?.dispose();
    throw error;
  }
}

function createHost(
  runtime: AgentSessionRuntime,
  uiBroker: HttpUiBroker,
  unsubscribe: () => void,
): AgentSessionHost {
  let disposePromise: Promise<void> | undefined;
  let disposalStarted = false;
  let unsubscribed = false;

  const assertActive = (): void => {
    if (disposalStarted) throw new Error("Agent session host is disposed");
  };

  return {
    get session() {
      return runtime.session;
    },
    get diagnostics() {
      return runtime.diagnostics;
    },
    uiBroker,
    async prompt(message) {
      assertActive();
      assertPromptSupported(message);
      await runtime.session.prompt(message, { source: "rpc" });
    },
    async abort() {
      assertActive();
      await runtime.session.abort();
    },
    async waitForIdle() {
      assertActive();
      await runtime.session.waitForIdle();
    },
    subscribe(listener) {
      assertActive();
      return uiBroker.subscribe(listener);
    },
    dispose() {
      disposalStarted = true;
      if (disposePromise) return disposePromise;

      const attempt = (async () => {
        uiBroker.dispose();
        if (!unsubscribed) {
          unsubscribe();
          unsubscribed = true;
        }
        await runtime.dispose();
      })();
      disposePromise = attempt;
      void attempt.catch(() => {
        if (disposePromise === attempt) disposePromise = undefined;
      });
      return attempt;
    },
  };
}

const UNSUPPORTED_SESSION_COMMANDS = new Set([
  "clear",
  "new",
  "resume",
  "fork",
  "clone",
  "import",
  "tree",
]);

function assertPromptSupported(message: string): void {
  const match = /^\/([^\s]+)/.exec(message.trimStart());
  const command = match?.[1]?.toLowerCase();
  if (command && UNSUPPORTED_SESSION_COMMANDS.has(command)) {
    throw new Error(`Session command /${command} is not supported by this host`);
  }
}

async function createSessionManager(
  cwd: string,
  storage: AgentSessionStorage | undefined,
): Promise<SessionManager> {
  if (!storage || storage.type === "memory") return SessionManager.inMemory(cwd);

  const sessionDir = getDSCodeSessionsDir();
  if (storage.type === "persistent") {
    if (storage.id !== undefined) {
      const existing = (await SessionManager.list(cwd, sessionDir)).some(
        (session) => session.id === storage.id,
      );
      if (existing) throw new PersistedSessionAlreadyExistsError(storage.id);
    }
    return SessionManager.create(
      cwd,
      sessionDir,
      storage.id !== undefined ? { id: storage.id } : undefined,
    );
  }

  const matches = (await SessionManager.list(cwd, sessionDir)).filter(
    (session) => session.id === storage.id,
  );
  if (matches.length === 0) throw new PersistedSessionNotFoundError(storage.id);
  if (matches.length > 1) {
    throw new Error(`Multiple persisted sessions found with ID: ${storage.id}`);
  }
  return SessionManager.open(matches[0]!.path, sessionDir, cwd);
}

let themeInitialized = false;

function ensureThemeInitialized(): void {
  if (themeInitialized) return;
  initTheme(undefined, false);
  themeInitialized = true;
}

type ThinkingLevel = NonNullable<
  CreateAgentSessionFromServicesOptions["thinkingLevel"]
>;

const VALUE_RUNTIME_FLAGS = new Set([
  "--provider",
  "--base-url",
  "--transport",
  "--harness",
  "--permission",
  "--sandbox",
  "--effort",
  "--model",
  "--tools",
]);
const BOOLEAN_RUNTIME_FLAGS = new Set([
  "--network",
  "--web",
  "--no-tools",
  "--no-resume",
]);
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function validateRuntimeArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const hasInlineValue = equals !== -1;

    if (BOOLEAN_RUNTIME_FLAGS.has(flag)) {
      if (hasInlineValue) throw new Error(`${flag} does not accept a value`);
      continue;
    }
    if (VALUE_RUNTIME_FLAGS.has(flag)) {
      if (!hasInlineValue) {
        if (args[index + 1] === undefined) throw new Error(`${flag} requires a value`);
        index += 1;
      }
      continue;
    }
    throw new Error(`Unsupported direct session argument: ${argument}`);
  }
}

function getThinkingLevel(args: readonly string[]): ThinkingLevel | undefined {
  const index = args.indexOf("--thinking");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) return undefined;
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`Unsupported thinking level: ${value}`);
  }
  return value as ThinkingLevel;
}
