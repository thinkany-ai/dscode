import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTencentHttpsUrl, WeixinLoginManager } from "./protocol";

afterEach(() => vi.unstubAllGlobals());

describe("Weixin iLink protocol", () => {
  it("accepts only Tencent HTTPS endpoints", () => {
    expect(assertTencentHttpsUrl("https://ilinkai.weixin.qq.com").hostname).toBe("ilinkai.weixin.qq.com");
    expect(assertTencentHttpsUrl("https://novac2c.cdn.weixin.qq.com/c2c").hostname).toBe("novac2c.cdn.weixin.qq.com");
    expect(() => assertTencentHttpsUrl("http://ilinkai.weixin.qq.com")).toThrow(/不受信任/);
    expect(() => assertTencentHttpsUrl("https://weixin.qq.com.evil.example")).toThrow(/不受信任/);
    expect(() => assertTencentHttpsUrl("https://user:pass@ilinkai.weixin.qq.com")).toThrow(/不受信任/);
  });

  it("performs QR creation and returns confirmed credentials", async () => {
    const responses = [
      { qrcode: "secret-qr", qrcode_img_content: "https://weixin.qq.com/x/connect/qrconnect" },
      { status: "confirmed", bot_token: "token", ilink_bot_id: "bot-id", ilink_user_id: "user-id", baseurl: "https://ilinkai.weixin.qq.com" },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const login = new WeixinLoginManager("0.1.0");
    const session = await login.start();
    const result = await login.poll(session.id);
    expect(result).toMatchObject({ state: "connected", credentials: { accountId: "bot-id", userId: "user-id", token: "token" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(firstHeaders["iLink-App-Id"]).toBe("bot");
    expect(firstHeaders.Authorization).toBeUndefined();
  });

  it("requires numeric verification codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ qrcode: "qr", qrcode_img_content: "content" }), { status: 200 })));
    const login = new WeixinLoginManager("0.1.0");
    const session = await login.start();
    expect(() => login.submitVerifyCode(session.id, "abc")).toThrow(/数字验证码/);
    expect(() => login.submitVerifyCode(session.id, "123456")).not.toThrow();
  });
});
