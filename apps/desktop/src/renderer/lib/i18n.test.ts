import { describe, expect, it } from "vitest";
import { localizeExtensionUiRequest, resolveLocale } from "./i18n";

describe("resolveLocale", () => {
  it("uses an explicit language", () => {
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("follows Chinese system locales", () => {
    expect(resolveLocale("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLocale("system", "zh-TW")).toBe("zh-CN");
  });

  it("falls back to English for other system locales", () => {
    expect(resolveLocale("system", "ja-JP")).toBe("en");
  });
});

describe("localizeExtensionUiRequest", () => {
  const request = {
    type: "extension_ui_request" as const,
    id: "network-access",
    method: "select" as const,
    title: "Allow network access?\ncurl https://example.com/a-very-long-url\nCurrent: Seatbelt workspace-write",
    options: ["Allow once", "Allow this command for this session", "Deny"],
  };

  it("localizes network access prompts without changing response values", () => {
    expect(localizeExtensionUiRequest(request, "zh-CN")).toEqual({
      title: "允许访问网络吗？\ncurl https://example.com/a-very-long-url\n当前：Seatbelt 工作区可写",
      message: undefined,
      options: [
        { value: "Allow once", label: "仅允许一次" },
        { value: "Allow this command for this session", label: "本次会话中允许此命令" },
        { value: "Deny", label: "拒绝" },
      ],
    });
  });

  it("keeps English prompts unchanged", () => {
    expect(localizeExtensionUiRequest(request, "en")).toEqual({
      title: request.title,
      message: undefined,
      options: request.options.map((value) => ({ value, label: value })),
    });
  });
});
