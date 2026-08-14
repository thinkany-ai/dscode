import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { setDSCodeProjectTrusted } from "@thinkany/dscode-core";
import type {
  AgentSessionStats,
  WeixinBotEvent,
  WeixinBotStatus,
  WeixinHistoryPage,
  WeixinLoginSession,
  WeixinLoginState,
  WeixinMedia,
  WeixinMessage,
} from "../../shared/types";
import type { AppSettings } from "../app-settings";
import { AgentHost } from "../agent-host";
import { MessageItemType, WeixinApi, WeixinLoginManager, type ILinkMessage } from "./protocol";
import { WeixinSecrets } from "./secrets";
import { WeixinStore, type WeixinOutboxPayload } from "./store";

const COMPACT_AT = 60;
const HARD_COMPACT_AT = 75;
const CLEAR_CONFIRMATION = "清除微信 Bot 数据";

export class WeixinBotService {
  readonly store: WeixinStore;
  private readonly secrets: WeixinSecrets;
  private readonly login: WeixinLoginManager;
  private api?: WeixinApi;
  private pollAbort?: AbortController;
  private pollPromise?: Promise<void>;
  private agent?: AgentHost;
  private agentSignature?: string;
  private agentStats?: AgentSessionStats;
  private running = false;
  private operationQueue = Promise.resolve();
  private mediaOutboxOffset = 0;
  private readonly mediaOutboxPath: string;

  constructor(
    rootPath: string,
    private readonly appVersion: string,
    private readonly settings: AppSettings,
    private readonly emit: (event: WeixinBotEvent) => void,
  ) {
    this.store = new WeixinStore(rootPath);
    this.secrets = new WeixinSecrets(this.store.secretsFallbackPath);
    this.login = new WeixinLoginManager(appVersion);
    this.mediaOutboxPath = path.join(rootPath, "agent-media-outbox.jsonl");
  }

  async initialize(): Promise<void> {
    const state = this.store.getState();
    if (state.workspacePath) await this.validateWorkspace(state.workspacePath);
    const secret = await this.secrets.read();
    if (state.accountId && state.userId && state.baseUrl && secret.token && !state.paused) {
      await this.start().catch((error) => this.recordError(error));
    } else {
      await this.emitStatus();
    }
  }

  async getStatus(): Promise<WeixinBotStatus> {
    const state = this.store.getState();
    const defaults = await this.settings.getAgentDefaults();
    const secret = await this.secrets.read();
    const configured = Boolean(state.workspacePath);
    const hasLogin = Boolean(state.accountId && state.userId && state.baseUrl && secret.token);
    const connectionState = !configured ? "unconfigured"
      : !hasLogin ? (state.accountId ? "login-required" : "workspace-ready")
        : state.lastError ? "error" : this.api ? "online" : state.paused ? "paused" : "connecting";
    return {
      state: connectionState,
      ...(state.workspacePath ? { workspacePath: state.workspacePath } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.accountId ? { accountId: state.accountId } : {}),
      ...(state.userId ? { boundUserId: state.userId } : {}),
      online: Boolean(this.api),
      trusted: Boolean(state.trustedAt),
      autoLaunch: state.autoLaunch,
      running: this.running,
      unread: 0,
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(this.agentStats?.contextUsage ? { contextUsage: this.agentStats.contextUsage } : {}),
      compactionCount: state.compactionCount,
      mediaBytes: this.store.mediaBytes(),
      defaults,
    };
  }

  async configureWorkspace(candidate: string): Promise<void> {
    const current = this.store.getState();
    const real = await this.validateWorkspace(candidate);
    if (current.workspacePath && current.workspacePath !== real) {
      throw new Error("安全目录已锁定。更换目录前必须清除全部微信 Bot 数据");
    }
    setDSCodeProjectTrusted(real, true);
    this.store.patchState({ workspacePath: real, trustedAt: Date.now(), lastError: undefined });
    await this.emitStatus();
  }

  async startLogin(): Promise<WeixinLoginSession> {
    const state = this.store.getState();
    if (!state.workspacePath || !state.trustedAt) throw new Error("请先选择并信任安全目录");
    const old = await this.secrets.read();
    const session = await this.login.start(old.token ? [old.token] : []);
    return {
      sessionId: session.id,
      qrContent: session.qrContent,
      qrImageDataUrl: await QRCode.toDataURL(session.qrContent, { width: 280, margin: 1, errorCorrectionLevel: "M" }),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async waitLogin(sessionId: string): Promise<WeixinLoginState> {
    const result = await this.login.poll(sessionId);
    if (result.state !== "connected") return result;
    const state = this.store.getState();
    if (state.accountId && state.accountId !== result.credentials.accountId) {
      throw new Error("该微信账号与原绑定账号不一致。请先清除全部微信 Bot 数据");
    }
    if (state.userId && state.userId !== result.credentials.userId) {
      throw new Error("扫码微信身份与原绑定用户不一致。请先清除全部微信 Bot 数据");
    }
    await this.secrets.write({ token: result.credentials.token });
    this.store.patchState({
      accountId: result.credentials.accountId,
      userId: result.credentials.userId,
      baseUrl: result.credentials.baseUrl,
      paused: false,
      lastError: undefined,
    });
    await this.start();
    return { state: "connected", message: result.message };
  }

  submitVerifyCode(sessionId: string, code: string): void { this.login.submitVerifyCode(sessionId, code); }

  async start(): Promise<void> {
    if (this.api) return;
    const state = this.store.getState();
    const secret = await this.secrets.read();
    if (!state.workspacePath || !state.accountId || !state.userId || !state.baseUrl || !secret.token) {
      throw new Error("微信 Bot 尚未完成绑定");
    }
    this.api = new WeixinApi(state.baseUrl, secret.token, this.appVersion);
    this.store.patchState({ paused: false, lastError: undefined });
    await this.api.notifyStart().catch(() => undefined);
    await this.recoverDurableQueues();
    this.pollAbort = new AbortController();
    this.pollPromise = this.poll(this.pollAbort.signal);
    await this.emitStatus();
  }

  async pause(): Promise<void> {
    const api = this.api;
    this.api = undefined;
    this.pollAbort?.abort();
    await this.pollPromise?.catch(() => undefined);
    this.pollPromise = undefined;
    this.pollAbort = undefined;
    await api?.notifyStop().catch(() => undefined);
    this.store.patchState({ paused: true });
    await this.emitStatus();
  }

  async disconnect(): Promise<void> {
    await this.pause();
    await this.secrets.clear();
    this.store.patchState({ paused: false, lastError: undefined });
    await this.emitStatus();
  }

  history(query: { before?: number; limit?: number } = {}): WeixinHistoryPage {
    return this.store.history(query.before, query.limit);
  }

  async send(text: string, attachmentPaths: string[] = []): Promise<void> {
    const clean = text.trim();
    if (!clean && attachmentPaths.length === 0) return;
    const state = this.store.getState();
    if (!state.workspacePath) throw new Error("微信 Bot 尚未配置安全目录");
    for (const file of attachmentPaths) await this.validateWorkspaceFile(file, state.workspacePath);
    const message = this.addMessage({ direction: "outbound", source: "desktop", role: "user", text: clean, media: [], status: "processing" });
    this.enqueue(async () => {
      try {
        if (state.userId) {
          await this.sendTextReliable(state.userId, `🖥️ 桌面指令：${clean || "请查看附件"}`);
        }
        for (const file of attachmentPaths) await this.sendMedia(file, "", "desktop");
        this.updateMessage(message.id, "sent");
        await this.runAgent(clean || "请查看随消息附带的文件。", attachmentPaths);
      } catch (error) {
        this.updateMessage(message.id, "failed");
        await this.recordError(error);
      }
    });
  }

  async abortTurn(): Promise<void> { await this.agent?.request("abort").catch(() => undefined); }

  async setAutoLaunch(enabled: boolean): Promise<void> {
    this.store.patchState({ autoLaunch: enabled });
    await this.emitStatus();
  }

  async clearAllData(confirmation: string): Promise<void> {
    if (confirmation !== CLEAR_CONFIRMATION) throw new Error(`请输入“${CLEAR_CONFIRMATION}”确认`);
    await this.pause().catch(() => undefined);
    await this.agent?.stop().catch(() => undefined);
    this.agent = undefined;
    this.agentSignature = undefined;
    await this.secrets.clear();
    await this.store.clearAll();
    await fs.rm(this.mediaOutboxPath, { force: true });
    this.mediaOutboxOffset = 0;
    this.emit({ type: "history-reset" });
    await this.emitStatus();
  }

  async shutdown(): Promise<void> {
    await this.pause().catch(() => undefined);
    await this.agent?.stop().catch(() => undefined);
    this.store.close();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted && this.api) {
      const state = this.store.getState();
      try {
        const response = await this.api.getUpdates(state.updatesBuffer, signal);
        if (signal.aborted) break;
        if (response.errcode === -14 || response.ret === -14) throw new Error("微信登录已失效，请重新绑定");
        if (response.ret && response.ret !== 0) throw new Error(`微信同步失败: ${response.errmsg ?? response.ret}`);
        for (const message of response.msgs ?? []) await this.acceptInbound(message);
        if (response.get_updates_buf !== undefined) this.store.patchState({ updatesBuffer: response.get_updates_buf });
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        if (error instanceof Error && /登录已失效/.test(error.message)) {
          this.api = undefined;
          this.store.patchState({ lastError: error.message, paused: true });
          await this.emitStatus();
          break;
        }
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)) + Math.floor(Math.random() * 500);
        await abortableDelay(delay, signal);
      }
    }
  }

  private async acceptInbound(raw: ILinkMessage, recoveredPlatformId?: string): Promise<void> {
    const state = this.store.getState();
    if (!state.userId || raw.from_user_id !== state.userId || raw.message_type !== 1) return;
    const platformId = recoveredPlatformId ?? String(raw.message_id ?? raw.client_id ?? randomUUID());
    if (!recoveredPlatformId && !this.store.persistInbox(platformId, raw)) return;
    const normalized = await this.normalizeInbound(raw);
    const message = this.addMessage({ platformId, direction: "inbound", source: "weixin", role: "user", text: normalized.text, media: normalized.media, status: "processing" });
    const secret = await this.secrets.read();
    await this.secrets.write({ ...secret, ...(raw.context_token ? { contextToken: raw.context_token } : {}) });
    this.enqueue(async () => {
      try {
        this.updateMessage(message.id, "sent");
        await this.runAgent(normalized.prompt, normalized.media.map((item) => item.localPath).filter((value): value is string => Boolean(value)));
        this.store.completeInbox(platformId);
      } catch (error) {
        this.updateMessage(message.id, "failed");
        await this.recordError(error);
      }
    });
  }

  private async normalizeInbound(raw: ILinkMessage): Promise<{ text: string; prompt: string; media: WeixinMedia[] }> {
    const texts: string[] = [];
    const media: WeixinMedia[] = [];
    for (const item of raw.item_list ?? []) {
      if (item.ref_msg?.title) texts.push(`> 引用：${item.ref_msg.title}`);
      if (item.type === MessageItemType.TEXT && item.text_item?.text) texts.push(item.text_item.text);
      if (item.type === MessageItemType.VOICE && item.voice_item?.text) texts.push(`[语音转写] ${item.voice_item.text}`);
      if (item.type !== MessageItemType.TEXT && this.api) {
        const downloaded = await this.api.download(item).catch(() => undefined);
        if (downloaded) {
          let buffer = downloaded.buffer;
          let name = downloaded.name;
          let mimeType = downloaded.mimeType;
          if (downloaded.kind === "voice" && !item.voice_item?.text) {
            const wav = await transcodeSilk(buffer);
            if (wav) { buffer = wav; name = name.replace(/\.silk$/i, ".wav"); mimeType = "audio/wav"; }
          }
          const localPath = await this.store.saveMedia(buffer, name, "inbound");
          media.push({ kind: downloaded.kind, name, mimeType, size: buffer.length, localPath });
        }
      }
    }
    const text = texts.join("\n").trim() || (media.length ? "发送了附件" : "收到一条空消息");
    const attachmentText = media.length ? `\n\n本条微信消息的本地附件：\n${media.map((item) => `- ${item.kind}: ${item.localPath}`).join("\n")}` : "";
    return { text, prompt: `${text}${attachmentText}`, media };
  }

  private async runAgent(prompt: string, attachmentPaths: string[]): Promise<void> {
    await this.ensureAgent();
    await this.compactIfNeeded();
    this.running = true;
    await this.emitStatus();
    const state = this.store.getState();
    const ticket = this.api && state.userId ? await this.api.getTypingTicket(state.userId, (await this.secrets.read()).contextToken).catch(() => undefined) : undefined;
    if (ticket && this.api && state.userId) await this.api.sendTyping(state.userId, ticket, true).catch(() => undefined);
    try {
      const images = await imageInputs(attachmentPaths);
      await this.agent!.request("prompt", { message: prompt, ...(images.length ? { images } : {}), expandPromptTemplates: false });
      await this.agent!.waitForSettled();
      const result = await this.agent!.request<unknown>("get_last_assistant_text");
      const answer = typeof result === "string" ? result : isRecord(result) && typeof result.text === "string" ? result.text : "";
      this.agentStats = await this.agent!.request<AgentSessionStats>("get_session_stats");
      if (answer.trim()) {
        const clientId = `dscode-${randomUUID()}`;
        this.addMessage({ platformId: clientId, direction: "outbound", source: "agent", role: "assistant", text: answer.trim(), media: [], status: "pending" });
        if (state.userId) await this.sendTextReliable(state.userId, answer.trim(), clientId);
      }
      await this.flushAgentMediaOutbox();
      await this.compactIfNeeded();
      this.store.patchState({ lastError: undefined });
    } finally {
      if (ticket && this.api && state.userId) await this.api.sendTyping(state.userId, ticket, false).catch(() => undefined);
      this.running = false;
      await this.emitStatus();
    }
  }

  private async ensureAgent(): Promise<void> {
    const state = this.store.getState();
    if (!state.workspacePath) throw new Error("微信 Bot 尚未配置安全目录");
    const defaults = await this.settings.getAgentDefaults();
    const signature = `${defaults.provider}/${defaults.model}/${defaults.effort ?? ""}`;
    if (this.agent && this.agentSignature === signature) return;
    await this.agent?.stop().catch(() => undefined);
    const host = new AgentHost(
      (event) => {
        if (event.type === "extension_ui_request" && typeof event.id === "string") {
          const method = event.method;
          const response = method === "confirm" ? { confirmed: true }
            : method === "select" && Array.isArray(event.options) ? { value: event.options[0] }
              : { cancelled: true };
          void host.respondToUi(event.id, response).catch(() => undefined);
        }
      },
      (message) => void this.recordError(new Error(message)),
    );
    const snapshot = await host.start({
      cwd: state.workspacePath,
      provider: defaults.provider,
      model: defaults.model,
      effort: defaults.effort,
      permission: "trusted-workspace",
      sandbox: "workspace-write",
      project: true,
      network: true,
      tools: ["update_plan", "exec_command", "write_stdin", "apply_patch", "send_weixin_media"],
      ...(state.sessionPath ? { sessionPath: state.sessionPath } : {}),
      extraEnv: { DSCODE_WEIXIN_MEDIA_OUTBOX: this.mediaOutboxPath, DSCODE_SUBAGENT_DEPTH: "1" },
    });
    this.agent = host;
    this.agentSignature = signature;
    this.agentStats = snapshot.stats;
    const stats = snapshot.stats ?? await host.request<AgentSessionStats>("get_session_stats");
    if (state.sessionId && state.sessionId !== stats.sessionId) {
      await host.stop();
      this.agent = undefined;
      throw new Error("微信 Bot 固定会话身份发生变化，已停止以保护历史");
    }
    this.store.patchState({ sessionId: stats.sessionId, ...(stats.sessionFile ? { sessionPath: stats.sessionFile } : {}) });
  }

  private async compactIfNeeded(): Promise<void> {
    if (!this.agent) return;
    this.agentStats = await this.agent.request<AgentSessionStats>("get_session_stats");
    const percent = this.agentStats.contextUsage?.percent;
    if (percent === null || percent === undefined || percent < COMPACT_AT) return;
    const attempts = percent >= HARD_COMPACT_AT ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.agent.request("compact", {
          customInstructions: "保留长期用户偏好、项目目标、关键决策与理由、读写文件、命令和测试结果、未解决问题及下一步。合并已有摘要；删除寒暄、重复输出和无效中间过程；不得记录密钥。",
        });
        const state = this.store.getState();
        this.store.patchState({ compactionCount: state.compactionCount + 1, lastError: undefined });
        this.agentStats = await this.agent.request<AgentSessionStats>("get_session_stats");
        return;
      } catch (error) { lastError = error; }
    }
    if (percent >= HARD_COMPACT_AT) throw new Error(`上下文压缩连续失败，Bot 已暂停：${errorMessage(lastError)}`);
  }

  private async flushAgentMediaOutbox(): Promise<void> {
    let raw: string;
    try { raw = await fs.readFile(this.mediaOutboxPath, "utf8"); } catch { return; }
    const chunk = raw.slice(this.mediaOutboxOffset);
    this.mediaOutboxOffset = raw.length;
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const item = JSON.parse(line) as { path: string; caption?: string };
        await this.sendMedia(item.path, item.caption ?? "");
      } catch (error) { await this.recordError(error); }
    }
  }

  private async sendMedia(file: string, caption: string, source: "agent" | "desktop" = "agent"): Promise<boolean> {
    const state = this.store.getState();
    if (!state.userId || !state.workspacePath) throw new Error("微信 Bot 尚未完成绑定");
    const real = await this.validateWorkspaceFile(file, state.workspacePath);
    if (caption) await this.sendTextReliable(state.userId, caption);
    const buffer = await fs.readFile(real);
    const localPath = await this.store.saveMedia(buffer, path.basename(real), "outbound");
    const clientId = `dscode-${randomUUID()}`;
    const mimeType = mimeForPath(real);
    const media: WeixinMedia = { kind: mediaKind(mimeType), name: path.basename(real), mimeType, size: buffer.length, localPath };
    this.addMessage({ platformId: clientId, direction: "outbound", source, role: source === "desktop" ? "user" : "assistant", text: caption, media: [media], status: "pending" });
    const payload: WeixinOutboxPayload = { kind: "media", to: state.userId, localPath };
    this.store.enqueueOutbox(clientId, payload);
    return this.deliverOutbox(clientId, payload);
  }

  private async sendTextReliable(to: string, text: string, existingClientId?: string): Promise<boolean> {
    const clientId = existingClientId ?? `dscode-${randomUUID()}`;
    const payload: WeixinOutboxPayload = { kind: "text", to, text };
    this.store.enqueueOutbox(clientId, payload);
    return this.deliverOutbox(clientId, payload);
  }

  private async deliverOutbox(clientId: string, payload: WeixinOutboxPayload): Promise<boolean> {
    if (!this.api) return false;
    try {
      const secret = await this.secrets.read();
      if (payload.kind === "text") {
        try {
          await this.api.sendText(payload.to, payload.text, secret.contextToken, clientId);
        } catch (error) {
          if (!/-2\b|context.?token/i.test(errorMessage(error))) throw error;
          await this.api.getTypingTicket(payload.to).catch(() => undefined);
          await this.api.sendText(payload.to, payload.text, undefined, clientId);
        }
      } else {
        const uploaded = await this.api.upload(payload.localPath, payload.to);
        await this.api.sendItem(payload.to, uploaded.item, secret.contextToken);
      }
      this.store.completeOutbox(clientId);
      const message = this.store.updateMessageByPlatformId(clientId, "sent");
      if (message) this.emit({ type: "message", message });
      return true;
    } catch (error) {
      this.store.failOutbox(clientId, errorMessage(error));
      return false;
    }
  }

  private async recoverDurableQueues(): Promise<void> {
    if (!this.api) return;
    for (const entry of this.store.pendingOutbox()) {
      await this.deliverOutbox(entry.clientId, entry.payload);
    }
    for (const entry of this.store.pendingInbox()) {
      if (isRecord(entry.payload)) await this.acceptInbound(entry.payload as ILinkMessage, entry.platformId);
    }
  }

  private addMessage(input: Omit<WeixinMessage, "id" | "createdAt">): WeixinMessage {
    const message = this.store.addMessage(input);
    this.emit({ type: "message", message });
    return message;
  }
  private updateMessage(id: number, status: WeixinMessage["status"]): void {
    const message = this.store.updateMessage(id, status);
    if (message) this.emit({ type: "message", message });
  }
  private enqueue(task: () => Promise<void>): void { this.operationQueue = this.operationQueue.then(task, task); }
  private async emitStatus(): Promise<void> { this.emit({ type: "status", status: await this.getStatus() }); }
  private async recordError(error: unknown): Promise<void> {
    const message = errorMessage(error);
    const pauseForCompaction = message.includes("压缩连续失败");
    this.store.patchState({ lastError: message, ...(pauseForCompaction ? { paused: true } : {}) });
    this.addMessage({ direction: "outbound", source: "system", role: "system", text: message, media: [], status: "failed" });
    if (pauseForCompaction) await this.pause();
    else await this.emitStatus();
  }
  private async validateWorkspace(candidate: string): Promise<string> {
    const real = await fs.realpath(path.resolve(candidate));
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error("安全目录必须是文件夹");
    return real;
  }
  private async validateWorkspaceFile(candidate: string, workspace: string): Promise<string> {
    const root = await fs.realpath(workspace);
    const real = await fs.realpath(path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate));
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("文件不在微信 Bot 安全目录内");
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("附件必须是文件");
    return real;
  }
}

async function imageInputs(paths: string[]): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const results: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const file of paths) {
    const mimeType = mimeForPath(file);
    if (!mimeType.startsWith("image/")) continue;
    results.push({ type: "image", data: (await fs.readFile(file)).toString("base64"), mimeType });
  }
  return results.slice(0, 5);
}
async function transcodeSilk(buffer: Buffer): Promise<Buffer | undefined> {
  try {
    const { decode } = await import("silk-wasm");
    const result = await decode(buffer, 24_000);
    const pcm = result.data;
    const wav = Buffer.alloc(44 + pcm.byteLength);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(pcm.byteLength, 40); Buffer.from(pcm).copy(wav, 44);
    return wav;
  } catch { return undefined; }
}
function mimeForPath(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".pdf": "application/pdf", ".txt": "text/plain", ".wav": "audio/wav" } as Record<string, string>)[ext] ?? "application/octet-stream";
}
function mediaKind(mimeType: string): WeixinMedia["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "voice";
  return "file";
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object"; }
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
