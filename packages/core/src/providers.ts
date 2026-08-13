import fs from "node:fs";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

export const SUPPORTED_PROVIDER_IDS = [
  "deepseek",
  "openai-codex",
  "openai",
  "anthropic",
  "openrouter",
  "zai",
  "kimi-coding",
  "minimax",
  "xai",
  "opencode-go",
] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

const DEFAULT_MODELS: Record<SupportedProviderId, string> = {
  deepseek: "deepseek-v4-flash",
  "openai-codex": "gpt-5.6-sol",
  openai: "gpt-5.6-sol",
  anthropic: "claude-opus-4-8",
  openrouter: "moonshotai/kimi-k2.6",
  zai: "glm-5.1",
  "kimi-coding": "kimi-for-coding",
  minimax: "MiniMax-M2.7",
  xai: "grok-4.5",
  "opencode-go": "kimi-k2.6",
};

const DEFAULT_EFFORTS: Record<SupportedProviderId, string> = {
  deepseek: "max",
  "openai-codex": "medium",
  openai: "medium",
  anthropic: "medium",
  openrouter: "medium",
  zai: "medium",
  "kimi-coding": "medium",
  minimax: "medium",
  xai: "medium",
  "opencode-go": "medium",
};

const PROVIDER_NAMES: Record<SupportedProviderId, string> = {
  deepseek: "DeepSeek",
  "openai-codex": "OpenAI Codex (ChatGPT plan)",
  openai: "OpenAI API",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  zai: "Z.AI Coding Plan",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  xai: "xAI (Grok)",
  "opencode-go": "OpenCode Zen Go",
};

const PROVIDER_ENVIRONMENT_KEYS: Partial<Record<SupportedProviderId, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  xai: "XAI_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

const PROVIDER_ALIASES: Readonly<Record<string, SupportedProviderId>> = {
  grok: "xai",
  kimi: "kimi-coding",
};

export const MODEL_CREDENTIAL_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "OPENCODE_API_KEY",
] as const;

export interface StoredModelSelection {
  providerId: SupportedProviderId;
  modelId?: string;
}

export function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

export function parseSupportedProviderId(value: string): SupportedProviderId {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  const providerId = PROVIDER_ALIASES[normalized] ?? normalized;
  if (isSupportedProviderId(providerId)) return providerId;
  throw new Error(
    `Unsupported provider "${value}". Choose ${SUPPORTED_PROVIDER_IDS.join(", ")}.`,
  );
}

export function defaultModelForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_MODELS[providerId];
}

export function defaultEffortForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_EFFORTS[providerId];
}

export function providerDisplayName(providerId: SupportedProviderId): string {
  return PROVIDER_NAMES[providerId];
}

export function providerEnvironmentKey(providerId: SupportedProviderId): string | undefined {
  return PROVIDER_ENVIRONMENT_KEYS[providerId];
}

export function getStoredModelSelection(
  settingsPath = path.join(getDSCodeHome(), "settings.json"),
): StoredModelSelection | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof settings.defaultProvider !== "string") return undefined;
    const normalized = settings.defaultProvider.toLocaleLowerCase("en-US");
    if (!isSupportedProviderId(normalized)) return undefined;
    return {
      providerId: normalized,
      ...(typeof settings.defaultModel === "string" && settings.defaultModel.trim()
        ? { modelId: settings.defaultModel.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function stripModelCredentialEnvironment<T extends Record<string, string | undefined>>(
  environment: T,
): T {
  for (const name of MODEL_CREDENTIAL_ENV_KEYS) delete environment[name];
  return environment;
}
