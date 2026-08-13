import type { DesktopApi } from "../shared/types";

const workspace = "/Users/demo/projects/dscode";
const themesWorkspace = "/Users/demo/projects/codexthemes-skills";
const terminalWorkspace = "/Users/demo/projects/termany";
const generalTasksWorkspace = "/Users/demo/Library/Application Support/DSCode/tasks";
const previewNow = new Date().toISOString();

function previewSession(id: string, title: string, ageMs: number, messageCount: number, cwd = workspace) {
  const sessionPath = `/preview/${id}.jsonl`;
  return {
    path: sessionPath,
    storagePath: sessionPath,
    id,
    cwd,
    title,
    createdAt: previewNow,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
    model: "deepseek-v4-flash",
    messageCount,
    pinned: false,
    archived: false,
  };
}

export function createPreviewApi(): DesktopApi {
  return {
    platform: "darwin",
    app: {
      version: async () => "0.1.0-preview",
      openExternal: async () => undefined,
    },
    themes: {
      list: async () => [],
      getActive: async () => null,
      setActive: async () => undefined,
    },
    settings: {
      getLanguage: async () => "system",
      setLanguage: async () => undefined,
      getProfile: async () => ({ nickname: "demo" }),
      setProfile: async () => undefined,
    },
    workspace: {
      choose: async () => workspace,
      recent: async () => [
        { path: workspace, name: "dscode", lastOpenedAt: new Date().toISOString() },
        { path: themesWorkspace, name: "codexthemes-skills", lastOpenedAt: new Date(Date.now() - 3_600_000).toISOString() },
        { path: terminalWorkspace, name: "termany", lastOpenedAt: new Date(Date.now() - 7_200_000).toISOString() },
      ],
      forget: async () => [],
    },
    files: {
      validPreviewPaths: async (paths) => paths,
      choosePreview: async () => ({
        id: "preview-readme",
        path: `${workspace}/README.md`,
        name: "README.md",
        extension: "md",
        kind: "markdown",
        url: "",
        size: 842,
        modifiedAt: previewNow,
        content: "# DSCode Desktop\n\nA native workspace for building, reviewing, and previewing changes with DSCode.\n\n- Shared DSCode runtime\n- Local project sessions\n- Rich file previews",
      }),
      preview: async (filePath) => ({
        id: "preview-file",
        path: filePath,
        name: filePath.split("/").at(-1) ?? "Preview",
        extension: filePath.split(".").at(-1) ?? "txt",
        kind: "code",
        url: "",
        size: 128,
        modifiedAt: previewNow,
        content: "// File preview\nexport const ready = true;",
      }),
      openPreview: async () => undefined,
    },
    sessions: {
      list: async () => [
        previewSession("1", "Add desktop workspace support", 0, 4),
        previewSession("4", "Build collapsible project navigation", 3_600_000, 7),
        previewSession("5", "Review the RPC event flow", 10_800_000, 9),
        previewSession("6", "Fix authentication settings", 21_600_000, 6),
        previewSession("7", "Polish the composer layout", 32_400_000, 5),
        previewSession("8", "Prepare the desktop release", 43_200_000, 8),
        previewSession("9", "Design a native Codex theme", 14_400_000, 5, themesWorkspace),
        previewSession("10", "Package theme assets", 28_800_000, 4, themesWorkspace),
        previewSession("11", "Improve terminal session restore", 18_000_000, 6, terminalWorkspace),
        previewSession("2", "Compare two implementation options", 7_200_000, 9, generalTasksWorkspace),
        previewSession("3", "Plan the next release", 86_400_000, 6, generalTasksWorkspace),
      ],
      pin: async () => true,
      archive: async () => undefined,
      unarchive: async () => undefined,
    },
    auth: {
      status: async () => [{ id: "deepseek", name: "DeepSeek", configured: true, source: "stored", defaultModel: "deepseek-v4-flash" }],
      saveApiKey: async () => undefined,
      login: async () => undefined,
      respond: async () => undefined,
      logout: async () => undefined,
      onEvent: () => () => undefined,
    },
    agent: {
      start: async (options) => ({
        state: { isStreaming: false, thinkingLevel: "max", model: { provider: "deepseek", id: "deepseek-v4-flash" } },
        messages: options.sessionPath ? [
          { role: "user", content: [{ type: "text", text: "Reuse the core package and make the desktop experience feel native." }], timestamp: Date.now() - 65_000 },
          { role: "assistant", content: [
            { type: "thinking", thinking: "I’ll inspect the shared runtime boundary and keep the Electron host thin." },
            { type: "text", text: "I’ll inspect the shared runtime boundary first, then verify how the desktop shell connects to it." },
            { type: "toolCall", id: "preview-tool", name: "exec_command", arguments: { cmd: "rg --files packages/core/src" } },
          ], timestamp: Date.now() - 55_000 },
          { role: "toolResult", toolCallId: "preview-tool", toolName: "exec_command", content: [{ type: "text", text: "packages/core/src/index.ts" }], isError: false, timestamp: Date.now() - 53_000 },
          { role: "assistant", content: [
            { type: "toolCall", id: "preview-plan", name: "update_plan", arguments: { plan: [
              { step: "Inspect the shared runtime boundary", status: "completed" },
              { step: "Connect the desktop session lifecycle", status: "in_progress" },
              { step: "Verify native workspace behavior", status: "pending" },
            ] } },
          ], timestamp: Date.now() - 52_500 },
          { role: "toolResult", toolCallId: "preview-plan", toolName: "update_plan", content: [{ type: "text", text: "Plan updated: 1/3 steps completed." }], isError: false, timestamp: Date.now() - 52_200 },
          { role: "assistant", content: [
            { type: "thinking", thinking: "I’ve verified the boundary and can now summarize the architecture." },
            { type: "text", text: "The desktop shell is now connected to the same session, authentication, tools, Skills, and MCP runtime as the terminal client.\n\nThe host only owns native window behavior, secure IPC, and workspace selection." },
          ], timestamp: Date.now() - 52_000 },
        ] : [],
        models: [
          { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true },
          { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
        ],
        thinkingLevels: ["low", "high", "max"],
      }),
      stop: async () => undefined,
      command: async <T = unknown>() => undefined as T,
      respondToUi: async () => undefined,
      onEvent: () => () => undefined,
      onError: () => () => undefined,
    },
  };
}
