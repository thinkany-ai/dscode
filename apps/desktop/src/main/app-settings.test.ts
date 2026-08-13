import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppSettings } from "./app-settings";

describe("AppSettings", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-settings-"));
    file = path.join(root, "app-settings.json");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("defaults to following the system", async () => {
    expect(await new AppSettings(file).getLanguage()).toBe("system");
  });

  it("persists language without replacing other settings", async () => {
    const settings = new AppSettings(file);
    await settings.setThemeId("paper");
    await settings.setLanguage("zh-CN");

    expect(await settings.getLanguage()).toBe("zh-CN");
    expect(await settings.getThemeId()).toBe("paper");
  });

  it("falls back to system for an unknown stored value", async () => {
    await fs.writeFile(file, JSON.stringify({ language: "fr" }));
    expect(await new AppSettings(file).getLanguage()).toBe("system");
  });

  it("hides the reasoning process by default and for invalid stored values", async () => {
    expect(await new AppSettings(file).getShowReasoningProcess()).toBe(false);

    await fs.writeFile(file, JSON.stringify({ showReasoningProcess: "yes" }));
    expect(await new AppSettings(file).getShowReasoningProcess()).toBe(false);
  });

  it("persists the reasoning process preference without replacing other settings", async () => {
    const settings = new AppSettings(file);
    await settings.setThemeId("paper");
    await settings.setLanguage("zh-CN");
    await settings.setShowReasoningProcess(true);

    expect(await settings.getShowReasoningProcess()).toBe(true);
    expect(await settings.getThemeId()).toBe("paper");
    expect(await settings.getLanguage()).toBe("zh-CN");
  });

  it("defaults personalization and falls back for invalid stored values", async () => {
    expect(await new AppSettings(file).getPersonalization()).toEqual({ tone: "default", customInstructions: "" });

    await fs.writeFile(file, JSON.stringify({
      personalization: { tone: "dramatic", customInstructions: "x".repeat(1_501) },
    }));
    expect(await new AppSettings(file).getPersonalization()).toEqual({ tone: "default", customInstructions: "" });
  });

  it("persists every supported tone without replacing other settings", async () => {
    const settings = new AppSettings(file);
    await settings.setLanguage("zh-CN");
    for (const tone of ["default", "professional", "friendly", "candid", "quirky", "efficient", "cynical", "inspiring"] as const) {
      await settings.setPersonalization({ tone, customInstructions: `Use ${tone}` });
      expect(await settings.getPersonalization()).toEqual({ tone, customInstructions: `Use ${tone}` });
    }
    expect(await settings.getLanguage()).toBe("zh-CN");
  });

  it("trims, clears, and validates custom instructions by Unicode character", async () => {
    const settings = new AppSettings(file);
    const boundary = "😀".repeat(1_500);
    await settings.setPersonalization({ tone: "friendly", customInstructions: `  ${boundary}  ` });
    expect(await settings.getPersonalization()).toEqual({ tone: "friendly", customInstructions: boundary });

    await expect(settings.setPersonalization({ tone: "friendly", customInstructions: `${boundary}😀` }))
      .rejects.toThrow("1500 characters or fewer");
    await expect(settings.setPersonalization({ tone: "unknown" as "default", customInstructions: "" }))
      .rejects.toThrow("Unsupported tone preset");

    await settings.setPersonalization({ tone: "default", customInstructions: "   " });
    expect(await settings.getPersonalization()).toEqual({ tone: "default", customInstructions: "" });
  });

  it("defaults the profile nickname to the system username", async () => {
    expect(await new AppSettings(file, "local-user").getProfile()).toEqual({ nickname: "local-user" });
  });

  it("persists a customized profile without replacing other settings", async () => {
    const settings = new AppSettings(file, "local-user");
    await settings.setLanguage("zh-CN");
    await settings.setProfile({ nickname: "Trys", avatarDataUrl: "data:image/png;base64,aA==" });

    expect(await settings.getProfile()).toEqual({ nickname: "Trys", avatarDataUrl: "data:image/png;base64,aA==" });
    expect(await settings.getLanguage()).toBe("zh-CN");
  });

  it("rejects an empty nickname and unsafe avatar formats", async () => {
    const settings = new AppSettings(file, "local-user");
    await expect(settings.setProfile({ nickname: "  " })).rejects.toThrow("Nickname is required");
    await expect(settings.setProfile({ nickname: "Trys", avatarDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" })).rejects.toThrow("Unsupported avatar image");
  });
});
