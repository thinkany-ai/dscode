import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  protocol,
  screen,
  shell,
  Tray,
} from "electron";
import {
  authenticateProvider,
  createDSCodeCredentialStore,
  defaultModelForProvider,
  initializeDSCodeHome,
  providerDisplayName,
  providerEnvironmentKey,
  removeStoredProviderCredential,
  saveProviderApiKey,
  saveDeepSeekBaseUrl,
  SUPPORTED_PROVIDER_IDS,
  type ApiKeyProviderId,
  type SupportedProviderId,
} from "@thinkany/dscode-core";
import type { AuthInteraction, AuthPrompt } from "@thinkany/dscode-core";
import { AgentHost } from "./agent-host";
import { RecentWorkspaces } from "./recent-workspaces";
import { AppSettings } from "./app-settings";
import { BUILTIN_THEME_PALETTES, listCodexThemes, resolveThemeBootstrap } from "./themes";
import {
  archiveSession,
  listSessions,
  setSessionPinned,
  unarchiveSession,
} from "./session-index";
import { AUTH_PROMPT_CANCEL_VALUE } from "../shared/types";
import type {
  AgentDefaults,
  AgentStartOptions,
  AuthUiEvent,
  FilePreview,
  FilePreviewKind,
  LanguagePreference,
  PersonalizationSettings,
  ProviderStatus,
  ThemeBootstrap,
  ThemePreference,
  UserProfile,
} from "../shared/types";
import { WeixinBotService } from "./weixin/service";

let mainWindow: BrowserWindow | undefined;
let agentHost: AgentHost | undefined;
let recentWorkspaces: RecentWorkspaces;
let appSettings: AppSettings;
let currentThemeBootstrap: ThemeBootstrap | undefined;
let rendererReady = false;
let windowReady = false;
let showWindowFallback: ReturnType<typeof setTimeout> | undefined;
let applyingTheme = false;
let activeAgentCwd: string | undefined;
let weixinBot: WeixinBotService;
let tray: Tray | undefined;
let quitting = false;
const authPrompts = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();

class AuthPromptCancelledError extends Error {
  constructor() {
    super("Login prompt cancelled");
    this.name = "AuthPromptCancelledError";
  }
}
const previewFiles = new Map<string, { filePath: string; rootPath: string }>();
let activePreviewId: string | undefined;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentIconPath = path.join(currentDirectory, "../../build/icon-dev.png");
const trayIconPath = app.isPackaged ? path.join(app.getAppPath(), "build/icon.png") : developmentIconPath;
const legacyUserDataPath = app.getPath("userData");
const userDataOverride = process.env.DSCODE_DESKTOP_USER_DATA;
const stableUserDataPath = userDataOverride
  ? path.resolve(userDataOverride)
  : path.join(app.getPath("appData"), "DSCode");
const generalTasksPath = path.join(stableUserDataPath, "tasks");
const appSettingsFile = path.join(stableUserDataPath, "app-settings.json");

protocol.registerSchemesAsPrivileged([{
  scheme: "dscode-preview",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

app.setName("DSCode");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
fs.mkdirSync(stableUserDataPath, { recursive: true, mode: 0o700 });
fs.mkdirSync(generalTasksPath, { recursive: true, mode: 0o700 });
app.setPath("userData", stableUserDataPath);
if (userDataOverride) {
  const logs = path.join(stableUserDataPath, "logs");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  app.setAppLogsPath(logs);
} else {
  app.setAppLogsPath();
}

async function createWindow(): Promise<void> {
  const themeBootstrap = await resolveAndApplyTheme();
  const { workArea } = screen.getPrimaryDisplay();
  const windowWidth = Math.floor(workArea.width * 0.8);
  const windowHeight = Math.floor(workArea.height * 0.9);
  const windowX = workArea.x + Math.floor((workArea.width - windowWidth) / 2);
  const windowY = workArea.y + Math.floor((workArea.height - windowHeight) / 2);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: themeCanvas(themeBootstrap),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 17, y: 16 },
    ...(!app.isPackaged ? { icon: developmentIconPath } : {}),
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  agentHost = new AgentHost(
    (event) => mainWindow?.webContents.send("agent:event", event),
    (message) => mainWindow?.webContents.send("agent:error", message),
    appSettingsFile,
  );

  rendererReady = false;
  windowReady = false;
  mainWindow.once("ready-to-show", () => {
    windowReady = true;
    showMainWindow(windowX, windowY);
  });
  mainWindow.on("closed", () => {
    if (showWindowFallback) clearTimeout(showWindowFallback);
    mainWindow = undefined;
    void agentHost?.stop();
  });
  mainWindow.on("close", (event) => {
    if (quitting || !weixinBot?.store.getState().accountId) return;
    event.preventDefault();
    mainWindow?.hide();
    ensureTray();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void mainWindow.loadURL(devServer);
  else void mainWindow.loadFile(path.join(currentDirectory, "../../dist/index.html"));
  showWindowFallback = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setPosition(windowX, windowY);
    mainWindow.show();
  }, 3_500);
}

function showMainWindow(windowX?: number, windowY?: number): void {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady || !windowReady) return;
  if (showWindowFallback) clearTimeout(showWindowFallback);
  if (windowX !== undefined && windowY !== undefined) mainWindow.setPosition(windowX, windowY);
  mainWindow.show();
}

async function resolveAndApplyTheme(preference?: ThemePreference, persist = false): Promise<ThemeBootstrap> {
  const requested = preference ?? await appSettings.getThemePreference();
  if (persist) await appSettings.setThemePreference(requested);
  const themes = await listCodexThemes();
  const candidate = resolveThemeBootstrap(requested, themes, nativeTheme.shouldUseDarkColors);
  const nativeSource = candidate.preference.source === "system"
    ? "system"
    : candidate.preference.source === "builtin"
      ? candidate.preference.mode
      : candidate.activeTheme?.mode ?? "system";
  applyingTheme = true;
  try {
    nativeTheme.themeSource = nativeSource;
  } finally {
    applyingTheme = false;
  }
  const bootstrap = resolveThemeBootstrap(candidate.preference, themes, nativeTheme.shouldUseDarkColors);
  currentThemeBootstrap = bootstrap;
  if (!sameThemePreference(requested, bootstrap.preference)) {
    await appSettings.setThemePreference(bootstrap.preference);
  }
  mainWindow?.setBackgroundColor(themeCanvas(bootstrap));
  return bootstrap;
}

function themeCanvas(bootstrap: ThemeBootstrap): string {
  return bootstrap.activeTheme?.palette.canvas ?? BUILTIN_THEME_PALETTES[bootstrap.resolvedMode].canvas;
}

function sameThemePreference(a: ThemePreference, b: ThemePreference): boolean {
  if (a.source !== b.source) return false;
  if (a.source === "builtin" && b.source === "builtin") return a.mode === b.mode;
  if (a.source === "custom" && b.source === "custom") return a.id === b.id;
  return a.source === "system" && b.source === "system";
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New thread", accelerator: "CmdOrCtrl+N", click: () => sendAppCommand("new-thread") },
        { label: "Open folder…", accelerator: "CmdOrCtrl+O", click: () => sendAppCommand("open-folder") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(trayIconPath);
  tray.setToolTip("DSCode · 微信 Bot");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 DSCode", click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } },
    { label: "暂停微信 Bot", click: () => void weixinBot.pause() },
    { type: "separator" },
    { label: "退出 DSCode", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

function sendAppCommand(command: string): void {
  mainWindow?.webContents.send("app:command", command);
}

function registerIpc(): void {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.on("app:renderer-ready", (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    rendererReady = true;
    showMainWindow();
  });
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error("Only http(s) links can be opened");
    await shell.openExternal(url);
  });

  ipcMain.handle("themes:list", () => listCodexThemes());
  ipcMain.handle("themes:bootstrap", () => resolveAndApplyTheme());
  ipcMain.handle("themes:set-preference", async (_event, preference: ThemePreference) => {
    const bootstrap = await resolveAndApplyTheme(preference, true);
    mainWindow?.webContents.send("themes:resolved-mode", bootstrap);
    return bootstrap;
  });

  ipcMain.handle("settings:get-language", () => appSettings.getLanguage());
  ipcMain.handle("settings:set-language", (_event, language: LanguagePreference) => appSettings.setLanguage(language));
  ipcMain.handle("settings:get-profile", () => appSettings.getProfile());
  ipcMain.handle("settings:set-profile", (_event, profile: UserProfile) => appSettings.setProfile(profile));
  ipcMain.handle("settings:get-show-reasoning-process", () => appSettings.getShowReasoningProcess());
  ipcMain.handle("settings:set-show-reasoning-process", (_event, value: boolean) => appSettings.setShowReasoningProcess(value));
  ipcMain.handle("settings:get-personalization", () => appSettings.getPersonalization());
  ipcMain.handle("settings:set-personalization", (_event, personalization: PersonalizationSettings) => appSettings.setPersonalization(personalization));
  ipcMain.handle("settings:get-agent-defaults", () => appSettings.getAgentDefaults());
  ipcMain.handle("settings:set-agent-defaults", (_event, defaults: AgentDefaults) => appSettings.setAgentDefaults(defaults));

  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Open a workspace",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    await recentWorkspaces.touch(selected);
    return selected;
  });
  ipcMain.handle("workspace:recent", () => recentWorkspaces.list());
  ipcMain.handle("workspace:forget", (_event, workspacePath: string) => recentWorkspaces.forget(workspacePath));
  ipcMain.handle("files:choose-preview", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Preview a file",
      properties: ["openFile"],
      buttonLabel: "Preview",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await fsp.realpath(result.filePaths[0]);
    const workspaceRoot = activeAgentCwd ? await fsp.realpath(activeAgentCwd) : undefined;
    const rootPath = workspaceRoot && isPathInside(workspaceRoot, selected) ? workspaceRoot : path.dirname(selected);
    return createFilePreview(selected, rootPath);
  });
  ipcMain.handle("files:valid-preview-paths", async (_event, requestedPaths: unknown) => {
    if (!activeAgentCwd || !Array.isArray(requestedPaths)) return [];
    let rootPath: string;
    try {
      rootPath = await fsp.realpath(activeAgentCwd);
    } catch {
      return [];
    }
    const candidates = requestedPaths
      .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 500)
      .slice(0, 12);
    const results = await Promise.all(candidates.map(async (requestedPath) => {
      try {
        const filePath = await resolveWorkspacePreviewPath(requestedPath, rootPath);
        const stats = await fsp.stat(filePath);
        return stats.isFile() ? requestedPath : undefined;
      } catch {
        return undefined;
      }
    }));
    return results.filter((value): value is string => Boolean(value));
  });
  ipcMain.handle("files:preview", async (_event, requestedPath: string) => {
    if (!activeAgentCwd) throw new Error("Open a workspace before previewing files");
    const rootPath = await fsp.realpath(activeAgentCwd);
    const filePath = await resolveWorkspacePreviewPath(requestedPath, rootPath);
    return createFilePreview(filePath, rootPath);
  });
  ipcMain.handle("files:open-preview", async (_event, id: string) => {
    const preview = previewFiles.get(id);
    if (!preview) throw new Error("This preview is no longer available");
    const error = await shell.openPath(preview.filePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle("sessions:list", async (_event, cwd?: string) => {
    const botSessionId = weixinBot?.store.getState().sessionId;
    return (await listSessions(cwd)).filter((session) => session.id !== botSessionId);
  });
  ipcMain.handle("sessions:pin", (_event, id: string, pinned: boolean) => setSessionPinned(id, pinned));
  ipcMain.handle("sessions:archive", (_event, id: string) => {
    if (id === weixinBot?.store.getState().sessionId) throw new Error("微信 Bot 固定会话不能归档");
    return archiveSession(id);
  });
  ipcMain.handle("sessions:unarchive", (_event, id: string) => unarchiveSession(id));

  ipcMain.handle("auth:status", async (): Promise<ProviderStatus[]> => {
    const credentialStore = await createDSCodeCredentialStore();
    const storedProviders = new Set((await credentialStore.list()).map((entry) => entry.providerId));
    return SUPPORTED_PROVIDER_IDS.map((id) => {
      const stored = storedProviders.has(id);
      const environmentKey = providerEnvironmentKey(id);
      const environment = Boolean(environmentKey && process.env[environmentKey]?.trim());
      return {
        id,
        name: providerDisplayName(id),
        configured: stored || environment,
        ...(stored ? { source: "stored" as const } : environment ? { source: "environment" as const } : {}),
        defaultModel: defaultModelForProvider(id),
      };
    });
  });
  ipcMain.handle(
    "auth:save-api-key",
    async (_event, provider: ApiKeyProviderId, key: string, baseUrl?: string) => {
      await saveProviderApiKey(provider, key);
      if (provider === "deepseek" && baseUrl) await saveDeepSeekBaseUrl(baseUrl);
    },
  );
  ipcMain.handle("auth:logout", async (_event, provider: SupportedProviderId) => {
    await removeStoredProviderCredential(provider);
  });
  ipcMain.handle("auth:login", async (ipcEvent, provider: Exclude<SupportedProviderId, "deepseek">) => {
    const send = (event: AuthUiEvent) => ipcEvent.sender.send("auth:event", event);
    try {
      const interaction: AuthInteraction = {
        prompt: (prompt) => requestAuthInput(prompt, send),
        notify: (event) => {
          send({ kind: "notice", event });
          if (event.type === "auth_url") void shell.openExternal(event.url);
          if (event.type === "device_code") void shell.openExternal(event.verificationUri);
        },
      };
      const result = await authenticateProvider(provider, interaction);
      send({ kind: "complete", providerId: result.providerId, modelId: result.modelId });
      return true;
    } catch (error) {
      if (error instanceof AuthPromptCancelledError) return false;
      const message = error instanceof Error ? error.message : String(error);
      send({ kind: "error", message });
      throw error;
    }
  });
  ipcMain.handle("auth:respond", (_event, id: string, value: string) => {
    const pending = authPrompts.get(id);
    if (!pending) return;
    authPrompts.delete(id);
    if (value === AUTH_PROMPT_CANCEL_VALUE) {
      pending.reject(new AuthPromptCancelledError());
    } else {
      pending.resolve(value);
    }
  });

  ipcMain.handle("agent:start", async (_event, options: AgentStartOptions) => {
    const cwd = options.cwd ? path.resolve(options.cwd) : generalTasksPath;
    activeAgentCwd = cwd;
    if (options.project) await recentWorkspaces.touch(cwd);
    return agentHost!.start({ ...options, cwd });
  });
  ipcMain.handle("agent:stop", () => agentHost!.stop());
  ipcMain.handle("agent:command", (_event, type: string, data?: Record<string, unknown>) => {
    if (!ALLOWED_AGENT_COMMANDS.has(type)) throw new Error(`Unsupported agent command: ${type}`);
    return agentHost!.request(type, data);
  });
  ipcMain.handle("agent:ui-response", (_event, id: string, response: Record<string, unknown>) => {
    return agentHost!.respondToUi(id, response);
  });

  ipcMain.handle("weixin:status", () => weixinBot.getStatus());
  ipcMain.handle("weixin:choose-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择微信 Bot 安全目录",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "选择并继续",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("weixin:configure-workspace", (_event, workspacePath: string) => weixinBot.configureWorkspace(workspacePath));
  ipcMain.handle("weixin:choose-attachments", async () => {
    const state = weixinBot.store.getState();
    if (!state.workspacePath) throw new Error("请先配置微信 Bot 安全目录");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "从安全目录发送到微信",
      defaultPath: state.workspacePath,
      properties: ["openFile", "multiSelections"],
      buttonLabel: "添加",
    });
    if (result.canceled) return [];
    const root = await fsp.realpath(state.workspacePath);
    const files: string[] = [];
    for (const candidate of result.filePaths.slice(0, 10)) {
      const real = await fsp.realpath(candidate);
      if (!isPathInside(root, real)) throw new Error("只能选择安全目录内的文件");
      const stat = await fsp.stat(real);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("附件必须是 100 MB 以内的文件");
      files.push(real);
    }
    return files;
  });
  ipcMain.handle("weixin:login-start", () => weixinBot.startLogin());
  ipcMain.handle("weixin:login-wait", (_event, sessionId: string) => weixinBot.waitLogin(sessionId));
  ipcMain.handle("weixin:login-verify", (_event, sessionId: string, code: string) => weixinBot.submitVerifyCode(sessionId, code));
  ipcMain.handle("weixin:start", async () => { await weixinBot.start(); ensureTray(); });
  ipcMain.handle("weixin:pause", () => weixinBot.pause());
  ipcMain.handle("weixin:disconnect", () => weixinBot.disconnect());
  ipcMain.handle("weixin:history", (_event, query?: { before?: number; limit?: number }) => weixinBot.history(query));
  ipcMain.handle("weixin:send", (_event, input: { text: string; attachmentPaths?: string[] }) => weixinBot.send(input.text, input.attachmentPaths));
  ipcMain.handle("weixin:abort", () => weixinBot.abortTurn());
  ipcMain.handle("weixin:set-auto-launch", async (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ["--weixin-background"] });
    await weixinBot.setAutoLaunch(enabled);
  });
  ipcMain.handle("weixin:clear", async (_event, confirmation: string) => {
    await weixinBot.clearAllData(confirmation);
    tray?.destroy();
    tray = undefined;
  });
}

function requestAuthInput(prompt: AuthPrompt, send: (event: AuthUiEvent) => void): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    authPrompts.set(id, { resolve, reject });
    send({
      kind: "prompt",
      id,
      prompt: {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.type !== "select" && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select" ? { options: [...prompt.options] } : {}),
      },
    });
    prompt.signal?.addEventListener(
      "abort",
      () => {
        authPrompts.delete(id);
        reject(new Error("Login prompt cancelled"));
      },
      { once: true },
    );
  });
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const ALLOWED_AGENT_COMMANDS = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "new_session",
  "get_state",
  "set_model",
  "get_available_models",
  "set_thinking_level",
  "get_available_thinking_levels",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_messages",
  "get_commands",
]);

app.whenReady().then(async () => {
  if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(developmentIconPath);
  await initializeDSCodeHome();
  await migrateDesktopData();
  recentWorkspaces = new RecentWorkspaces(path.join(app.getPath("userData"), "recent-workspaces.json"));
  appSettings = new AppSettings(appSettingsFile);
  weixinBot = new WeixinBotService(
    path.join(app.getPath("userData"), "weixin"),
    app.getVersion(),
    appSettings,
    (event) => mainWindow?.webContents.send("weixin:event", event),
  );
  installFilePreviewProtocol();
  registerIpc();
  installMenu();
  await createWindow();
  await weixinBot.initialize();
  if (weixinBot.store.getState().accountId) ensureTray();
  if (process.argv.includes("--weixin-background") && weixinBot.store.getState().accountId) mainWindow?.hide();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

nativeTheme.on("updated", () => {
  if (applyingTheme || !currentThemeBootstrap || currentThemeBootstrap.preference.source !== "system") return;
  const resolvedMode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  if (resolvedMode === currentThemeBootstrap.resolvedMode) return;
  currentThemeBootstrap = { ...currentThemeBootstrap, resolvedMode };
  mainWindow?.setBackgroundColor(themeCanvas(currentThemeBootstrap));
  mainWindow?.webContents.send("themes:resolved-mode", currentThemeBootstrap);
});

app.on("second-instance", () => {
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !weixinBot?.store.getState().accountId) app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  void agentHost?.stop();
  void weixinBot?.shutdown();
});

async function migrateDesktopData(): Promise<void> {
  if (legacyUserDataPath === stableUserDataPath) return;
  const source = path.join(legacyUserDataPath, "recent-workspaces.json");
  const target = path.join(stableUserDataPath, "recent-workspaces.json");
  try {
    await fsp.access(target);
    return;
  } catch {
    // Continue only when the stable file does not exist yet.
  }
  try {
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST")) return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function installFilePreviewProtocol(): void {
  protocol.handle("dscode-preview", async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const requestedSegments = requestUrl.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      const requestedId = requestedSegments[0];
      const directPreview = requestedId ? previewFiles.get(requestedId) : undefined;
      const preview = directPreview ?? (activePreviewId ? previewFiles.get(activePreviewId) : undefined);
      if (!preview) return new Response("Preview not found", { status: 404 });
      const relativeSegments = directPreview ? requestedSegments.slice(1) : requestedSegments;
      const candidate = path.resolve(preview.rootPath, ...relativeSegments);
      const filePath = await fsp.realpath(candidate);
      if (!isPathInside(preview.rootPath, filePath)) return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return new Response("Not found", { status: 404 });
      return new Response("Unable to load preview", { status: 500 });
    }
  });
}

async function createFilePreview(filePath: string, rootPath: string): Promise<FilePreview> {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) throw new Error("Only files can be previewed");
  const extension = path.extname(filePath).toLowerCase();
  const kind = previewKind(extension);
  const id = randomUUID();
  const relativePath = path.relative(rootPath, filePath);
  const encodedPath = relativePath.split(path.sep).map((segment) => encodeURIComponent(segment)).join("/");
  const textPreview = kind === "markdown" || kind === "code" || kind === "text";
  const tooLarge = textPreview && stats.size > 3 * 1024 * 1024;
  const content = textPreview && !tooLarge ? await fsp.readFile(filePath, "utf8") : undefined;
  previewFiles.set(id, { filePath, rootPath });
  activePreviewId = id;
  while (previewFiles.size > 12) {
    const oldestId = previewFiles.keys().next().value as string | undefined;
    if (!oldestId) break;
    previewFiles.delete(oldestId);
  }
  return {
    id,
    path: filePath,
    name: path.basename(filePath),
    extension: extension.slice(1),
    kind,
    url: `dscode-preview://file/${id}/${encodedPath}`,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    ...(content !== undefined ? { content } : {}),
    ...(tooLarge ? { tooLarge: true } : {}),
  };
}

async function resolveWorkspacePreviewPath(requestedPath: string, rootPath: string): Promise<string> {
  const expandedPath = requestedPath.startsWith(`~${path.sep}`)
    ? path.join(app.getPath("home"), requestedPath.slice(2))
    : requestedPath;
  const resolvedPath = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(rootPath, expandedPath);
  const filePath = await fsp.realpath(resolvedPath);
  if (!isPathInside(rootPath, filePath)) throw new Error("The file is outside the current workspace");
  return filePath;
}

function previewKind(extension: string): FilePreviewKind {
  if ([".html", ".htm"].includes(extension)) return "html";
  if ([".md", ".mdx", ".markdown"].includes(extension)) return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) return "audio";
  if ([
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".json", ".jsonc",
    ".yaml", ".yml", ".toml", ".xml", ".vue", ".svelte", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
    ".swift", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".graphql",
  ].includes(extension)) return "code";
  if ([".txt", ".log", ".csv", ".tsv", ".ini", ".conf", ".config", ".env", ".gitignore"].includes(extension)) return "text";
  return "unsupported";
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
