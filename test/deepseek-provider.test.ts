import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.js";

describe("DeepSeek provider registration", () => {
  it("keeps Flash and Pro available when another provider is active", () => {
    let registeredModels: Array<{ id: string; name: string }> | undefined;
    const pi = new Proxy(
      {
        registerProvider(name: string, config: { models?: Array<{ id: string; name: string }> }) {
          if (name === "deepseek") registeredModels = config.models;
        },
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getThinkingLevel: () => "medium",
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;

    createDSCodeExtension(options()).factory(pi);

    expect(registeredModels?.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(registeredModels?.map((model) => model.name)).toEqual([
      "DeepSeek V4 Flash",
      "DeepSeek V4 Pro",
    ]);
  });
});

function options(): DSCodeRuntimeOptions {
  return {
    cwd: process.cwd(),
    providerId: "anthropic",
    baseUrl: "https://api.deepseek.com",
    modelId: "claude-opus-4-8",
    transport: "responses",
    harness: "minimal",
    permission: "auto",
    sandbox: "workspace-write",
    network: false,
    webSearch: false,
    activeTools: ["update_plan", "exec_command", "write_stdin", "apply_patch"],
    toolsExplicit: false,
  };
}
