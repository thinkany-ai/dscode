import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguagePreference, UserProfile } from "../shared/types";

interface AppSettingsData {
  themeId?: string | null;
  language?: LanguagePreference;
  profile?: UserProfile;
}

const LANGUAGE_PREFERENCES = new Set<LanguagePreference>(["system", "zh-CN", "en"]);

export class AppSettings {
  constructor(
    private readonly file: string,
    private readonly defaultNickname: string = systemNickname(),
  ) {}

  async getThemeId(): Promise<string | null> {
    const data = await this.read();
    return typeof data.themeId === "string" ? data.themeId : null;
  }

  async setThemeId(themeId: string | null): Promise<void> {
    const data = await this.read();
    data.themeId = themeId;
    await this.write(data);
  }

  async getLanguage(): Promise<LanguagePreference> {
    const data = await this.read();
    return data.language && LANGUAGE_PREFERENCES.has(data.language) ? data.language : "system";
  }

  async setLanguage(language: LanguagePreference): Promise<void> {
    if (!LANGUAGE_PREFERENCES.has(language)) throw new Error("Unsupported language preference");
    const data = await this.read();
    data.language = language;
    await this.write(data);
  }

  async getProfile(): Promise<UserProfile> {
    const data = await this.read();
    const storedNickname = typeof data.profile?.nickname === "string" ? data.profile.nickname.trim() : "";
    const nickname = (storedNickname || this.defaultNickname.trim() || "User").slice(0, 60);
    const avatarDataUrl = isValidAvatarDataUrl(data.profile?.avatarDataUrl) ? data.profile.avatarDataUrl : undefined;
    return { nickname, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
  }

  async setProfile(profile: UserProfile): Promise<void> {
    const nickname = profile.nickname.trim();
    if (!nickname) throw new Error("Nickname is required");
    if (nickname.length > 60) throw new Error("Nickname must be 60 characters or fewer");
    if (profile.avatarDataUrl !== undefined && !isValidAvatarDataUrl(profile.avatarDataUrl)) {
      throw new Error("Unsupported avatar image");
    }
    const data = await this.read();
    data.profile = { nickname, ...(profile.avatarDataUrl ? { avatarDataUrl: profile.avatarDataUrl } : {}) };
    await this.write(data);
  }

  private async read(): Promise<AppSettingsData> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") return parsed as AppSettingsData;
      return {};
    } catch {
      return {};
    }
  }

  private async write(data: AppSettingsData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }
}

function systemNickname(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "User";
  }
}

function isValidAvatarDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 1_000_000
    && /^data:image\/(?:png|jpeg|webp);base64,/.test(value);
}
