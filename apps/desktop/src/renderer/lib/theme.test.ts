import { afterEach, describe, expect, it } from "vitest";
import type { ThemeBootstrap, ThemeSummary } from "../../shared/types";
import { applyThemeBootstrap, chooseOnAccent } from "./theme";

function installDocumentStub() {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset,
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
      },
    },
  });
  return { properties, dataset };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
});

describe("renderer themes", () => {
  it("chooses a readable foreground for light and dark accents", () => {
    expect(chooseOnAccent("#282825", "light")).toBe("#ffffff");
    expect(chooseOnAccent("#ededeb", "dark")).toBe("#1e1e1c");
  });

  it("applies and clears custom theme overrides", () => {
    const { properties, dataset } = installDocumentStub();
    const theme: ThemeSummary = {
      id: "night",
      displayName: "Night",
      mode: "dark",
      palette: {
        canvas: "#111111", surface: "#181818", raised: "#202020", text: "#ffffff",
        muted: "#aaaaaa", accent: "#7788ff", border: "#333333", focus: "#99aaff",
        success: "#66bb88", warning: "#ddaa55", danger: "#ee7777",
      },
    };
    applyThemeBootstrap({ preference: { source: "custom", id: "night" }, resolvedMode: "dark", themes: [theme], activeTheme: theme });
    expect(dataset).toMatchObject({ themeSource: "custom", colorMode: "dark", codexTheme: "night" });
    expect(properties.get("--canvas")).toBe("#111111");
    expect(properties.get("--on-accent")).toBe("#1e1e1c");

    const system: ThemeBootstrap = { preference: { source: "system" }, resolvedMode: "light", themes: [theme], activeTheme: null };
    applyThemeBootstrap(system);
    expect(dataset.themeSource).toBe("system");
    expect(dataset.colorMode).toBeUndefined();
    expect(dataset.codexTheme).toBeUndefined();
    expect(properties.has("--canvas")).toBe(false);
  });
});
