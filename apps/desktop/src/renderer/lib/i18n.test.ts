import { describe, expect, it } from "vitest";
import { resolveLocale } from "./i18n";

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
