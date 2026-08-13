import { describe, expect, it } from "vitest";
import {
  LOGIN_PROVIDER_CHOICES,
  routeDSCodeLogin,
  scopeLoginSuggestions,
} from "../packages/core/src/login-scope.js";

describe("DSCode provider login", () => {
  it("opens the provider selector for bare login", () => {
    expect(routeDSCodeLogin("/login")).toEqual({ action: "select", text: "/login" });
    expect(routeDSCodeLogin(" /LOGIN ")).toEqual({ action: "select", text: "/login" });
    expect(LOGIN_PROVIDER_CHOICES.map((choice) => choice.providerId)).toEqual([
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
    ]);
  });

  it.each([
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
  ] as const)(
    "allows the supported %s provider",
    (providerId) => {
      expect(routeDSCodeLogin(`/login ${providerId}`)).toEqual({
        action: "provider",
        providerId,
        text: `/login ${providerId}`,
      });
    },
  );

  it("accepts familiar Kimi and Grok aliases", () => {
    expect(routeDSCodeLogin("/login kimi")).toEqual({
      action: "provider",
      providerId: "kimi-coding",
      text: "/login kimi-coding",
    });
    expect(routeDSCodeLogin("/login grok")).toEqual({
      action: "provider",
      providerId: "xai",
      text: "/login xai",
    });
  });

  it("rejects other provider login commands without affecting ordinary prompts", () => {
    expect(routeDSCodeLogin("/login google")).toEqual({ action: "reject" });
    expect(routeDSCodeLogin("explain /login google")).toEqual({
      action: "continue",
      text: "explain /login google",
    });
  });

  it("suggests the supported providers after /login", () => {
    const items = [
      { value: "anthropic", label: "anthropic", description: "API key" },
      { value: "deepseek", label: "deepseek", description: "API key" },
      { value: "openai-codex", label: "openai-codex", description: "OAuth" },
      { value: "openai", label: "openai", description: "API key" },
      { value: "openrouter", label: "openrouter", description: "OAuth" },
      { value: "google", label: "google", description: "API key" },
    ];
    expect(scopeLoginSuggestions("/login ", items)).toEqual([
      { ...items[0], description: "Claude account or API key" },
      items[1],
      { ...items[2], description: "ChatGPT plan" },
      items[3],
      { ...items[4], description: "Account or API key" },
    ]);
  });
});
