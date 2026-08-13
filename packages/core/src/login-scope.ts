import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  parseSupportedProviderId,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
} from "./providers.js";

export const LOGIN_PROVIDER_CHOICES: ReadonlyArray<{
  providerId: SupportedProviderId;
  label: string;
}> = [
  { providerId: "deepseek", label: "DeepSeek — API key" },
  { providerId: "openai-codex", label: "OpenAI Codex — ChatGPT plan" },
  { providerId: "openai", label: "OpenAI — API key" },
  { providerId: "anthropic", label: "Anthropic — Claude account or API key" },
  { providerId: "openrouter", label: "OpenRouter — account or API key" },
  { providerId: "zai", label: "Z.AI — Coding Plan API key" },
  { providerId: "kimi-coding", label: "Kimi — Kimi Code account or API key" },
  { providerId: "minimax", label: "MiniMax — API key" },
  { providerId: "xai", label: "xAI (Grok) — account or API key" },
  { providerId: "opencode-go", label: "OpenCode Zen Go — API key" },
];

const LOGIN_DESCRIPTIONS: Record<SupportedProviderId, string> = {
  deepseek: "API key",
  "openai-codex": "ChatGPT plan",
  openai: "API key",
  anthropic: "Claude account or API key",
  openrouter: "Account or API key",
  zai: "Coding Plan API key",
  "kimi-coding": "Kimi Code account or API key",
  minimax: "API key",
  xai: "Grok/X account or API key",
  "opencode-go": "API key",
};

export type DSCodeLoginRoute =
  | { action: "continue"; text: string }
  | { action: "select"; text: "/login" }
  | { action: "provider"; providerId: SupportedProviderId; text: string }
  | { action: "reject" };

export function routeDSCodeLogin(text: string): DSCodeLoginRoute {
  const normalized = text.trim().toLocaleLowerCase("en-US");
  if (normalized === "/login") {
    return { action: "select", text: "/login" };
  }
  if (normalized.startsWith("/login ")) {
    try {
      const providerId = parseSupportedProviderId(normalized.slice("/login ".length).trim());
      return { action: "provider", providerId, text: `/login ${providerId}` };
    } catch {
      return { action: "reject" };
    }
  }
  return { action: "continue", text };
}

export function scopeLoginSuggestions(text: string, items: AutocompleteItem[]): AutocompleteItem[] {
  const enteringProvider = /^\s*\/login\s+/i.test(text);
  if (enteringProvider) {
    return items
      .filter((item) => {
        const value = item.value.toLocaleLowerCase("en-US");
        const label = item.label.toLocaleLowerCase("en-US");
        return SUPPORTED_PROVIDER_IDS.some((providerId) => value === providerId || label === providerId);
      })
      .map((item) => {
        const value = item.value.toLocaleLowerCase("en-US");
        const label = item.label.toLocaleLowerCase("en-US");
        const providerId = SUPPORTED_PROVIDER_IDS.find(
          (candidate) => value === candidate || label === candidate,
        );
        return providerId
          ? { ...item, description: LOGIN_DESCRIPTIONS[providerId] }
          : item;
      });
  }
  return items.map((item) =>
    item.value === "/login" || item.label === "/login" || item.label === "login"
      ? { ...item, description: "Configure a model provider" }
      : item,
  );
}
