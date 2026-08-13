import { describe, expect, it } from "vitest";
import { isPreviewPathInWorkspace, previewPathsFromText } from "./file-preview";

describe("previewPathsFromText", () => {
  it("finds generated files mentioned in an assistant reply", () => {
    expect(previewPathsFromText("文件：`tetris.html`（单文件，双击即玩）")).toEqual(["tetris.html"]);
  });

  it("finds workspace paths in Markdown links and command output", () => {
    const text = "查看 [页面](src/demo/index.html)\nWrote assets/theme.css and preview.png";
    expect(previewPathsFromText(text)).toEqual([
      "src/demo/index.html",
      "assets/theme.css",
      "preview.png",
    ]);
  });

  it("ignores web links and prose", () => {
    expect(previewPathsFromText("打开 https://example.com/demo.html，处理完成。"))
      .toEqual([]);
  });

  it("keeps inferred preview paths inside the active workspace", () => {
    expect(isPreviewPathInWorkspace("src/demo/index.html", "/Users/demo/dscode-desktop")).toBe(true);
    expect(isPreviewPathInWorkspace("assets/../preview.png", "/Users/demo/dscode-desktop")).toBe(true);
    expect(isPreviewPathInWorkspace("../outside.md", "/Users/demo/dscode-desktop")).toBe(false);
    expect(isPreviewPathInWorkspace("/Users/demo/dscode-desktop/AGENTS.md", "/Users/demo/dscode-desktop")).toBe(true);
    expect(isPreviewPathInWorkspace("/Users/demo/dscode/AGENTS.md", "/Users/demo/dscode-desktop")).toBe(false);
    expect(isPreviewPathInWorkspace("/Users/demo/dscode-desktop-old/AGENTS.md", "/Users/demo/dscode-desktop")).toBe(false);
  });

  it("compares Windows workspace paths without case sensitivity", () => {
    expect(isPreviewPathInWorkspace("C:\\Code\\DSCode\\README.md", "c:\\code\\dscode")).toBe(true);
    expect(isPreviewPathInWorkspace("C:\\Code\\Other\\README.md", "c:\\code\\dscode")).toBe(false);
  });
});
