import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPersonalizationPrompt,
  composePersonalizedSystemPrompt,
  loadPersonalizationPrompt,
  type PersonalizationTone,
} from "../packages/core/src/personalization.js";

describe("personalization prompt", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-personalization-"));
    file = path.join(root, "app-settings.json");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not add a prompt for default empty preferences", () => {
    expect(buildPersonalizationPrompt({ tone: "default", customInstructions: "" })).toBe("");
  });

  it.each([
    ["professional", "clear, precise, professional"],
    ["friendly", "warm, approachable"],
    ["candid", "concise and direct"],
    ["quirky", "imaginative, playful"],
    ["efficient", "fewest words"],
    ["cynical", "sharp, witty"],
    ["inspiring", "Guide reflection"],
  ] satisfies Array<[Exclude<PersonalizationTone, "default">, string]>)
  ("maps the %s tone to its instruction", (tone, expected) => {
    expect(buildPersonalizationPrompt({ tone, customInstructions: "" })).toContain(expected);
  });

  it("wraps custom instructions with explicit safety and permission limits", () => {
    const prompt = buildPersonalizationPrompt({
      tone: "default",
      customInstructions: "Start with a concise conclusion.",
    });
    expect(prompt).toContain("# User personalization preferences");
    expect(prompt).toContain("Start with a concise conclusion.");
    expect(prompt).toContain("never grant additional permissions");
  });

  it("keeps the base and engineering prompts when composing personalization", () => {
    const result = composePersonalizedSystemPrompt("BASE", "ENGINEERING", "PERSONALIZATION");
    expect(result).toBe("BASE\n\nENGINEERING\n\nPERSONALIZATION");
  });

  it("reads fresh settings for each turn and safely ignores damaged settings", async () => {
    expect(await loadPersonalizationPrompt(undefined)).toBe("");
    expect(await loadPersonalizationPrompt(file)).toBe("");

    await fs.writeFile(file, JSON.stringify({ personalization: { tone: "friendly", customInstructions: "Keep it short." } }));
    expect(await loadPersonalizationPrompt(file)).toContain("Keep it short.");

    await fs.writeFile(file, JSON.stringify({ personalization: { tone: "professional", customInstructions: "Use exact terms." } }));
    const refreshed = await loadPersonalizationPrompt(file);
    expect(refreshed).toContain("professional");
    expect(refreshed).toContain("Use exact terms.");

    await fs.writeFile(file, "not json");
    expect(await loadPersonalizationPrompt(file)).toBe("");
  });

  it("falls back from unknown tones and drops overlong stored instructions", async () => {
    await fs.writeFile(file, JSON.stringify({
      personalization: { tone: "dramatic", customInstructions: "😀".repeat(1_501) },
    }));
    expect(await loadPersonalizationPrompt(file)).toBe("");
  });
});
