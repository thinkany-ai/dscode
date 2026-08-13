import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCodexThemes, resolveThemeBootstrap } from "./themes";

describe("listCodexThemes", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codexthemes-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty list when the themes folder does not exist", async () => {
    expect(await listCodexThemes(path.join(root, "missing"))).toEqual([]);
  });

  it("parses a valid theme.json and fills defaults for optional palette keys", async () => {
    const themeDir = path.join(root, "sample-theme");
    await fs.mkdir(themeDir, { recursive: true });
    await fs.writeFile(
      path.join(themeDir, "theme.json"),
      JSON.stringify({
        id: "sample-theme",
        displayName: "Sample Theme",
        description: "A test theme.",
        mode: "dark",
        palette: {
          canvas: "#0a0a0a",
          surface: "#111111",
          text: "#f5f5f5",
          accent: "#ff6600",
        },
      }),
    );

    const themes = await listCodexThemes(root);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id: "sample-theme",
      displayName: "Sample Theme",
      mode: "dark",
      palette: {
        canvas: "#0a0a0a",
        surface: "#111111",
        raised: "#111111",
        text: "#f5f5f5",
        muted: "#f5f5f5",
        accent: "#ff6600",
        border: "#f5f5f5",
        focus: "#ff6600",
      },
    });
  });

  it("skips folders missing required palette keys", async () => {
    const themeDir = path.join(root, "broken-theme");
    await fs.mkdir(themeDir, { recursive: true });
    await fs.writeFile(
      path.join(themeDir, "theme.json"),
      JSON.stringify({ id: "broken-theme", palette: { canvas: "#000" } }),
    );

    expect(await listCodexThemes(root)).toEqual([]);
  });

  it("skips folders with malformed JSON instead of throwing", async () => {
    const themeDir = path.join(root, "malformed-theme");
    await fs.mkdir(themeDir, { recursive: true });
    await fs.writeFile(path.join(themeDir, "theme.json"), "{not json");

    expect(await listCodexThemes(root)).toEqual([]);
  });

  it("resolves system and builtin preferences", () => {
    expect(resolveThemeBootstrap({ source: "system" }, [], true)).toMatchObject({
      preference: { source: "system" },
      resolvedMode: "dark",
      activeTheme: null,
    });
    expect(resolveThemeBootstrap({ source: "builtin", mode: "light" }, [], true)).toMatchObject({
      preference: { source: "builtin", mode: "light" },
      resolvedMode: "light",
      activeTheme: null,
    });
  });

  it("resolves installed custom themes and falls back when one disappears", () => {
    const theme = {
      id: "night",
      displayName: "Night",
      mode: "dark" as const,
      palette: {
        canvas: "#111111", surface: "#181818", raised: "#202020", text: "#ffffff",
        muted: "#aaaaaa", accent: "#7788ff", border: "#333333", focus: "#99aaff",
        success: "#66bb88", warning: "#ddaa55", danger: "#ee7777",
      },
    };
    expect(resolveThemeBootstrap({ source: "custom", id: "night" }, [theme], false)).toMatchObject({
      preference: { source: "custom", id: "night" },
      resolvedMode: "dark",
      activeTheme: theme,
    });
    expect(resolveThemeBootstrap({ source: "custom", id: "missing" }, [theme], false)).toMatchObject({
      preference: { source: "system" },
      resolvedMode: "light",
      activeTheme: null,
    });
  });
});
