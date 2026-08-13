export const PROVIDER_IDS = [
  "deepseek",
  "openai-codex",
  "openai",
  "anthropic",
  "openrouter",
  "zai",
  "kimi-coding",
  "minimax",
  "xai",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type PermissionMode = "plan" | "ask" | "auto" | "full";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type LanguagePreference = "system" | "zh-CN" | "en";

export interface UserProfile {
  nickname: string;
  avatarDataUrl?: string;
}

export interface WorkspaceItem {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface SessionSummary {
  path: string;
  storagePath: string;
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  messageCount: number;
  preview?: string;
  pinned: boolean;
  archived: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
  source?: "stored" | "environment";
  defaultModel: string;
}

export interface ThemePalette {
  canvas: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  focus: string;
  success: string;
  warning: string;
  danger: string;
  terminalBackground?: string;
  terminalForeground?: string;
}

export interface ThemeSummary {
  id: string;
  displayName: string;
  description?: string;
  previewDataUrl?: string;
  mode: "light" | "dark";
  palette: ThemePalette;
}

export type FilePreviewKind = "html" | "markdown" | "image" | "pdf" | "video" | "audio" | "code" | "text" | "unsupported";

export interface FilePreview {
  id: string;
  path: string;
  name: string;
  extension: string;
  kind: FilePreviewKind;
  url: string;
  size: number;
  modifiedAt: string;
  content?: string;
  tooLarge?: boolean;
}

export interface AgentStartOptions {
  cwd?: string;
  project?: boolean;
  provider: ProviderId;
  model?: string;
  effort?: string;
  permission: PermissionMode;
  sandbox: SandboxMode;
  sessionPath?: string;
}

export interface AgentSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface AgentSnapshot {
  state: Record<string, unknown>;
  messages: unknown[];
  models: Array<{ provider: string; id: string; contextWindow?: number; reasoning?: boolean }>;
  thinkingLevels: string[];
  stats?: AgentSessionStats;
}

export type AgentEvent = Record<string, unknown> & { type: string };

export type ExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  [key: string]: unknown;
};

export type AuthUiEvent =
  | { kind: "prompt"; id: string; prompt: { type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> } }
  | { kind: "notice"; event: { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string } }
  | { kind: "complete"; providerId: ProviderId; modelId: string }
  | { kind: "error"; message: string };

export interface DesktopApi {
  platform: NodeJS.Platform;
  app: {
    version(): Promise<string>;
    openExternal(url: string): Promise<void>;
  };
  themes: {
    list(): Promise<ThemeSummary[]>;
    getActive(): Promise<string | null>;
    setActive(id: string | null): Promise<void>;
  };
  settings: {
    getLanguage(): Promise<LanguagePreference>;
    setLanguage(language: LanguagePreference): Promise<void>;
    getProfile(): Promise<UserProfile>;
    setProfile(profile: UserProfile): Promise<void>;
  };
  workspace: {
    choose(): Promise<string | null>;
    recent(): Promise<WorkspaceItem[]>;
    forget(path: string): Promise<WorkspaceItem[]>;
  };
  files: {
    choosePreview(): Promise<FilePreview | null>;
    validPreviewPaths(paths: string[]): Promise<string[]>;
    preview(path: string): Promise<FilePreview>;
    openPreview(id: string): Promise<void>;
  };
  sessions: {
    list(cwd?: string): Promise<SessionSummary[]>;
    pin(id: string, pinned: boolean): Promise<boolean>;
    archive(id: string): Promise<SessionSummary | undefined>;
    unarchive(id: string): Promise<SessionSummary | undefined>;
  };
  auth: {
    status(): Promise<ProviderStatus[]>;
    saveApiKey(provider: Exclude<ProviderId, "openai-codex">, key: string, baseUrl?: string): Promise<void>;
    login(provider: Exclude<ProviderId, "deepseek">): Promise<void>;
    respond(id: string, value: string): Promise<void>;
    logout(provider: ProviderId): Promise<void>;
    onEvent(listener: (event: AuthUiEvent) => void): () => void;
  };
  agent: {
    start(options: AgentStartOptions): Promise<AgentSnapshot>;
    stop(): Promise<void>;
    command<T = unknown>(type: string, data?: Record<string, unknown>): Promise<T>;
    respondToUi(id: string, response: Record<string, unknown>): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
    onError(listener: (message: string) => void): () => void;
  };
  onAppCommand?(listener: (command: string) => void): () => void;
}
