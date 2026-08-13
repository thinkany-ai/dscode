/*
 * Protocol implementation derived from @tencent-weixin/openclaw-weixin 2.4.6.
 * Copyright (c) Tencent. Distributed under the MIT License.
 *
 * Only the iLink wire protocol is carried here; no OpenClaw runtime code is
 * included. DSCode connects directly to Tencent over outbound HTTPS.
 */
import crypto, { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

export const FIXED_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const CHANNEL_VERSION = "2.4.6";
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

export interface CdnMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string }
export interface MessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: { title?: string; message_item?: MessageItem };
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number };
  voice_item?: { media?: CdnMedia; encode_type?: number; playtime?: number; text?: string };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia; video_size?: number; play_length?: number };
}
export interface ILinkMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}
export interface LoginCredentials { token: string; accountId: string; userId: string; baseUrl: string }
export type LoginPollResult =
  | { state: "waiting" | "scanned" | "verify-required" | "expired"; message: string }
  | { state: "connected"; message: string; credentials: LoginCredentials }
  | { state: "error"; message: string };

function isAllowedTencentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return ["qq.com", "wechat.com", "qpic.cn", "gtimg.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function assertTencentHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !isAllowedTencentHost(url.hostname) || url.username || url.password) {
    throw new Error("微信服务返回了不受信任的地址");
  }
  return url;
}

function randomWechatUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function headers(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function baseInfo(appVersion: string) {
  return { channel_version: CHANNEL_VERSION, bot_agent: `DSCode/${appVersion.replace(/[^A-Za-z0-9_.+-]/g, "-").slice(0, 32)}` };
}

async function requestJson<T>(options: {
  baseUrl: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  const base = assertTencentHttpsUrl(options.baseUrl);
  const url = new URL(options.endpoint, base.href.endsWith("/") ? base.href : `${base.href}/`);
  assertTencentHttpsUrl(url.href);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, {
    method: options.method ?? "POST",
    headers: options.method === "GET"
      ? { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION) }
      : headers(options.token),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal,
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`微信接口请求失败 (${response.status})`);
  try { return JSON.parse(text) as T; }
  catch { throw new Error("微信接口返回了无效数据"); }
}

interface ActiveLogin {
  id: string;
  qrCode: string;
  qrContent: string;
  baseUrl: string;
  verifyCode?: string;
  expiresAt: number;
}

export class WeixinLoginManager {
  private readonly sessions = new Map<string, ActiveLogin>();
  constructor(private readonly appVersion: string) {}

  async start(localTokenList: string[] = []): Promise<ActiveLogin> {
    const response = await requestJson<{ qrcode?: string; qrcode_img_content?: string }>({
      baseUrl: FIXED_ILINK_BASE_URL,
      endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
      body: { local_token_list: localTokenList.slice(-10) },
      timeoutMs: 15_000,
    });
    if (!response.qrcode || !response.qrcode_img_content) throw new Error("微信没有返回二维码");
    const session: ActiveLogin = {
      id: randomUUID(),
      qrCode: response.qrcode,
      qrContent: response.qrcode_img_content,
      baseUrl: FIXED_ILINK_BASE_URL,
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  submitVerifyCode(id: string, code: string): void {
    const session = this.require(id);
    if (!/^\d{1,8}$/.test(code.trim())) throw new Error("请输入微信中显示的数字验证码");
    session.verifyCode = code.trim();
  }

  async poll(id: string): Promise<LoginPollResult> {
    const session = this.require(id);
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(id);
      return { state: "expired", message: "二维码已过期，请重新生成" };
    }
    const query = new URLSearchParams({ qrcode: session.qrCode });
    if (session.verifyCode) query.set("verify_code", session.verifyCode);
    let response: {
      status?: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string;
      baseurl?: string; redirect_host?: string;
    };
    try {
      response = await requestJson({
        baseUrl: session.baseUrl,
        endpoint: `ilink/bot/get_qrcode_status?${query}`,
        method: "GET",
        timeoutMs: 35_000,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { state: "waiting", message: "等待扫码" };
      }
      throw error;
    }
    if (response.status === "scaned_but_redirect" && response.redirect_host) {
      session.baseUrl = assertTencentHttpsUrl(`https://${response.redirect_host}`).origin;
      return { state: "scanned", message: "已扫码，正在切换微信接入点" };
    }
    if (response.status === "scaned") {
      session.verifyCode = undefined;
      return { state: "scanned", message: "已扫码，正在确认" };
    }
    if (response.status === "need_verifycode") return { state: "verify-required", message: "请输入微信中显示的数字验证码" };
    if (response.status === "verify_code_blocked") return { state: "error", message: "验证码错误次数过多，请重新生成二维码" };
    if (response.status === "expired") return { state: "expired", message: "二维码已过期，请重新生成" };
    if (response.status === "binded_redirect") return { state: "error", message: "该 Bot 已绑定，但本机没有可恢复的凭据" };
    if (response.status !== "confirmed") return { state: "waiting", message: "等待扫码" };
    if (!response.bot_token || !response.ilink_bot_id || !response.ilink_user_id) {
      return { state: "error", message: "微信确认成功，但返回的账号信息不完整" };
    }
    this.sessions.delete(id);
    return {
      state: "connected",
      message: "微信 Bot 已连接",
      credentials: {
        token: response.bot_token,
        accountId: response.ilink_bot_id,
        userId: response.ilink_user_id,
        baseUrl: assertTencentHttpsUrl(response.baseurl || session.baseUrl).origin,
      },
    };
  }

  private require(id: string): ActiveLogin {
    const session = this.sessions.get(id);
    if (!session) throw new Error("登录会话不存在或已过期");
    return session;
  }
}

export class WeixinApi {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    private readonly appVersion: string,
    readonly cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  ) { assertTencentHttpsUrl(baseUrl); assertTencentHttpsUrl(cdnBaseUrl); }

  async getUpdates(buffer: string, signal?: AbortSignal) {
    try {
      return await requestJson<{ ret?: number; errcode?: number; errmsg?: string; msgs?: ILinkMessage[]; get_updates_buf?: string }>({
        baseUrl: this.baseUrl,
        endpoint: "ilink/bot/getupdates",
        token: this.token,
        body: { get_updates_buf: buffer, base_info: baseInfo(this.appVersion) },
        timeoutMs: 35_000,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
        return { ret: 0, msgs: [], get_updates_buf: buffer };
      }
      throw error;
    }
  }

  async notifyStart(): Promise<void> { await this.simple("ilink/bot/msg/notifystart"); }
  async notifyStop(): Promise<void> { await this.simple("ilink/bot/msg/notifystop"); }

  async sendText(to: string, text: string, contextToken?: string, clientId = `dscode-${randomUUID()}`): Promise<string> {
    await this.sendItem(to, { type: MessageItemType.TEXT, text_item: { text } }, contextToken, clientId);
    return clientId;
  }

  async sendItem(to: string, item: MessageItem, contextToken?: string, clientId = `dscode-${randomUUID()}`): Promise<string> {
    const response = await requestJson<{ ret?: number; errmsg?: string }>({
      baseUrl: this.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: this.token,
      timeoutMs: 15_000,
      body: {
        msg: { from_user_id: "", to_user_id: to, client_id: clientId, message_type: 2, message_state: 2,
          item_list: [item], context_token: contextToken },
        base_info: baseInfo(this.appVersion),
      },
    });
    if (response.ret && response.ret !== 0) throw new Error(`微信发送失败: ${response.errmsg ?? response.ret}`);
    return clientId;
  }

  async sendTyping(to: string, ticket: string, typing: boolean): Promise<void> {
    await requestJson({ baseUrl: this.baseUrl, endpoint: "ilink/bot/sendtyping", token: this.token, timeoutMs: 10_000,
      body: { ilink_user_id: to, typing_ticket: ticket, status: typing ? 1 : 2, base_info: baseInfo(this.appVersion) } });
  }

  async getTypingTicket(to: string, contextToken?: string): Promise<string | undefined> {
    const response = await requestJson<{ typing_ticket?: string }>({ baseUrl: this.baseUrl, endpoint: "ilink/bot/getconfig", token: this.token,
      timeoutMs: 10_000, body: { ilink_user_id: to, context_token: contextToken, base_info: baseInfo(this.appVersion) } });
    return response.typing_ticket;
  }

  async upload(filePath: string, to: string): Promise<{ item: MessageItem; mediaType: string; size: number }> {
    const real = await fs.realpath(filePath);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("只能发送文件");
    if (stat.size > WEIXIN_MEDIA_MAX_BYTES) throw new Error("微信附件不能超过 100 MB");
    const buffer = await fs.readFile(real);
    const extension = path.extname(real).toLowerCase();
    const kind = imageExtensions.has(extension) ? "image" : videoExtensions.has(extension) ? "video" : "file";
    const mediaType = kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE;
    const aesKey = crypto.randomBytes(16);
    const fileKey = crypto.randomBytes(16).toString("hex");
    const ciphertext = encryptAesEcb(buffer, aesKey);
    const upload = await requestJson<{ upload_full_url?: string; upload_param?: string }>({
      baseUrl: this.baseUrl, endpoint: "ilink/bot/getuploadurl", token: this.token, timeoutMs: 15_000,
      body: { filekey: fileKey, media_type: mediaType, to_user_id: to, rawsize: buffer.length,
        rawfilemd5: crypto.createHash("md5").update(buffer).digest("hex"), filesize: ciphertext.length,
        no_need_thumb: true, aeskey: aesKey.toString("hex"), base_info: baseInfo(this.appVersion) },
    });
    const uploadUrl = upload.upload_full_url
      ? assertTencentHttpsUrl(upload.upload_full_url).href
      : `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param ?? "")}&filekey=${fileKey}`;
    let response: Response | undefined;
    let uploadError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(assertTencentHttpsUrl(uploadUrl), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(ciphertext), redirect: "error" });
        if (response.status >= 400 && response.status < 500) throw new Error(`微信 CDN 上传被拒绝 (${response.status})`);
        if (response.ok) break;
        uploadError = new Error(`微信 CDN 上传失败 (${response.status})`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("被拒绝")) throw error;
        uploadError = error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    if (!response?.ok) throw uploadError instanceof Error ? uploadError : new Error("微信 CDN 上传失败");
    const download = response.headers.get("x-encrypted-param");
    if (!download) throw new Error("微信 CDN 没有返回下载凭据");
    const media: CdnMedia = { encrypt_query_param: download, aes_key: Buffer.from(aesKey.toString("hex"), "ascii").toString("base64"), encrypt_type: 1 };
    const item: MessageItem = kind === "image"
      ? { type: MessageItemType.IMAGE, image_item: { media, mid_size: ciphertext.length } }
      : kind === "video"
        ? { type: MessageItemType.VIDEO, video_item: { media, video_size: ciphertext.length } }
        : { type: MessageItemType.FILE, file_item: { media, file_name: path.basename(real), len: String(buffer.length) } };
    return { item, mediaType: kind, size: buffer.length };
  }

  async download(item: MessageItem): Promise<{ buffer: Buffer; name: string; mimeType: string; kind: "image" | "voice" | "file" | "video" } | undefined> {
    const kind = item.type === MessageItemType.IMAGE ? "image" : item.type === MessageItemType.VOICE ? "voice" : item.type === MessageItemType.FILE ? "file" : item.type === MessageItemType.VIDEO ? "video" : undefined;
    if (!kind) return undefined;
    const media = kind === "image" ? item.image_item?.media : kind === "voice" ? item.voice_item?.media : kind === "file" ? item.file_item?.media : item.video_item?.media;
    if (!media || (!media.full_url && !media.encrypt_query_param)) return undefined;
    const url = media.full_url ?? `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? "")}`;
    const response = await fetch(assertTencentHttpsUrl(url), { redirect: "error" });
    if (!response.ok) throw new Error(`微信附件下载失败 (${response.status})`);
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > WEIXIN_MEDIA_MAX_BYTES + 16) throw new Error("微信附件超过 100 MB");
    let buffer: Buffer<ArrayBufferLike> = encrypted;
    const keyText = kind === "image" && item.image_item?.aeskey
      ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
      : media.aes_key;
    if (keyText) buffer = decryptAesEcb(encrypted, parseAesKey(keyText));
    const name = kind === "file" ? (item.file_item?.file_name || "file.bin") : `${kind}-${Date.now()}${kind === "image" ? ".jpg" : kind === "voice" ? ".silk" : ".mp4"}`;
    return { buffer, name, mimeType: mimeFromName(name, kind), kind };
  }

  private async simple(endpoint: string): Promise<void> {
    await requestJson({ baseUrl: this.baseUrl, endpoint, token: this.token, timeoutMs: 10_000, body: { base_info: baseInfo(this.appVersion) } });
  }
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

function encryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}
function decryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}
function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new Error("微信附件的 AES 密钥无效");
}
function mimeFromName(name: string, kind: string): string {
  const ext = path.extname(name).toLowerCase();
  const values: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".zip": "application/zip", ".mp4": "video/mp4", ".wav": "audio/wav", ".silk": "audio/silk" };
  return values[ext] ?? (kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : kind === "voice" ? "audio/silk" : "application/octet-stream");
}
