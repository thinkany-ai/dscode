import fs from "node:fs/promises";
import path from "node:path";

export interface WeixinSecretsData { token?: string; contextToken?: string }

export class WeixinSecrets {
  constructor(private readonly fallbackPath: string) {}

  async read(): Promise<WeixinSecretsData> {
    try {
      const keyring = await import("@napi-rs/keyring");
      const raw = new keyring.Entry("DSCode Weixin Bot", "singleton").getPassword();
      if (raw) return JSON.parse(raw) as WeixinSecretsData;
    } catch { /* use the private local fallback */ }
    try { return JSON.parse(await fs.readFile(this.fallbackPath, "utf8")) as WeixinSecretsData; }
    catch { return {}; }
  }

  async write(data: WeixinSecretsData): Promise<void> {
    try {
      const keyring = await import("@napi-rs/keyring");
      new keyring.Entry("DSCode Weixin Bot", "singleton").setPassword(JSON.stringify(data));
      await fs.rm(this.fallbackPath, { force: true });
      return;
    } catch { /* headless Linux may not expose a keyring */ }
    await fs.mkdir(path.dirname(this.fallbackPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.fallbackPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      const keyring = await import("@napi-rs/keyring");
      new keyring.Entry("DSCode Weixin Bot", "singleton").deletePassword();
    } catch { /* ignore unavailable keyring */ }
    await fs.rm(this.fallbackPath, { force: true });
  }
}
