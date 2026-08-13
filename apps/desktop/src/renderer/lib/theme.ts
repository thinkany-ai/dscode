import type { ThemeBootstrap, ThemeMode, ThemeSummary } from "../../shared/types";

const OVERRIDDEN_PROPERTIES = [
  "color-scheme",
  "--canvas",
  "--sidebar",
  "--surface",
  "--surface-raised",
  "--ink",
  "--muted",
  "--faint",
  "--line",
  "--line-soft",
  "--hover",
  "--selected",
  "--accent",
  "--on-accent",
  "--link",
  "--focus",
  "--danger",
  "--warning",
  "--success",
  "--shadow",
  "--shadow-soft",
  "--shadow-panel",
  "--code-bg",
  "--composer-border",
  "--backdrop",
  "--preview-frame-bg",
  "--tree-ink",
  "--tree-muted",
  "--tree-hover",
  "--tree-selected",
];

let initialThemeBootstrap: ThemeBootstrap | undefined;

export function setInitialThemeBootstrap(bootstrap: ThemeBootstrap): void {
  initialThemeBootstrap = bootstrap;
  applyThemeBootstrap(bootstrap);
}

export function getInitialThemeBootstrap(): ThemeBootstrap {
  if (!initialThemeBootstrap) throw new Error("Theme bootstrap has not been initialized");
  return initialThemeBootstrap;
}

export function applyThemeBootstrap(bootstrap: ThemeBootstrap): void {
  const root = document.documentElement;
  root.dataset.themeSource = bootstrap.preference.source;
  if (bootstrap.preference.source === "system") delete root.dataset.colorMode;
  else root.dataset.colorMode = bootstrap.resolvedMode;
  applyTheme(bootstrap.activeTheme);
}

/**
 * Applies a codexthemes-compatible palette (~/.codexthemes/themes/<id>/theme.json)
 * onto DSCode Desktop's own CSS custom properties. The native theme.css assets are
 * built for a different app's DOM, so only the shared palette schema is reused.
 */
export function applyTheme(theme: ThemeSummary | null): void {
  const root = document.documentElement;
  if (!theme) {
    for (const property of OVERRIDDEN_PROPERTIES) root.style.removeProperty(property);
    delete root.dataset.codexTheme;
    return;
  }
  const { palette, mode } = theme;
  const set = (property: string, value: string) => root.style.setProperty(property, value);
  set("color-scheme", mode);
  set("--canvas", palette.canvas);
  set("--sidebar", palette.surface);
  set("--surface", palette.raised);
  set("--surface-raised", `color-mix(in srgb, ${palette.surface} 45%, ${palette.raised})`);
  set("--ink", palette.text);
  set("--muted", palette.muted);
  set("--faint", `color-mix(in srgb, ${palette.muted} 84%, ${palette.text})`);
  set("--line", palette.border);
  set("--line-soft", `color-mix(in srgb, ${palette.border} 55%, transparent)`);
  set("--hover", `color-mix(in srgb, ${palette.text} 8%, ${palette.canvas})`);
  set("--selected", `color-mix(in srgb, ${palette.accent} 16%, ${palette.canvas})`);
  set("--accent", palette.accent);
  set("--on-accent", chooseOnAccent(palette.accent, mode));
  set("--link", `color-mix(in srgb, ${palette.focus} 72%, ${palette.text})`);
  set("--focus", palette.focus);
  set("--danger", palette.danger);
  set("--warning", palette.warning);
  set("--success", palette.success);
  set("--code-bg", `color-mix(in srgb, ${palette.surface} 72%, ${palette.canvas})`);
  set("--composer-border", `color-mix(in srgb, ${palette.border} 78%, ${palette.text})`);
  set("--backdrop", mode === "dark" ? "rgba(0, 0, 0, .46)" : "rgba(33, 33, 29, .20)");
  set("--preview-frame-bg", mode === "dark" ? "#191918" : "#ffffff");
  set("--tree-ink", palette.text);
  set("--tree-muted", palette.muted);
  set("--tree-hover", `color-mix(in srgb, ${palette.text} 7%, transparent)`);
  set("--tree-selected", `color-mix(in srgb, ${palette.text} 11%, transparent)`);
  set(
    "--shadow",
    mode === "dark"
      ? "0 14px 42px rgba(0, 0, 0, .5), 0 2px 7px rgba(0, 0, 0, .35)"
      : "0 14px 42px rgba(34, 34, 30, 0.13), 0 2px 7px rgba(34, 34, 30, 0.08)",
  );
  set("--shadow-soft", mode === "dark" ? "0 2px 8px rgba(0, 0, 0, .24)" : "0 2px 8px rgba(34, 34, 30, .08)");
  set("--shadow-panel", mode === "dark" ? "0 14px 38px rgba(0, 0, 0, .38)" : "0 14px 38px rgba(34, 34, 30, .14)");
  root.dataset.codexTheme = theme.id;
}

export function chooseOnAccent(color: string, mode: ThemeMode): string {
  const rgb = parseColor(color);
  if (!rgb) return mode === "dark" ? "#1e1e1c" : "#ffffff";
  const luminance = relativeLuminance(rgb);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkLuminance = relativeLuminance([30, 30, 28]);
  const darkContrast = (luminance + 0.05) / (darkLuminance + 0.05);
  return whiteContrast >= darkContrast ? "#ffffff" : "#1e1e1c";
}

function parseColor(color: string): [number, number, number] | undefined {
  const trimmed = color.trim();
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i);
  if (rgbMatch) {
    return rgbMatch.slice(1, 4).map((value) => Math.max(0, Math.min(255, Number(value)))) as [number, number, number];
  }
  const value = trimmed.replace(/^#/, "");
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return undefined;
  const hex = value.length === 3 ? value.split("").map((part) => `${part}${part}`).join("") : value;
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
