import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  parseSupportedProviderId,
  stripModelCredentialEnvironment,
} from "../packages/core/src/providers.js";

describe("DSCode model providers", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("uses provider-appropriate model and effort defaults", () => {
    expect(defaultModelForProvider("deepseek")).toBe("deepseek-v4-flash");
    expect(defaultEffortForProvider("deepseek")).toBe("max");
    expect(defaultModelForProvider("openai-codex")).toBe("gpt-5.6-sol");
    expect(defaultEffortForProvider("openai-codex")).toBe("medium");
    expect(defaultModelForProvider("openai")).toBe("gpt-5.6-sol");
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-4-8");
    expect(defaultModelForProvider("openrouter")).toBe("moonshotai/kimi-k2.6");
    expect(defaultModelForProvider("zai")).toBe("glm-5.1");
    expect(defaultModelForProvider("kimi-coding")).toBe("kimi-for-coding");
    expect(defaultModelForProvider("minimax")).toBe("MiniMax-M2.7");
    expect(defaultModelForProvider("xai")).toBe("grok-4.5");
    expect(defaultModelForProvider("opencode-go")).toBe("kimi-k2.6");
    expect(defaultEffortForProvider("opencode-go")).toBe("medium");
  });

  it("ships every configured provider default in the built-in model catalog", () => {
    for (const providerId of [
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
    ] as const) {
      expect(getBuiltinModel(providerId, defaultModelForProvider(providerId))).toBeDefined();
    }
  });

  it("normalizes the familiar Kimi and Grok provider names", () => {
    expect(parseSupportedProviderId("kimi")).toBe("kimi-coding");
    expect(parseSupportedProviderId("grok")).toBe("xai");
    expect(parseSupportedProviderId("opencode-go")).toBe("opencode-go");
  });

  it("exposes OpenCode Zen Go as API-key auth, not OAuth", () => {
    expect(opencodeGoProvider().auth.apiKey).toBeDefined();
    expect(opencodeGoProvider().auth.oauth).toBeUndefined();
  });

  it("ships the default OpenAI models with image input support", () => {
    for (const providerId of ["openai-codex", "openai"] as const) {
      const model = getBuiltinModel(providerId, defaultModelForProvider(providerId));
      expect(model?.input).toContain("image");
      expect(model?.api).toContain("responses");
    }
  });

  it("exposes Codex subscription OAuth separately from OpenAI API-key auth", () => {
    expect(openaiCodexProvider().auth.oauth).toBeDefined();
    expect(openaiCodexProvider().auth.apiKey).toBeUndefined();
    expect(openaiProvider().auth.apiKey).toBeDefined();
  });

  it("reads a model selection saved by the TUI", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-provider-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra" }),
    );

    expect(getStoredModelSelection(settingsPath)).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-terra",
    });
  });

  it("removes every supported model credential from child environments", () => {
    const environment = stripModelCredentialEnvironment({
      PATH: "/bin",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      ZAI_API_KEY: "zai-secret",
      KIMI_API_KEY: "kimi-secret",
      MINIMAX_API_KEY: "minimax-secret",
      XAI_API_KEY: "xai-secret",
      OPENCODE_API_KEY: "opencode-secret",
    });
    expect(environment).toEqual({ PATH: "/bin" });
  });
});
