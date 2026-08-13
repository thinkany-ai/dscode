import type { ThemeSummary } from "../../shared/types";

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
  "--focus",
  "--danger",
  "--warning",
  "--success",
  "--shadow",
];

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
  set("--faint", `color-mix(in srgb, ${palette.muted} 65%, ${palette.canvas})`);
  set("--line", palette.border);
  set("--line-soft", `color-mix(in srgb, ${palette.border} 55%, transparent)`);
  set("--hover", `color-mix(in srgb, ${palette.text} 8%, ${palette.canvas})`);
  set("--selected", `color-mix(in srgb, ${palette.accent} 16%, ${palette.canvas})`);
  set("--accent", palette.accent);
  set("--focus", palette.focus);
  set("--danger", palette.danger);
  set("--warning", palette.warning);
  set("--success", palette.success);
  set(
    "--shadow",
    mode === "dark"
      ? "0 14px 42px rgba(0, 0, 0, .5), 0 2px 7px rgba(0, 0, 0, .35)"
      : "0 14px 42px rgba(34, 34, 30, 0.13), 0 2px 7px rgba(34, 34, 30, 0.08)",
  );
  root.dataset.codexTheme = theme.id;
}