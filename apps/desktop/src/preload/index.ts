import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AuthUiEvent, DesktopApi } from "../shared/types";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopApi & { onAppCommand(listener: (command: string) => void): () => void } = {
  platform: process.platform,
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  },
  themes: {
    list: () => ipcRenderer.invoke("themes:list"),
    getActive: () => ipcRenderer.invoke("themes:get-active"),
    setActive: (id) => ipcRenderer.invoke("themes:set-active", id),
  },
  settings: {
    getLanguage: () => ipcRenderer.invoke("settings:get-language"),
    setLanguage: (language) => ipcRenderer.invoke("settings:set-language", language),
    getProfile: () => ipcRenderer.invoke("settings:get-profile"),
    setProfile: (profile) => ipcRenderer.invoke("settings:set-profile", profile),
    getShowReasoningProcess: () => ipcRenderer.invoke("settings:get-show-reasoning-process"),
    setShowReasoningProcess: (value) => ipcRenderer.invoke("settings:set-show-reasoning-process", value),
    getPersonalization: () => ipcRenderer.invoke("settings:get-personalization"),
    setPersonalization: (personalization) => ipcRenderer.invoke("settings:set-personalization", personalization),
  },
  workspace: {
    choose: () => ipcRenderer.invoke("workspace:choose"),
    recent: () => ipcRenderer.invoke("workspace:recent"),
    forget: (workspacePath) => ipcRenderer.invoke("workspace:forget", workspacePath),
  },
  files: {
    choosePreview: () => ipcRenderer.invoke("files:choose-preview"),
    validPreviewPaths: (paths) => ipcRenderer.invoke("files:valid-preview-paths", paths),
    preview: (filePath) => ipcRenderer.invoke("files:preview", filePath),
    openPreview: (id) => ipcRenderer.invoke("files:open-preview", id),
  },
  sessions: {
    list: (cwd) => ipcRenderer.invoke("sessions:list", cwd),
    pin: (id, pinned) => ipcRenderer.invoke("sessions:pin", id, pinned),
    archive: (id) => ipcRenderer.invoke("sessions:archive", id),
    unarchive: (id) => ipcRenderer.invoke("sessions:unarchive", id),
    delete: (id) => ipcRenderer.invoke("sessions:delete", id),
  },
  auth: {
    status: () => ipcRenderer.invoke("auth:status"),
    saveApiKey: (provider, key, baseUrl) => ipcRenderer.invoke("auth:save-api-key", provider, key, baseUrl),
    login: (provider) => ipcRenderer.invoke("auth:login", provider),
    respond: (id, value) => ipcRenderer.invoke("auth:respond", id, value),
    logout: (provider) => ipcRenderer.invoke("auth:logout", provider),
    onEvent: (listener) => subscribe<AuthUiEvent>("auth:event", listener),
  },
  agent: {
    start: (options) => ipcRenderer.invoke("agent:start", options),
    stop: () => ipcRenderer.invoke("agent:stop"),
    command: (type, data) => ipcRenderer.invoke("agent:command", type, data),
    respondToUi: (id, response) => ipcRenderer.invoke("agent:ui-response", id, response),
    onEvent: (listener) => subscribe<AgentEvent>("agent:event", listener),
    onError: (listener) => subscribe<string>("agent:error", listener),
  },
  onAppCommand: (listener) => subscribe<string>("app:command", listener),
};

contextBridge.exposeInMainWorld("dscode", api);
