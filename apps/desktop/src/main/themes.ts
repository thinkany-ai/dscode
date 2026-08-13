import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThemePalette, ThemeSummary } from "../shared/types";

/**
 * Codexthemes (https://codexthemes.ai) publishes community themes as folders under
 * ~/.codexthemes/themes/<id>/theme.json. DSCode Desktop reuses the same palette
 * schema (canvas/surface/raised/text/muted/accent/border/focus/success/warning/danger)
 * and remaps it onto its own CSS custom properties, since the native theme.css files
 * target a different app's DOM structure.
 */
const THEMES_ROOT = path.join(os.homedir(), ".codexthemes", "themes");

export async function listCodexThemes(root: string = THEMES_ROOT): Promise<ThemeSummary[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const themes = (await Promise.all(entries.map((name) => readTheme(root, name))))
    .filter((theme): theme is ThemeSummary => Boolean(theme));
  themes.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return themes;
}

async function readTheme(root: string, folderName: string): Promise<ThemeSummary | undefined> {
  try {
    const themeRoot = path.join(root, folderName);
    const raw = await fs.readFile(path.join(themeRoot, "theme.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const palette = normalizePalette(parsed.palette);
    if (!palette) return undefined;
    const previewDataUrl = await readThemePreview(themeRoot, parsed.preview);
    return {
      id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : folderName,
      displayName: typeof parsed.displayName === "string" && parsed.displayName.trim() ? parsed.displayName : folderName,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      ...(previewDataUrl ? { previewDataUrl } : {}),
      mode: parsed.mode === "dark" ? "dark" : "light",
      palette,
    };
  } catch {
    return undefined;
  }
}

async function readThemePreview(themeRoot: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const resolvedRoot = path.resolve(themeRoot);
  const previewPath = path.resolve(resolvedRoot, value);
  if (!previewPath.startsWith(`${resolvedRoot}${path.sep}`)) return undefined;

  try {
    const stat = await fs.stat(previewPath);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return undefined;
    const { nativeImage } = await import("electron");
    const source = nativeImage.createFromPath(previewPath);
    if (source.isEmpty()) return undefined;
    const width = Math.min(source.getSize().width, 640);
    return source.resize({ width, quality: "good" }).toDataURL();
  } catch {
    return undefined;
  }
}

function normalizePalette(value: unknown): ThemePalette | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  const canvas = str("canvas");
  const surface = str("surface");
  const text = str("text");
  const accent = str("accent");
  if (!canvas || !surface || !text || !accent) return undefined;
  const muted = str("muted") ?? text;
  const border = str("border") ?? muted;
  return {
    canvas,
    surface,
    raised: str("raised") ?? surface,
    text,
    muted,
    accent,
    border,
    focus: str("focus") ?? accent,
    success: str("success") ?? "#3fb27f",
    warning: str("warning") ?? "#c98a2c",
    danger: str("danger") ?? "#c9433c",
    terminalBackground: str("terminalBackground"),
    terminalForeground: str("terminalForeground"),
  };
}
