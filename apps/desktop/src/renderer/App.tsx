import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  File as FileIcon,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  GitFork,
  Globe2,
  ImagePlus,
  Info,
  Languages,
  ListFilter,
  ListTodo,
  LoaderCircle,
  Menu,
  MessageSquareWarning,
  MessageSquareText,
  Paperclip,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  Sun,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentEvent,
  AgentSnapshot,
  AgentSessionStats,
  AuthUiEvent,
  ExtensionUiRequest,
  LanguagePreference,
  PersonalizationSettings,
  PermissionMode,
  ProviderId,
  ProviderStatus,
  FilePreview,
  SandboxMode,
  SessionSummary,
  ThemeSummary,
  TonePreset,
  UserProfile,
  WorkspaceItem,
} from "../shared/types";
import { AUTH_PROMPT_CANCEL_VALUE } from "../shared/types";
import {
  applyAgentEvent,
  coalesceStreamingAgentEvents,
  getAssistantActivity,
  groupConversation,
  isAssistantTurnActive,
  isStreamingAgentEvent,
  normalizeMessages,
  optimisticUserMessage,
  splitAssistantTurn,
  type ChatImage,
  type ChatMessage,
  type ToolActivity,
  type TurnWorkEntry,
} from "./lib/conversation";
import { applyTheme } from "./lib/theme";
import { localizeExtensionUiRequest, useI18n } from "./lib/i18n";
import { isAgentSessionClosedError, isAuthPromptCancelledError } from "./lib/errors";
import { isPreviewPathInWorkspace, previewPathsFromText } from "./lib/file-preview";
import { parseStructuredPlan, type StructuredPlan } from "./lib/plan";
import { updateConversationTailFollowing } from "./lib/conversation-scroll";

interface Attachment extends ChatImage {
  name: string;
}

interface PreviewImage extends ChatImage {
  alt: string;
}

const PROJECT_TASK_PREVIEW_COUNT = 4;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DSCODE_WEBSITE_URL = "https://dscode.ai?utm_source=dscode_desktop";
const DSCODE_GITHUB_URL = "https://github.com/thinkany-ai/dscode";
const DSCODE_ISSUES_URL = `${DSCODE_GITHUB_URL}/issues`;
const DEFAULT_INSPECTOR_WIDTH = 460;
const MIN_INSPECTOR_WIDTH = 320;
const MAX_INSPECTOR_WIDTH = 880;
const MIN_CONVERSATION_WIDTH = 440;
const INSPECTOR_RESIZER_WIDTH = 7;
const MAX_CUSTOM_INSTRUCTION_LENGTH = 1_500;
const PERSONALIZATION_TONES = [
  { id: "default", label: "settings.toneDefault", description: "settings.toneDefaultDescription" },
  { id: "professional", label: "settings.toneProfessional", description: "settings.toneProfessionalDescription" },
  { id: "friendly", label: "settings.toneFriendly", description: "settings.toneFriendlyDescription" },
  { id: "candid", label: "settings.toneCandid", description: "settings.toneCandidDescription" },
  { id: "quirky", label: "settings.toneQuirky", description: "settings.toneQuirkyDescription" },
  { id: "efficient", label: "settings.toneEfficient", description: "settings.toneEfficientDescription" },
  { id: "cynical", label: "settings.toneCynical", description: "settings.toneCynicalDescription" },
  { id: "inspiring", label: "settings.toneInspiring", description: "settings.toneInspiringDescription" },
] as const satisfies ReadonlyArray<{ id: TonePreset; label: string; description: string }>;

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function inspectorBoundsForLayout(layoutWidth: number) {
  const availableWidth = layoutWidth - MIN_CONVERSATION_WIDTH - INSPECTOR_RESIZER_WIDTH;
  return {
    min: MIN_INSPECTOR_WIDTH,
    max: Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, availableWidth)),
  };
}

export default function App() {
  const { locale, t } = useI18n();
  const [workspace, setWorkspace] = useState<string>();
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [fullyExpandedProjects, setFullyExpandedProjects] = useState<Set<string>>(() => new Set());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [provider, setProvider] = useState<ProviderId>("deepseek");
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile>({ nickname: "User" });
  const [showReasoningProcess, setShowReasoningProcess] = useState(false);
  const [personalization, setPersonalization] = useState<PersonalizationSettings>({ tone: "default", customInstructions: "" });
  const [model, setModel] = useState("deepseek-v4-flash");
  const [effort, setEffort] = useState("max");
  const [permission, setPermission] = useState<PermissionMode>("auto");
  const [sandbox, setSandbox] = useState<SandboxMode>("workspace-write");
  const [availableModels, setAvailableModels] = useState<AgentSnapshot["models"]>([]);
  const [sessionStats, setSessionStats] = useState<AgentSessionStats>();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const [editingSubmitting, setEditingSubmitting] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage>();
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [permissionUpdating, setPermissionUpdating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectsSectionOpen, setProjectsSectionOpen] = useState(true);
  const [recentSectionOpen, setRecentSectionOpen] = useState(true);
  const [contextCardOpen, setContextCardOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [filePreview, setFilePreview] = useState<FilePreview>();
  const [recentPreviewFiles, setRecentPreviewFiles] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "info" | "error" }>();
  const [uiRequest, setUiRequest] = useState<ExtensionUiRequest>();
  const [authEvent, setAuthEvent] = useState<AuthUiEvent>();
  const authCancellationRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingConversationTailRef = useRef(true);
  const previousConversationScrollTopRef = useRef(0);
  const threadLayoutRef = useRef<HTMLDivElement>(null);
  const activeCwdRef = useRef<string | undefined>(undefined);
  const sidebarFooterRef = useRef<HTMLDivElement>(null);
  const previewRequestRef = useRef(0);
  const inspectorResizeCleanupRef = useRef<() => void>(() => undefined);
  const pendingAgentEventsRef = useRef<AgentEvent[]>([]);
  const pendingAgentFrameRef = useRef<number | undefined>(undefined);
  const previewFileCandidatesRef = useRef<string[]>([]);

  const flushPendingAgentEvents = useCallback(() => {
    const frame = pendingAgentFrameRef.current;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    pendingAgentFrameRef.current = undefined;
    const pending = pendingAgentEventsRef.current;
    if (pending.length === 0) return;
    pendingAgentEventsRef.current = [];
    const events = coalesceStreamingAgentEvents(pending);
    setMessages((current) => events.reduce((next, event) => applyAgentEvent(next, event), current));
  }, []);

  const enqueueAgentEvent = useCallback((event: AgentEvent) => {
    if (!isStreamingAgentEvent(event)) {
      flushPendingAgentEvents();
      setMessages((current) => applyAgentEvent(current, event));
      return;
    }
    pendingAgentEventsRef.current.push(event);
    if (pendingAgentFrameRef.current === undefined) {
      pendingAgentFrameRef.current = window.requestAnimationFrame(flushPendingAgentEvents);
    }
  }, [flushPendingAgentEvents]);

  const hydrateSnapshot = useCallback((snapshot: AgentSnapshot) => {
    setMessages(normalizeMessages(snapshot.messages));
    setAvailableModels(snapshot.models);
    setSessionStats(snapshot.stats);
    const stateModel = snapshot.state.model as { provider?: string; id?: string } | undefined;
    if (stateModel?.provider) setProvider(stateModel.provider as ProviderId);
    if (stateModel?.id) setModel(stateModel.id);
    if (typeof snapshot.state.thinkingLevel === "string") setEffort(snapshot.state.thinkingLevel);
  }, []);

  const refreshSessions = useCallback(async () => {
    const items = await window.dscode.sessions.list();
    setSessions(items);
    setActiveSession((current) => {
      if (current || !items[0]) return current;
      activeCwdRef.current = items[0].cwd;
      return items[0].path;
    });
  }, []);

  const refreshSessionStats = useCallback(async () => {
    try {
      setSessionStats(await window.dscode.agent.command<AgentSessionStats>("get_session_stats"));
    } catch (error) {
      if (!isAgentSessionClosedError(error)) console.warn("Unable to refresh session statistics", error);
    }
  }, []);

  const readAgentSnapshot = useCallback(async (): Promise<AgentSnapshot> => {
    const [state, messageData, models, thinkingLevels, stats] = await Promise.all([
      window.dscode.agent.command<Record<string, unknown>>("get_state"),
      window.dscode.agent.command<{ messages: unknown[] }>("get_messages"),
      window.dscode.agent.command<{ models: AgentSnapshot["models"] }>("get_available_models"),
      window.dscode.agent.command<{ levels: string[] }>("get_available_thinking_levels"),
      window.dscode.agent.command<AgentSessionStats>("get_session_stats").catch(() => undefined),
    ]);
    return {
      state,
      messages: messageData.messages,
      models: models.models,
      thinkingLevels: thinkingLevels.levels,
      ...(stats ? { stats } : {}),
    };
  }, []);

  const openFilePreview = useCallback(async (filePath: string) => {
    const requestId = ++previewRequestRef.current;
    setContextCardOpen(false);
    setInspectorOpen(true);
    setPreviewLoading(true);
    setPreviewError(undefined);
    try {
      const filesApi = window.dscode.files;
      if (!filesApi) throw new Error(t("preview.restartRequired"));
      const nextPreview = await filesApi.preview(filePath);
      if (requestId === previewRequestRef.current) setFilePreview(nextPreview);
    } catch (error) {
      if (requestId === previewRequestRef.current) {
        const message = cleanError(error instanceof Error ? error.message : String(error));
        setPreviewError(/\bENOENT\b|no such file or directory/i.test(message)
          ? t("preview.fileMissing", { path: filePath })
          : message);
      }
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  }, [t]);

  const choosePreviewFile = useCallback(async () => {
    const requestId = ++previewRequestRef.current;
    setContextCardOpen(false);
    setInspectorOpen(true);
    setPreviewLoading(true);
    setPreviewError(undefined);
    try {
      const filesApi = window.dscode.files;
      if (!filesApi) throw new Error(t("preview.restartRequired"));
      const nextPreview = await filesApi.choosePreview();
      if (requestId === previewRequestRef.current && nextPreview) setFilePreview(nextPreview);
    } catch (error) {
      if (requestId === previewRequestRef.current) {
        setPreviewError(cleanError(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (requestId === previewRequestRef.current) setPreviewLoading(false);
    }
  }, [t]);

  const startAgent = useCallback(async (
    cwd?: string,
    sessionPath?: string,
    overrides?: { provider?: ProviderId; model?: string; effort?: string; permission?: PermissionMode; sandbox?: SandboxMode },
    projectPath?: string,
    behavior?: { background?: boolean; providerStatuses?: ProviderStatus[] },
  ) => {
    const background = behavior?.background === true;
    const nextProvider = overrides?.provider ?? provider;
    const providerStatuses = behavior?.providerStatuses ?? providers;
    const status = providerStatuses.find((candidate) => candidate.id === nextProvider);
    setUiRequest(undefined);
    setEditingMessageId(undefined);
    setEditingText("");
    setEditingSubmitting(false);
    setActiveSession(sessionPath);
    activeCwdRef.current = cwd;
    setWorkspace(projectPath);
    if (!background) {
      followingConversationTailRef.current = true;
      previousConversationScrollTopRef.current = 0;
      previewRequestRef.current += 1;
      setFilePreview(undefined);
      setPreviewError(undefined);
      setPreviewLoading(false);
    }
    if (providerStatuses.length && !status?.configured) {
      setSettingsOpen(true);
      setToast({ message: t("status.connectProvider", { provider: status?.name ?? nextProvider }), type: "error" });
      return false;
    }
    if (!background) setLoading(true);
    if (!background) setSessionStats(undefined);
    try {
      const snapshot = await window.dscode.agent.start({
        ...(cwd ? { cwd } : {}),
        project: Boolean(projectPath),
        provider: nextProvider,
        model: overrides?.model ?? model,
        effort: overrides?.effort ?? effort,
        permission: overrides?.permission ?? permission,
        sandbox: overrides?.sandbox ?? sandbox,
        ...(sessionPath ? { sessionPath } : {}),
      });
      hydrateSnapshot(snapshot);
      setRunning(Boolean(snapshot.state.isStreaming));
      return true;
    } catch (error) {
      if (isAgentSessionClosedError(error)) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (!background) setMessages([]);
      setToast({ message: cleanError(message), type: "error" });
      if (/not configured|credential|login|api key/i.test(message)) setSettingsOpen(true);
      return false;
    } finally {
      if (!background) setLoading(false);
    }
  }, [effort, hydrateSnapshot, model, permission, provider, providers, sandbox, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [recentItems, allSessions, providerItems, themeItems, activeThemeId, storedProfile, storedShowReasoningProcess, storedPersonalization] = await Promise.all([
        window.dscode.workspace.recent(),
        window.dscode.sessions.list(),
        window.dscode.auth.status(),
        window.dscode.themes.list(),
        window.dscode.themes.getActive(),
        window.dscode.settings.getProfile(),
        window.dscode.settings.getShowReasoningProcess(),
        window.dscode.settings.getPersonalization(),
      ]);
      if (cancelled) return;
      setWorkspaces(recentItems);
      setSessions(allSessions);
      setProviders(providerItems);
      setThemes(themeItems);
      setThemeId(activeThemeId);
      setProfile(storedProfile);
      setShowReasoningProcess(storedShowReasoningProcess);
      setPersonalization(storedPersonalization);
      applyTheme(themeItems.find((item) => item.id === activeThemeId) ?? null);
      const configured = providerItems.find((item) => item.id === "deepseek" && item.configured)
        ?? providerItems.find((item) => item.configured);
      if (configured) {
        setProvider(configured.id);
        setModel(configured.defaultModel);
        setEffort(configured.id === "deepseek" ? "max" : "medium");
      }
      const selectedSession = allSessions[0];
      const selectedProject = selectedSession
        ? recentItems.find((item) => item.path === selectedSession.cwd)
        : undefined;
      activeCwdRef.current = selectedSession?.cwd;
      setWorkspace(selectedProject?.path);
      if (selectedProject) setExpandedProjects(new Set([selectedProject.path]));
      setActiveSession(selectedSession?.path);
      if (configured) {
        try {
          const snapshot = await window.dscode.agent.start({
            ...(selectedSession ? { cwd: selectedSession.cwd, sessionPath: selectedSession.path } : {}),
            project: Boolean(selectedProject),
            provider: configured.id,
            model: configured.defaultModel,
            effort: configured.id === "deepseek" ? "max" : "medium",
            permission: "auto",
            sandbox: "workspace-write",
          });
          if (!cancelled) {
            hydrateSnapshot(snapshot);
          }
        } catch (error) {
          if (!cancelled && !isAgentSessionClosedError(error)) {
            setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateSnapshot]);

  useEffect(() => {
    const offEvent = window.dscode.agent.onEvent((event) => {
      if (event.type === "agent_start") setRunning(true);
      if (event.type === "agent_settled") {
        setRunning(false);
        setUiRequest(undefined);
        void refreshSessions();
        void refreshSessionStats();
      }
      if (event.type === "extension_ui_request") {
        const request = event as ExtensionUiRequest;
        if (request.method === "notify") {
          setToast({ message: request.message ?? t("app.notification"), type: request.notifyType === "error" ? "error" : "info" });
        } else if (["select", "confirm", "input", "editor"].includes(request.method)) {
          setUiRequest(request);
        }
      }
      enqueueAgentEvent(event);
    });
    const offError = window.dscode.agent.onError((message) => {
      if (isAgentSessionClosedError(message)) return;
      setRunning(false);
      setUiRequest(undefined);
      setToast({ message: cleanError(message), type: "error" });
    });
    const offAuth = window.dscode.auth.onEvent((event) => {
      setAuthEvent(event);
      if (event.kind === "complete") {
        void window.dscode.auth.status().then(setProviders);
        setProvider(event.providerId);
        setModel(event.modelId);
        setToast({ message: t("auth.accountConnected"), type: "info" });
      }
    });
    const offCommand = window.dscode.onAppCommand?.((command) => {
      if (command === "new-thread") void createNewThread();
      if (command === "open-folder") void chooseWorkspace();
    });
    return () => {
      offEvent();
      offError();
      offAuth();
      offCommand?.();
      const frame = pendingAgentFrameRef.current;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      pendingAgentFrameRef.current = undefined;
      pendingAgentEventsRef.current = [];
    };
  }, [enqueueAgentEvent, refreshSessionStats, refreshSessions, t]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !sidebarFooterRef.current?.contains(event.target)) setAccountMenuOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key === "Escape" && !searchOpen && !accountMenuOpen && running) void stopAgent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accountMenuOpen, running, searchOpen]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !followingConversationTailRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!followingConversationTailRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      previousConversationScrollTopRef.current = scroller.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, running, uiRequest]);

  const handleConversationScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    followingConversationTailRef.current = updateConversationTailFollowing(
      followingConversationTailRef.current,
      previousConversationScrollTopRef.current,
      {
        scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      },
    );
    previousConversationScrollTopRef.current = scrollTop;
  }, []);

  const handleConversationWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) followingConversationTailRef.current = false;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 5200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => () => inspectorResizeCleanupRef.current(), []);

  useEffect(() => {
    if (!inspectorOpen) return;
    const fitInspectorToLayout = () => {
      if (window.matchMedia("(max-width: 1120px)").matches) return;
      const layoutWidth = threadLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const bounds = inspectorBoundsForLayout(layoutWidth);
      setInspectorWidth((current) => Math.min(bounds.max, Math.max(bounds.min, current)));
    };
    fitInspectorToLayout();
    window.addEventListener("resize", fitInspectorToLayout);
    return () => window.removeEventListener("resize", fitInspectorToLayout);
  }, [inspectorOpen]);

  const chooseWorkspace = async () => {
    const selected = await window.dscode.workspace.choose();
    if (!selected) return undefined;
    setWorkspaces(await window.dscode.workspace.recent());
    setMessages([]);
    setActiveSession(undefined);
    setExpandedProjects((current) => new Set(current).add(selected));
    await startAgent(selected, undefined, undefined, selected);
    textareaRef.current?.focus();
    return selected;
  };

  const createNewThread = async () => {
    setMessages([]);
    setActiveSession(undefined);
    await startAgent();
    textareaRef.current?.focus();
  };

  const toggleWorkspace = (item: WorkspaceItem) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  };

  const openSession = async (session: SessionSummary) => {
    if (session.path === activeSession || loading) return;
    const projectPath = workspaces.some((item) => item.path === session.cwd) ? session.cwd : undefined;
    await startAgent(session.cwd, session.path, undefined, projectPath);
  };

  const deleteSession = useCallback(async (session: SessionSummary) => {
    if (running) {
      setToast({ message: t("status.cannotDeleteWhileRunning"), type: "error" });
      return;
    }
    if (!window.confirm(t("sidebar.confirmDeleteSession", { title: session.title }))) return;
    const wasActive = session.path === activeSession;
    try {
      if (wasActive) {
        await window.dscode.agent.stop();
        setRunning(false);
        setMessages([]);
        setActiveSession(undefined);
      }
      const deleted = await window.dscode.sessions.delete(session.id);
      if (!deleted) throw new Error("The conversation could not be deleted");
      setSessions((current) => current.filter((item) => item.id !== session.id));
      if (wasActive) {
        const projectPath = workspaces.some((item) => item.path === session.cwd) ? session.cwd : undefined;
        await startAgent(session.cwd, undefined, undefined, projectPath);
      } else {
        await refreshSessions();
      }
    } catch (error) {
      setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
    }
  }, [activeSession, refreshSessions, running, startAgent, t, workspaces]);

  const editMessage = useCallback((message: ChatMessage) => {
    if (running || editingMessageId) return;
    setEditingMessageId(message.id);
    setEditingText(message.text);
  }, [editingMessageId, running]);

  const cancelEditingMessage = useCallback(() => {
    if (editingSubmitting) return;
    setEditingMessageId(undefined);
    setEditingText("");
  }, [editingSubmitting]);

  const submitEditingMessage = useCallback(async () => {
    if (!editingMessageId || editingSubmitting || running) return;
    const original = messages.find((message) => message.id === editingMessageId);
    if (!original) return;
    const text = editingText.trim();
    const messageImages = original.images.map(({ data, mimeType }) => ({ data, mimeType }));
    if (!text && messageImages.length === 0) return;
    const images = messageImages.map((image) => ({ type: "image", ...image }));
    // Replacing the session shortens the scrollable content. Treat that
    // programmatic jump as a new tail-following sequence for the resend.
    followingConversationTailRef.current = true;
    previousConversationScrollTopRef.current = 0;
    // Leave the inline editor immediately. The session rewrite and snapshot
    // reload happen asynchronously, so keeping this state would briefly
    // render a large editing box above the replacement turn.
    setEditingMessageId(undefined);
    setEditingText("");
    setEditingSubmitting(true);
    setRunning(true);
    try {
      await window.dscode.agent.command("prompt", { message: "/edit-last" });
      const snapshot = await readAgentSnapshot();
      hydrateSnapshot(snapshot);
      setMessages((current) => [...current, optimisticUserMessage(text || t("composer.attachedImage"), false, messageImages)]);
      setEditingSubmitting(false);
      await window.dscode.agent.command("prompt", {
        message: text || t("composer.describeImage"),
        ...(images.length ? { images } : {}),
      });
    } catch (error) {
      setRunning(false);
      if (!isAgentSessionClosedError(error)) {
        setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
      }
    } finally {
      setEditingSubmitting(false);
    }
  }, [editingMessageId, editingSubmitting, editingText, hydrateSnapshot, messages, readAgentSnapshot, running, t]);

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const alreadyRunning = running;
    const queued = alreadyRunning;
    const messageImages = attachments.map(({ data, mimeType }) => ({ data, mimeType }));
    const images = messageImages.map((image) => ({ type: "image", ...image }));
    setRunning(true);
    try {
      setDraft("");
      setMessages((current) => [...current, optimisticUserMessage(text || t("composer.attachedImage"), queued, messageImages)]);
      setAttachments([]);
      await window.dscode.agent.command(alreadyRunning ? "steer" : "prompt", {
        message: text || t("composer.describeImage"),
        ...(images.length ? { images } : {}),
      });
    } catch (error) {
      if (isAgentSessionClosedError(error)) {
        setRunning(false);
        return;
      }
      setRunning(alreadyRunning);
      setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
    }
  };

  const stopAgent = async () => {
    await window.dscode.agent.command("abort").catch(() => undefined);
    setRunning(false);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const addImageAttachments = async (files: File[]) => {
    const images = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
    if (images.length === 0) return;
    try {
      const next = await Promise.all(images.map(fileToAttachment));
      setAttachments((current) => [...current, ...next].slice(0, 5));
    } catch (error) {
      setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
    }
  };

  const handleAttachment = async (event: ChangeEvent<HTMLInputElement>) => {
    await addImageAttachments(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
    if (images.length === 0) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void addImageAttachments(images);
  };

  const changeModel = async (value: string) => {
    const selected = availableModels.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
    if (!selected) return;
    try {
      await window.dscode.agent.command("set_model", { provider: selected.provider, modelId: selected.id });
      setProvider(selected.provider as ProviderId);
      setModel(selected.id);
      void refreshSessionStats();
    } catch (error) {
      if (isAgentSessionClosedError(error)) return;
      setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
    }
  };

  const changePermission = async (next: PermissionMode) => {
    if (next === permission || permissionUpdating) return;
    const previous = permission;
    setPermission(next);
    setPermissionUpdating(true);
    try {
      const started = await startAgent(
        activeCwdRef.current,
        activeSession,
        { permission: next },
        workspace,
        { background: true },
      );
      if (!started) setPermission(previous);
    } finally {
      setPermissionUpdating(false);
    }
  };

  const changeTheme = async (id: string | null) => {
    setThemeId(id);
    applyTheme(themes.find((item) => item.id === id) ?? null);
    try {
      await window.dscode.themes.setActive(id);
    } catch (error) {
      setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
    }
  };

  const refreshThemes = async () => {
    setThemes(await window.dscode.themes.list());
  };

  const previewFileCandidates = useMemo(() => {
    const seen = new Set<string>();
    const files: string[] = [];
    const addFile = (filePath: string | undefined) => {
      if (
        !filePath
        || seen.has(filePath)
        || files.length === 6
        || !isPreviewPathInWorkspace(filePath, activeCwdRef.current)
      ) return;
      seen.add(filePath);
      files.push(filePath);
    };
    for (const message of [...messages].reverse()) {
      for (const filePath of previewPathsFromText(message.text)) addFile(filePath);
      for (const tool of [...message.tools].reverse()) {
        addFile(toolFilePath(tool));
        for (const filePath of previewPathsFromText(tool.output ?? "")) addFile(filePath);
      }
      if (files.length === 6) break;
    }
    const previous = previewFileCandidatesRef.current;
    if (sameStringArray(previous, files)) return previous;
    previewFileCandidatesRef.current = files;
    return files;
  }, [activeSession, messages, workspace]);

  useEffect(() => {
    let cancelled = false;
    const filesApi = window.dscode.files;
    if (!filesApi?.validPreviewPaths || previewFileCandidates.length === 0) {
      setRecentPreviewFiles([]);
      return () => { cancelled = true; };
    }
    void filesApi.validPreviewPaths(previewFileCandidates)
      .then((files) => {
        if (!cancelled) setRecentPreviewFiles(files.slice(0, 6));
      })
      .catch(() => {
        if (!cancelled) setRecentPreviewFiles([]);
      });
    return () => { cancelled = true; };
  }, [activeSession, previewFileCandidates, workspace]);
  const handlePreviewFile = useCallback((filePath: string) => {
    void openFilePreview(filePath);
  }, [openFilePreview]);
  const conversationGroups = useMemo(() => groupConversation(messages), [messages]);
  const editableUserMessageId = [...conversationGroups].reverse().find((group) => group.type === "user")?.id;
  const latestAssistantGroup = [...conversationGroups].reverse().find((group) => group.type === "assistant");
  const activityRunning = running && !editingSubmitting;
  const latestAssistantIsActive = activityRunning && latestAssistantGroup?.type === "assistant"
    && isAssistantTurnActive(latestAssistantGroup.messages);
  const activeAssistantGroupId = latestAssistantIsActive ? latestAssistantGroup?.id : undefined;
  const activeAssistantHasWork = latestAssistantIsActive && latestAssistantGroup?.type === "assistant"
    && splitAssistantTurn(latestAssistantGroup.messages, true).work.length > 0;
  const projectPaths = useMemo(() => new Set(workspaces.map((item) => item.path)), [workspaces]);

  const showPreviewPanel = () => {
    setContextCardOpen(false);
    setPreviewError(undefined);
    setInspectorOpen(true);
  };

  const closePreviewPanel = () => {
    previewRequestRef.current += 1;
    setPreviewLoading(false);
    setPreviewError(undefined);
    setInspectorOpen(false);
  };

  const inspectorWidthBounds = () => {
    const layoutWidth = threadLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return inspectorBoundsForLayout(layoutWidth);
  };

  const resizeInspectorByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    const bounds = inspectorWidthBounds();
    if (event.key === "Home") {
      setInspectorWidth(Math.min(DEFAULT_INSPECTOR_WIDTH, bounds.max));
      return;
    }
    const delta = event.key === "ArrowLeft" ? 24 : -24;
    setInspectorWidth((current) => Math.min(bounds.max, Math.max(bounds.min, current + delta)));
  };

  const startInspectorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    inspectorResizeCleanupRef.current();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const bounds = inspectorWidthBounds();
    document.body.classList.add("inspector-resizing");

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      setInspectorWidth(Math.min(bounds.max, Math.max(bounds.min, nextWidth)));
    };
    const stopResizing = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      document.body.classList.remove("inspector-resizing");
      inspectorResizeCleanupRef.current = () => undefined;
    };
    inspectorResizeCleanupRef.current = stopResizing;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
  };

  const projectSessions = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const item of workspaces) grouped.set(item.path, []);
    for (const session of sessions) grouped.get(session.cwd)?.push(session);
    return grouped;
  }, [sessions, workspaces]);
  const filteredWorkspaces = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter((item) => (
      `${item.name} ${item.path}`.toLowerCase().includes(query)
      || projectSessions.get(item.path)?.some((session) => session.title.toLowerCase().includes(query))
    ));
  }, [projectSessions, sessionQuery, workspaces]);
  const recentTasks = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    const tasks = sessions.filter((session) => !projectPaths.has(session.cwd));
    return query ? tasks.filter((session) => session.title.toLowerCase().includes(query)) : tasks;
  }, [projectPaths, sessionQuery, sessions]);
  const activeTitle = sessions.find((session) => session.path === activeSession)?.title ?? (messages[0]?.text || t("status.newThread"));
  const workspaceName = workspace ? workspace.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
  const selectedModel = availableModels.find((candidate) => candidate.provider === provider && candidate.id === model);

  return (
    <div className={`app-shell${sidebarOpen ? "" : " sidebar-is-collapsed"}${window.dscode.platform === "darwin" ? " platform-macos" : ""}`}>
      <aside className={`sidebar ${sidebarOpen ? "" : "sidebar-collapsed"}`} inert={!sidebarOpen}>
        <div className="sidebar-titlebar">
          <div className="sidebar-product-title"><strong>DSCode</strong></div>
          <button
            className="icon-button sidebar-search-trigger"
            onClick={() => {
              setSessionQuery("");
              setSearchOpen(true);
            }}
            aria-label={t("sidebar.searchThreads")}
          >
            <Search size={14} />
          </button>
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label={t("sidebar.hide")}>
            <PanelLeft size={16} />
          </button>
        </div>

        <div className="sidebar-primary">
          <button className="new-thread-button" onClick={() => void createNewThread()}><Plus size={16} /> {t("sidebar.newThread")} <kbd>⌘N</kbd></button>
        </div>

        <div className="thread-list">
          <button type="button" className="section-label section-toggle" onClick={() => setProjectsSectionOpen((open) => !open)} aria-expanded={projectsSectionOpen}>
            <span>{t("sidebar.projects")}</span>
            <ChevronRight size={12} />
          </button>
          {projectsSectionOpen && <>
            {filteredWorkspaces.length === 0 && <div className="sidebar-empty">{t("sidebar.noProjects")}</div>}
            {filteredWorkspaces.map((item) => {
              const tasks = projectSessions.get(item.path) ?? [];
              const query = sessionQuery.trim().toLowerCase();
              const matchingTasks = query
                ? tasks.filter((session) => session.title.toLowerCase().includes(query))
                : tasks;
              const taskSource = query && matchingTasks.length > 0 ? matchingTasks : tasks;
              const isExpanded = expandedProjects.has(item.path) || Boolean(query);
              const showAll = fullyExpandedProjects.has(item.path) || Boolean(query);
              const visibleTasks = showAll ? taskSource : taskSource.slice(0, PROJECT_TASK_PREVIEW_COUNT);
              return (
                <div className="project-group" key={item.path}>
                  <button
                    className={`project-row ${workspace === item.path && !activeSession ? "active" : ""}`}
                    onClick={() => toggleWorkspace(item)}
                    title={item.path}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                    <strong>{item.name}</strong>
                  </button>
                  {isExpanded && (
                    <div className="project-task-list">
                      {visibleTasks.length === 0 && <div className="project-task-empty">{t("sidebar.noProjectTasks")}</div>}
                      {visibleTasks.map((session) => (
                        <div className="session-row project-session-row" key={session.path}>
                          <button
                            className={`project-task-row ${session.path === activeSession ? "active" : ""}`}
                            onClick={() => void openSession(session)}
                            title={session.title}
                            aria-current={session.path === activeSession ? "page" : undefined}
                          >
                            <SidebarSessionTitle>{session.title}</SidebarSessionTitle>
                          </button>
                          <button
                            type="button"
                            className="session-delete-button"
                            onClick={() => void deleteSession(session)}
                            aria-label={t("sidebar.deleteSession")}
                            title={t("sidebar.deleteSession")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {!query && taskSource.length > PROJECT_TASK_PREVIEW_COUNT && (
                        <button
                          className="project-task-more"
                          onClick={() => setFullyExpandedProjects((current) => {
                            const next = new Set(current);
                            if (next.has(item.path)) next.delete(item.path);
                            else next.add(item.path);
                            return next;
                          })}
                        >
                          {showAll ? t("sidebar.showLess") : t("sidebar.showMore")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>}

          <button type="button" className="section-label section-toggle recent-label" onClick={() => setRecentSectionOpen((open) => !open)} aria-expanded={recentSectionOpen}>
            <span>{t("sidebar.recent")}</span>
            <ChevronRight size={12} />
          </button>
          {recentSectionOpen && <>
            {recentTasks.length === 0 && <div className="sidebar-empty">{t("sidebar.noRecentTasks")}</div>}
            {recentTasks.map((session) => (
              <div className="session-row recent-session-row" key={session.path}>
                <button
                  className={`thread-row recent-task-row ${session.path === activeSession ? "active" : ""}`}
                  onClick={() => void openSession(session)}
                >
                  <span className="thread-copy"><SidebarSessionTitle>{session.title}</SidebarSessionTitle><small>{relativeTime(session.updatedAt, locale, t("status.now"))}</small></span>
                  <span className="task-dot" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="session-delete-button"
                  onClick={() => void deleteSession(session)}
                  aria-label={t("sidebar.deleteSession")}
                  title={t("sidebar.deleteSession")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </>}
        </div>

        <div className="sidebar-footer" ref={sidebarFooterRef}>
          {accountMenuOpen && (
            <div className="sidebar-account-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <Settings size={16} />
                <span>{t("sidebar.settings")}</span>
                <kbd>⌘,</kbd>
              </button>
            </div>
          )}
          <button
            className="sidebar-account-button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <ProfileAvatar profile={profile} className="sidebar-account-avatar" />
            <strong>{profile.nickname}</strong>
          </button>
        </div>
      </aside>

      <main className="main-pane">
        <div className="thread-layout" ref={threadLayoutRef}>
          <div className="conversation-column">
            <header className="thread-header">
              <div className="header-left">
                {!sidebarOpen && <button className="icon-button sidebar-reveal" onClick={() => setSidebarOpen(true)} aria-label={t("sidebar.show")}><PanelLeft size={16} /></button>}
                <div className="thread-heading"><strong>{crop(activeTitle, 62)}</strong><span>{workspace ? <GitBranch size={12} /> : <MessageSquareText size={12} />} {workspaceName ?? t("status.regularTask")}</span></div>
              </div>
              {!inspectorOpen && <div className="header-actions">
                <button
                  className={`icon-button context-card-toggle ${contextCardOpen ? "selected" : ""}`}
                  onClick={() => {
                    const next = !contextCardOpen;
                    setContextCardOpen(next);
                    if (next) setInspectorOpen(false);
                  }}
                  aria-label={contextCardOpen ? t("toolbar.hideContext") : t("toolbar.showContext")}
                  aria-pressed={contextCardOpen}
                >
                  <ListFilter size={16} />
                </button>
                <button
                  className="icon-button"
                  onClick={showPreviewPanel}
                  aria-label={t("toolbar.openSidebar")}
                  aria-pressed="false"
                >
                  <PanelRight size={17} />
                </button>
              </div>}
            </header>

            <section className={`conversation-pane${contextCardOpen ? " context-card-visible" : ""}`}>
            <div
              className="message-scroll"
              ref={scrollRef}
              onScroll={handleConversationScroll}
              onWheel={handleConversationWheel}
            >
              {loading ? (
                <div className="loading-state"><LoaderCircle className="spin" size={20} /><span>{t("status.openingWorkspace")}</span></div>
              ) : messages.length === 0 && !uiRequest ? (
                <EmptyState workspace={workspace} onSuggest={(value) => { setDraft(value); textareaRef.current?.focus(); }} />
              ) : (
                <div className="messages">
                  {conversationGroups.map((group) => (
                    group.type === "user"
                      ? <UserMessage
                          key={group.id}
                          message={group.message}
                          onPreview={setPreviewImage}
                          onEdit={editMessage}
                          editable={group.id === editableUserMessageId}
                          editing={editingMessageId === group.message.id}
                          disabled={running}
                          editingText={editingText}
                          editingSubmitting={editingSubmitting}
                          onEditChange={setEditingText}
                          onEditSubmit={() => void submitEditingMessage()}
                          onEditCancel={cancelEditingMessage}
                        />
                      : <AssistantTurn
                          key={group.id}
                          messages={group.messages}
                          active={group.id === activeAssistantGroupId}
                          showReasoningProcess={showReasoningProcess}
                          onPreviewFile={handlePreviewFile}
                        />
                  ))}
                  {activityRunning && !uiRequest && !activeAssistantHasWork && (
                    <div className="work-log active" role="status" aria-live="polite">
                      <div className="work-log-summary work-log-status">
                        <LoaderCircle className="spin work-log-spinner" size={14} aria-hidden="true" />
                        <span>{t("work.thinkingStatus")}</span>
                      </div>
                    </div>
                  )}
                  {uiRequest && (
                    <InlineExtensionRequest
                      key={uiRequest.id}
                      request={uiRequest}
                      onDone={() => setUiRequest(undefined)}
                      onError={(message) => setToast({ message, type: "error" })}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="composer-wrap">
              <div className="composer-stack">
                {messages.length === 0 && (
                  <button
                    type="button"
                    className={`composer-workspace ${workspace ? "selected" : ""}`}
                    onClick={() => void chooseWorkspace()}
                    disabled={loading || running}
                    title={workspace ?? t("composer.selectProject")}
                    aria-label={workspace ? t("composer.changeProject") : t("composer.selectProject")}
                  >
                    <FolderOpen size={15} />
                    <span>{workspaceName ?? workspace ?? t("composer.selectProject")}</span>
                  </button>
                )}
                <div className={`composer ${running ? "composer-running" : ""}`}>
                  {attachments.length > 0 && (
                    <div className="attachment-strip">
                      {attachments.map((attachment, index) => (
                        <div className="attachment-preview" key={`${attachment.name}-${index}`}>
                          <button
                            type="button"
                            className="attachment-thumbnail"
                            onClick={() => setPreviewImage({ ...attachment, alt: attachment.name })}
                            title={attachment.name}
                          >
                            <img src={imageDataUrl(attachment)} alt={attachment.name} />
                          </button>
                          <button
                            type="button"
                            className="attachment-remove"
                            onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                            aria-label={t("composer.removeImage")}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={handleComposerPaste}
                    placeholder={running ? t("composer.runningPrompt") : t("composer.prompt")}
                    rows={1}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-tools">
                      <AttachmentMenu onChange={(event) => void handleAttachment(event)} />
                      <PermissionPicker
                        value={permission}
                        updating={permissionUpdating}
                        onChange={(value) => void changePermission(value)}
                      />
                    </div>
                    <div className="composer-actions">
                      <ModelPicker
                        provider={provider}
                        model={model}
                        models={availableModels}
                        onChange={(value) => void changeModel(value)}
                      />
                      <button
                        className={`send-button ${running ? "stop-button" : ""}`}
                        onClick={() => running && !draft.trim() && attachments.length === 0 ? void stopAgent() : void sendMessage()}
                        disabled={!running && !draft.trim() && attachments.length === 0}
                        aria-label={running ? t("composer.sendOrStop") : t("composer.send")}
                      >
                        {running && !draft.trim() && attachments.length === 0 ? <CircleStop size={17} /> : <ArrowUp size={17} />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="composer-caption">{t("composer.caption")}</div>
            </div>
            {contextCardOpen && (
              <ContextCard
                stats={sessionStats}
                contextWindow={selectedModel?.contextWindow}
                provider={provider}
                model={model}
                running={running}
              />
            )}
            </section>
          </div>

          {inspectorOpen && (
            <>
              <div
                className="inspector-resizer"
                role="separator"
                aria-label={t("toolbar.resizeSidebar")}
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={MAX_INSPECTOR_WIDTH}
                aria-valuenow={Math.round(inspectorWidth)}
                tabIndex={0}
                onPointerDown={startInspectorResize}
                onKeyDown={resizeInspectorByKeyboard}
                onDoubleClick={() => setInspectorWidth(DEFAULT_INSPECTOR_WIDTH)}
              />
              <FilePreviewPanel
                width={inspectorWidth}
                preview={filePreview}
                loading={previewLoading}
                error={previewError}
                recentFiles={recentPreviewFiles}
                onChoose={() => void choosePreviewFile()}
                onPreview={(filePath) => void openFilePreview(filePath)}
                onRefresh={() => filePreview && void openFilePreview(filePreview.path)}
                onOpenExternal={() => filePreview && void window.dscode.files.openPreview(filePreview.id).catch((error) => {
                  setToast({ message: cleanError(error instanceof Error ? error.message : String(error)), type: "error" });
                })}
                onClose={closePreviewPanel}
              />
            </>
          )}
        </div>
      </main>

      {settingsOpen && (
        <SettingsDialog
          providers={providers}
          provider={provider}
          permission={permission}
          sandbox={sandbox}
          themes={themes}
          themeId={themeId}
          profile={profile}
          showReasoningProcess={showReasoningProcess}
          personalization={personalization}
          onClose={() => setSettingsOpen(false)}
          onRefresh={async () => setProviders(await window.dscode.auth.status())}
          onConnected={async (value) => {
            const nextProviders = await window.dscode.auth.status();
            const connected = nextProviders.find((item) => item.id === value);
            const nextModel = connected?.defaultModel ?? model;
            const nextEffort = value === "deepseek" ? "max" : "medium";
            setProviders(nextProviders);
            setProvider(value);
            setModel(nextModel);
            setEffort(nextEffort);
            await startAgent(
              activeCwdRef.current,
              activeSession,
              { provider: value, model: nextModel, effort: nextEffort },
              workspace,
              { providerStatuses: nextProviders },
            );
          }}
          onPermission={setPermission}
          onSandbox={setSandbox}
          onTheme={(id) => void changeTheme(id)}
          onRefreshThemes={() => void refreshThemes()}
          onProfile={async (nextProfile) => {
            await window.dscode.settings.setProfile(nextProfile);
            setProfile(nextProfile);
          }}
          onShowReasoningProcess={async (value) => {
            const previous = showReasoningProcess;
            setShowReasoningProcess(value);
            try {
              await window.dscode.settings.setShowReasoningProcess(value);
            } catch (error) {
              setShowReasoningProcess(previous);
              throw error;
            }
          }}
          onPersonalization={async (nextPersonalization) => {
            await window.dscode.settings.setPersonalization(nextPersonalization);
            setPersonalization(nextPersonalization);
          }}
          onAuthStart={() => { authCancellationRef.current = false; }}
          consumeAuthCancellation={() => {
            const cancelled = authCancellationRef.current;
            authCancellationRef.current = false;
            return cancelled;
          }}
          onToast={(message, type = "info") => setToast({ message, type })}
        />
      )}
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNew={() => void createNewThread()} onOpen={() => void chooseWorkspace()} onSettings={() => setSettingsOpen(true)} onInspector={showPreviewPanel} />}
      {searchOpen && (
        <SessionSearchDialog
          sessions={sessions}
          workspaces={workspaces}
          activeSession={activeSession}
          query={sessionQuery}
          onQuery={setSessionQuery}
          onClose={() => {
            setSearchOpen(false);
            setSessionQuery("");
          }}
          onOpen={(session) => void openSession(session)}
          onNew={() => void createNewThread()}
        />
      )}
      {authEvent?.kind === "prompt" && <AuthPromptDialog event={authEvent} onDone={() => setAuthEvent(undefined)} onCancel={() => { authCancellationRef.current = true; setAuthEvent(undefined); }} />}
      {authEvent?.kind === "notice" && <AuthNotice event={authEvent} onClose={() => setAuthEvent(undefined)} />}
      {previewImage && <ImageLightbox image={previewImage} onClose={() => setPreviewImage(undefined)} />}
      {toast && <div className={`toast ${toast.type}`}><span>{toast.type === "error" ? <CircleAlert size={16} /> : <Check size={16} />}{toast.message}</span><button onClick={() => setToast(undefined)}><X size={14} /></button></div>}
    </div>
  );
}

function ContextCard({
  stats,
  contextWindow,
  provider,
  model,
  running,
}: {
  stats?: AgentSessionStats;
  contextWindow?: number;
  provider: ProviderId;
  model: string;
  running: boolean;
}) {
  const { t } = useI18n();
  const reportedContext = stats?.contextUsage;
  const capacity = reportedContext?.contextWindow ?? contextWindow;
  const used = reportedContext?.tokens ?? null;
  const calculatedPercent = used !== null && capacity ? (used / capacity) * 100 : null;
  const contextPercent = clampPercent(reportedContext?.percent ?? calculatedPercent);
  const remaining = used !== null && capacity ? Math.max(0, capacity - used) : null;
  const promptTokens = stats
    ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite
    : 0;
  const cacheRate = promptTokens > 0
    ? clampPercent((stats!.tokens.cacheRead / promptTokens) * 100)
    : null;
  const hasUsage = Boolean(stats && stats.tokens.total > 0);

  return (
    <aside className="context-rail" aria-label={t("context.title")}>
      <section className={`context-card${running ? " active" : ""}`}>
        <header className="context-card-header">
          <span><Gauge size={15} /> <strong>{t("context.title")}</strong></span>
          {running && <i className="context-live-dot" aria-label={t("status.working")} />}
        </header>

        <div className="context-capacity">
          <div
            className={`context-ring${contextPercent === null ? " empty" : ""}`}
            aria-label={`${t("context.capacity")}: ${formatPercent(contextPercent)}`}
          >
            <svg viewBox="0 0 42 42" aria-hidden="true">
              <circle className="context-ring-track" cx="21" cy="21" r="17" pathLength="100" />
              <circle
                className="context-ring-value"
                cx="21"
                cy="21"
                r="17"
                pathLength="100"
                strokeDasharray={`${contextPercent ?? 0} 100`}
              />
            </svg>
            <span><strong>{formatPercent(contextPercent)}</strong><small>{t("context.used")}</small></span>
          </div>
          <div className="context-capacity-copy">
            <span>{t("context.capacity")}</span>
            <strong title={used === null ? undefined : used.toLocaleString()}>
              {formatCompactTokens(used)} <small>/ {formatCompactTokens(capacity)}</small>
            </strong>
            <small>{remaining === null ? t("context.empty") : t("context.remaining", { tokens: formatCompactTokens(remaining) })}</small>
          </div>
        </div>

        <div className="context-card-section">
          <div className="context-section-heading">
            <span>{t("context.total")}</span>
            <strong title={stats?.tokens.total.toLocaleString()}>{formatCompactTokens(stats?.tokens.total)}</strong>
          </div>
          <div className="context-token-grid">
            <div><span>{t("context.input")}</span><strong title={stats?.tokens.input.toLocaleString()}>{formatCompactTokens(stats?.tokens.input)}</strong></div>
            <div><span>{t("context.output")}</span><strong title={stats?.tokens.output.toLocaleString()}>{formatCompactTokens(stats?.tokens.output)}</strong></div>
          </div>
        </div>

        <div className="context-card-section context-cache-section">
          <div className="context-section-heading">
            <span>{t("context.cache")}</span>
            <strong>{formatPercent(cacheRate)}</strong>
          </div>
          <div className="context-cache-track" aria-hidden="true"><span style={{ width: `${cacheRate ?? 0}%` }} /></div>
          <div className="context-cache-values">
            <span>{t("context.cacheRead")} <strong>{formatCompactTokens(stats?.tokens.cacheRead)}</strong></span>
            <span>{t("context.cacheWrite")} <strong>{formatCompactTokens(stats?.tokens.cacheWrite)}</strong></span>
          </div>
        </div>

        <footer className="context-card-footer">
          <div><span>{t("context.model")}</span><strong title={`${provider}/${model}`}>{shortModel(model)}</strong></div>
          <div><span>{t("context.cost")}</span><strong>{hasUsage ? formatCost(stats?.cost ?? 0) : "—"}</strong></div>
        </footer>
      </section>
    </aside>
  );
}

function EmptyState({ workspace, onSuggest }: { workspace?: string; onSuggest(value: string): void }) {
  const { t } = useI18n();
  const suggestions = workspace
    ? [
        { icon: Code2, text: t("suggestion.explainCodebase") },
        { icon: CircleAlert, text: t("suggestion.fixBug") },
        { icon: Sparkles, text: t("suggestion.buildFeature") },
      ]
    : [
        { icon: MessageSquareText, text: t("suggestion.answerQuestion") },
        { icon: FileCode2, text: t("suggestion.draftPlan") },
        { icon: Sparkles, text: t("suggestion.brainstorm") },
      ];
  return (
    <div className="empty-state">
      <div className="empty-brand"><span className="brand-mark large"><span /></span></div>
      <h1>{workspace ? t("empty.title") : t("empty.noWorkspaceTitle")}</h1>
      <p>{workspace ? t("empty.description") : t("empty.noWorkspaceDescription")}</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => <button key={suggestion.text} onClick={() => onSuggest(suggestion.text)}><suggestion.icon size={16} />{suggestion.text}</button>)}
      </div>
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  message,
  onPreview,
  onEdit,
  editable,
  editing,
  disabled,
  editingText,
  editingSubmitting,
  onEditChange,
  onEditSubmit,
  onEditCancel,
}: {
  message: ChatMessage;
  onPreview(image: PreviewImage): void;
  onEdit(message: ChatMessage): void;
  editable: boolean;
  editing: boolean;
  disabled: boolean;
  editingText: string;
  editingSubmitting: boolean;
  onEditChange(value: string): void;
  onEditSubmit(): void;
  onEditCancel(): void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    if (!message.text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.text);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = message.text;
        fallback.setAttribute("readonly", "true");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`user-message-row${editing ? " is-editing" : ""}`}>
      <div className={`user-message${message.images.length > 0 ? " has-images" : ""}${editing ? " is-editing" : ""}`}>
        {message.images.length > 0 && (
          <div className={`message-images${message.images.length > 1 ? " multiple" : ""}`}>
            {message.images.map((image, index) => (
              <button
                type="button"
                className="message-image-button"
                key={`${image.mimeType}-${index}`}
                onClick={() => onPreview({ ...image, alt: t("composer.imageNumber", { number: index + 1 }) })}
                aria-label={t("composer.previewImage")}
              >
                <img src={imageDataUrl(image)} alt={t("composer.imageNumber", { number: index + 1 })} />
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <textarea
            className="user-message-editor"
            value={editingText}
            onChange={(event) => onEditChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onEditCancel();
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onEditSubmit();
              }
            }}
            autoFocus
            rows={Math.min(8, Math.max(2, editingText.split("\n").length))}
            disabled={editingSubmitting}
            aria-label={t("conversation.editMessage")}
          />
        ) : message.text ? <div className="user-message-text">{message.text}</div> : null}
        {message.queued && <small>{t("status.queued")}</small>}
      </div>
      {(editable || message.text) && (
        <div className="user-message-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="message-action-button message-cancel-button"
                onClick={onEditCancel}
                disabled={editingSubmitting}
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
              >
                <X size={13} />
              </button>
              <button
                type="button"
                className="message-action-button message-submit-button"
                onClick={onEditSubmit}
                disabled={editingSubmitting || (!editingText.trim() && message.images.length === 0)}
                title={t("composer.send")}
                aria-label={t("composer.send")}
              >
                {editingSubmitting ? <LoaderCircle className="spin" size={13} /> : <ArrowUp size={13} />}
              </button>
            </>
          ) : (
            <>
              {editable && (
                <button
                  type="button"
                  className="message-action-button message-edit-button"
                  onClick={() => onEdit(message)}
                  disabled={disabled}
                  title={t("conversation.editMessage")}
                  aria-label={t("conversation.editMessage")}
                >
                  <Pencil size={13} />
                </button>
              )}
              {message.text && (
                <button
                  type="button"
                  className="message-action-button message-copy-button"
                  onClick={() => void copyMessage()}
                  title={copied ? t("conversation.messageCopied") : t("conversation.copyMessage")}
                  aria-label={copied ? t("conversation.messageCopied") : t("conversation.copyMessage")}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ImageLightbox({ image, onClose }: { image: PreviewImage; onClose(): void }) {
  const { t } = useI18n();
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("composer.imagePreview")}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <button type="button" className="image-lightbox-close" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button>
      <img src={imageDataUrl(image)} alt={image.alt} />
    </div>
  );
}

const AssistantTurn = memo(function AssistantTurn({
  messages,
  active,
  showReasoningProcess,
  onPreviewFile,
}: {
  messages: ChatMessage[];
  active: boolean;
  showReasoningProcess: boolean;
  onPreviewFile(filePath: string): void;
}) {
  const { work, responses } = splitAssistantTurn(messages, active);

  return (
    <article className="assistant-message">
      {work.length > 0 && (
        <WorkLog
          messages={messages}
          timeline={work}
          active={active}
          showReasoningProcess={showReasoningProcess}
          onPreviewFile={onPreviewFile}
        />
      )}
      {responses.map((response) => (
        <div className="assistant-response" key={response.key}>
          <MarkdownContent text={response.text} onPreviewFile={onPreviewFile} />
          {response.streaming && <span className="stream-cursor" />}
        </div>
      ))}
    </article>
  );
}, (previous, next) => (
  previous.active === next.active
  && previous.showReasoningProcess === next.showReasoningProcess
  && previous.onPreviewFile === next.onPreviewFile
  && previous.messages.length === next.messages.length
  && previous.messages.every((message, index) => message === next.messages[index])
));

function MarkdownContent({ text, className = "markdown-body", onPreviewFile }: { text: string; className?: string; onPreviewFile?(filePath: string): void }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ children, href }) => {
          const filePath = previewPathFromHref(href);
          return filePath && onPreviewFile
            ? <button type="button" className="markdown-file-link" onClick={() => onPreviewFile(filePath)}>{children}</button>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
        code: ({ children, className: codeClassName }) => <code className={codeClassName}>{children}</code>,
      }}>{text}</ReactMarkdown>
    </div>
  );
}

function WorkLog({
  messages,
  timeline,
  active,
  showReasoningProcess,
  onPreviewFile,
}: {
  messages: ChatMessage[];
  timeline: TurnWorkEntry[];
  active: boolean;
  showReasoningProcess: boolean;
  onPreviewFile(filePath: string): void;
}) {
  const { t } = useI18n();
  const failed = messages.some((message) => message.tools.some((tool) => tool.status === "error"));
  const activity = getAssistantActivity(messages);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const latestWork = timeline.at(-1);
  const latestWorkLabel = latestWorkSummary(latestWork, t);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const duration = workDuration(messages, active ? now : undefined);
  const latestWorkKey = timeline.at(-1)?.key;
  return (
    <section className={`work-log ${open ? "open" : ""} ${active ? "active" : "complete"}`}>
      <button
        className="work-log-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {active && <LoaderCircle className="spin work-log-spinner" size={14} aria-hidden="true" />}
        <span aria-live="polite">
          {active
            ? latestWorkLabel ?? t(activity === "tool" ? "work.toolStatus" : "work.thinkingStatus")
            : failed
              ? t("work.processedErrors")
              : t("work.processed")}
        </span>
        {duration !== undefined && <time>{formatElapsed(duration)}</time>}
        <ChevronDown className="work-log-chevron" size={15} />
      </button>
      {open && (
        <div className="work-log-content">
          <div className="work-timeline">
            {timeline.map(({ message, item, key }) => {
              if (item.type === "thinking") return (
                <ReasoningBlock
                  key={key}
                  text={item.text}
                  active={active && key === latestWorkKey}
                  autoExpand={showReasoningProcess}
                />
              );
              if (item.type === "text") return <MarkdownContent key={key} text={item.text} className="work-text markdown-body" onPreviewFile={onPreviewFile} />;
              const tool = message.tools.find((candidate) => candidate.id === item.toolId);
              return tool ? <ToolRow key={key} tool={tool} onPreviewFile={onPreviewFile} /> : null;
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function latestWorkSummary(entry: TurnWorkEntry | undefined, t: Translator): string | undefined {
  if (!entry) return undefined;
  if (entry.item.type === "tool") {
    const toolId = entry.item.toolId;
    const tool = entry.message.tools.find((candidate) => candidate.id === toolId);
    return tool ? toolDisplayTitle(tool, t) : t("work.toolStatus");
  }

  const lines = entry.item.text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const lastLine = lines.at(-1);
  return lastLine ? crop(lastLine, 120) : undefined;
}

function ReasoningBlock({ text, active, autoExpand }: { text: string; active: boolean; autoExpand: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(active && autoExpand);
  const previousAutoExpand = useRef(autoExpand);

  useEffect(() => {
    if (active && previousAutoExpand.current !== autoExpand) setOpen(autoExpand);
    previousAutoExpand.current = autoExpand;
  }, [active, autoExpand]);

  return (
    <div className={`reasoning-block ${open ? "open" : ""}`}>
      <button className="reasoning-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Sparkles size={13} />
        <span>{t("work.reasoning")}</span>
        <ChevronDown className="reasoning-chevron" size={13} />
      </button>
      {open && <p>{text}</p>}
    </div>
  );
}

function FilePreviewPanel(props: {
  width: number;
  preview?: FilePreview;
  loading: boolean;
  error?: string;
  recentFiles: string[];
  onChoose(): void;
  onPreview(filePath: string): void;
  onRefresh(): void;
  onOpenExternal(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const { preview } = props;
  return (
    <aside className="inspector preview-panel" style={{ width: props.width, flexBasis: props.width }}>
      <div className="preview-header">
        <div className="preview-heading">
          <span className="preview-file-icon"><FileIcon size={15} /></span>
          <span>
            <strong>{preview?.name ?? t("preview.title")}</strong>
            <small title={preview?.path}>{preview?.path ?? t("preview.noFile")}</small>
          </span>
        </div>
        <div className="preview-actions">
          <button className="icon-button" onClick={props.onChoose} title={t("preview.chooseFile")} aria-label={t("preview.chooseFile")}><FolderOpen size={15} /></button>
          {preview && <button className="icon-button" onClick={props.onRefresh} title={t("preview.refresh")} aria-label={t("preview.refresh")}><RefreshCwIcon /></button>}
          {preview && <button className="icon-button" onClick={props.onOpenExternal} title={t("preview.openExternal")} aria-label={t("preview.openExternal")}><ExternalLink size={14} /></button>}
          <button className="icon-button" onClick={props.onClose} aria-label={t("common.close")}><X size={15} /></button>
        </div>
      </div>

      <div className="preview-stage">
        {props.loading && <div className="preview-loading"><LoaderCircle className="spin" size={18} /><span>{t("preview.loading")}</span></div>}
        {!props.loading && props.error && (
          <div className="preview-empty preview-error">
            <CircleAlert size={22} />
            <strong>{t("preview.cannotOpen")}</strong>
            <span>{props.error}</span>
            <button className="preview-secondary-button" onClick={props.onChoose}>{t("preview.chooseAnother")}</button>
          </div>
        )}
        {!props.loading && !props.error && !preview && (
          <div className="preview-empty">
            <span className="preview-empty-icon"><Eye size={23} /></span>
            <strong>{t("preview.emptyTitle")}</strong>
            <span>{t("preview.emptyDescription")}</span>
            <button className="preview-primary-button" onClick={props.onChoose}><FolderOpen size={14} />{t("preview.chooseFile")}</button>
            {props.recentFiles.length > 0 && (
              <div className="preview-recent">
                <small>{t("preview.recentFiles")}</small>
                {props.recentFiles.map((filePath) => (
                  <button key={filePath} onClick={() => props.onPreview(filePath)} title={filePath}>
                    <FileText size={13} />
                    <span>{fileNameFromPath(filePath)}</span>
                    <Eye size={12} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!props.loading && !props.error && preview && <FilePreviewBody preview={preview} onOpenExternal={props.onOpenExternal} />}
      </div>

      {preview && !props.loading && !props.error && (
        <div className="preview-statusbar">
          <span>{preview.extension ? preview.extension.toUpperCase() : t("preview.file")}</span>
          <span>{formatFileSize(preview.size)}</span>
          <span>{new Date(preview.modifiedAt).toLocaleString()}</span>
        </div>
      )}
    </aside>
  );
}

function FilePreviewBody({ preview, onOpenExternal }: { preview: FilePreview; onOpenExternal(): void }) {
  const { t } = useI18n();
  if (preview.kind === "html") {
    return <iframe className="preview-frame" src={preview.url} title={preview.name} sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" />;
  }
  if (preview.kind === "image") {
    return <div className="preview-image"><img src={preview.url} alt={preview.name} /></div>;
  }
  if (preview.kind === "pdf") {
    return <iframe className="preview-frame preview-pdf" src={preview.url} title={preview.name} />;
  }
  if (preview.kind === "video") {
    return <div className="preview-media"><video src={preview.url} controls /></div>;
  }
  if (preview.kind === "audio") {
    return <div className="preview-media preview-audio"><FileIcon size={30} /><strong>{preview.name}</strong><audio src={preview.url} controls /></div>;
  }
  if (preview.tooLarge) {
    return (
      <div className="preview-empty">
        <FileCode2 size={24} />
        <strong>{t("preview.tooLarge")}</strong>
        <span>{t("preview.tooLargeDescription")}</span>
        <button className="preview-secondary-button" onClick={onOpenExternal}>{t("preview.openExternal")}</button>
      </div>
    );
  }
  if (preview.kind === "markdown") {
    return <div className="preview-document"><MarkdownContent text={preview.content ?? ""} /></div>;
  }
  if (preview.kind === "code" || preview.kind === "text") {
    return <pre className={`preview-source ${preview.kind}`}><code>{preview.content ?? ""}</code></pre>;
  }
  return (
    <div className="preview-empty">
      <FileIcon size={25} />
      <strong>{t("preview.unsupported")}</strong>
      <span>{t("preview.unsupportedDescription")}</span>
      <button className="preview-secondary-button" onClick={onOpenExternal}>{t("preview.openExternal")}</button>
    </div>
  );
}

function RefreshCwIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" /></svg>;
}

function ToolRow({ tool, onPreviewFile }: { tool: ToolActivity; onPreviewFile?(filePath: string): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasDetails = tool.args !== undefined || tool.output !== undefined;
  const filePath = toolFilePath(tool);
  const toolName = tool.name.toLowerCase();
  const plan = toolName === "update_plan" ? parseStructuredPlan(tool.args) : undefined;
  const Icon = toolName.includes("exec") || toolName.includes("bash") || toolName.includes("command")
    ? TerminalSquare
    : toolName.includes("plan")
      ? ListTodo
      : toolName.includes("search")
        ? Search
        : FileCode2;

  return (
    <div className={`tool-entry ${open ? "open" : ""}`}>
      <div className="tool-row-line">
        <button
          className={`tool-row ${hasDetails ? "" : "no-details"}`}
          onClick={() => hasDetails && setOpen((value) => !value)}
          aria-expanded={hasDetails ? open : undefined}
          aria-label={hasDetails ? t(open ? "work.hideDetails" : "work.showDetails", { tool: toolDisplayTitle(tool, t) }) : undefined}
        >
          <span className={`tool-state ${tool.status}`}>{tool.status === "running" ? <LoaderCircle className="spin" size={13} /> : tool.status === "error" ? <CircleAlert size={13} /> : <Check size={13} />}</span>
          <Icon size={14} />
          <span>{toolDisplayTitle(tool, t)}</span>
          {hasDetails && <ChevronDown className="tool-chevron" size={13} />}
        </button>
        {filePath && onPreviewFile && (
          <button type="button" className="tool-preview-action" onClick={() => onPreviewFile(filePath)} title={t("preview.openFile")} aria-label={t("preview.openFile")}>
            <Eye size={13} />
          </button>
        )}
      </div>
      {open && hasDetails && (
        <div className="tool-inline-detail">
          {plan
            ? <PlanTodoList plan={plan} />
            : tool.args !== undefined && <section><div className="detail-label">{t("inspector.input")}</div><pre>{formatToolArgs(tool)}</pre></section>}
          {tool.output !== undefined && (!plan || tool.status === "error") && <section><div className="detail-label">{t("inspector.output")}</div><pre>{tool.output || t("work.emptyOutput")}</pre></section>}
        </div>
      )}
    </div>
  );
}

function ProfileAvatar({ profile, className }: { profile: UserProfile; className: string }) {
  return (
    <span className={className} aria-hidden="true">
      {profile.avatarDataUrl
        ? <img src={profile.avatarDataUrl} alt="" />
        : profileInitials(profile.nickname)}
    </span>
  );
}

function SettingsDialog(props: {
  providers: ProviderStatus[];
  provider: ProviderId;
  permission: PermissionMode;
  sandbox: SandboxMode;
  themes: ThemeSummary[];
  themeId: string | null;
  profile: UserProfile;
  showReasoningProcess: boolean;
  personalization: PersonalizationSettings;
  onClose(): void;
  onRefresh(): Promise<void>;
  onConnected(value: ProviderId): Promise<void>;
  onPermission(value: PermissionMode): void;
  onSandbox(value: SandboxMode): void;
  onTheme(id: string | null): void;
  onRefreshThemes(): void;
  onProfile(profile: UserProfile): Promise<void>;
  onShowReasoningProcess(value: boolean): Promise<void>;
  onPersonalization(personalization: PersonalizationSettings): Promise<void>;
  onAuthStart(): void;
  consumeAuthCancellation(): boolean;
  onToast(message: string, type?: "info" | "error"): void;
}) {
  const { language, setLanguage, t } = useI18n();
  const [section, setSection] = useState<"general" | "personalization" | "models" | "agent" | "appearance" | "about">("general");
  const [selected, setSelected] = useState<ProviderId>(props.provider);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [reasoningPreferenceBusy, setReasoningPreferenceBusy] = useState(false);
  const [personalizationBusy, setPersonalizationBusy] = useState(false);
  const [personalizationTone, setPersonalizationTone] = useState<TonePreset>(props.personalization.tone);
  const [customInstructions, setCustomInstructions] = useState(props.personalization.customInstructions);
  const [profileNickname, setProfileNickname] = useState(props.profile.nickname);
  const [profileAvatar, setProfileAvatar] = useState(props.profile.avatarDataUrl);
  const selectedProvider = props.providers.find((provider) => provider.id === selected);
  const selectedTone = PERSONALIZATION_TONES.find((tone) => tone.id === personalizationTone) ?? PERSONALIZATION_TONES[0];
  const customInstructionLength = unicodeLength(customInstructions);
  const personalizationChanged = personalizationTone !== props.personalization.tone
    || customInstructions.trim() !== props.personalization.customInstructions;

  const connect = async () => {
    setBusy(true);
    try {
      if (selected === "openai-codex") {
        props.onAuthStart();
        const connected = await window.dscode.auth.login(selected);
        if (props.consumeAuthCancellation() || !connected) return;
      } else {
        if (!key.trim()) throw new Error(t("settings.enterApiKey"));
        await window.dscode.auth.saveApiKey(selected, key, selected === "deepseek" ? baseUrl : undefined);
      }
      setKey("");
      await props.onConnected(selected);
      props.onToast(t("settings.providerConnected", { provider: selectedProvider?.name ?? selected }));
    } catch (error) {
      if (props.consumeAuthCancellation() || isAuthPromptCancelledError(error)) return;
      props.onToast(cleanError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await window.dscode.auth.logout(selected);
    await props.onRefresh();
    props.onToast(t("settings.credentialRemoved"));
  };

  const changeLanguage = async (next: LanguagePreference) => {
    try {
      await setLanguage(next);
    } catch (error) {
      props.onToast(cleanError(error instanceof Error ? error.message : String(error)), "error");
    }
  };

  const changeAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) throw new Error("invalid avatar");
      setProfileAvatar(await fileToAvatarDataUrl(file));
    } catch {
      props.onToast(t("settings.avatarInvalid"), "error");
    }
  };

  const saveProfile = async () => {
    const nickname = profileNickname.trim();
    if (!nickname) return;
    setProfileBusy(true);
    try {
      await props.onProfile({ nickname, ...(profileAvatar ? { avatarDataUrl: profileAvatar } : {}) });
      setProfileNickname(nickname);
      props.onToast(t("settings.profileSaved"));
    } catch (error) {
      props.onToast(cleanError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setProfileBusy(false);
    }
  };

  const changeShowReasoningProcess = async (value: boolean) => {
    setReasoningPreferenceBusy(true);
    try {
      await props.onShowReasoningProcess(value);
    } catch (error) {
      props.onToast(cleanError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setReasoningPreferenceBusy(false);
    }
  };

  const changeCustomInstructions = (value: string) => {
    setCustomInstructions(Array.from(value).slice(0, MAX_CUSTOM_INSTRUCTION_LENGTH).join(""));
  };

  const savePersonalization = async () => {
    const nextPersonalization = {
      tone: personalizationTone,
      customInstructions: customInstructions.trim(),
    } satisfies PersonalizationSettings;
    setPersonalizationBusy(true);
    try {
      await props.onPersonalization(nextPersonalization);
      setCustomInstructions(nextPersonalization.customInstructions);
      props.onToast(t("settings.personalizationSaved"));
    } catch (error) {
      props.onToast(cleanError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setPersonalizationBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="settings-dialog">
        <button className="icon-button modal-close" onClick={props.onClose} aria-label={t("common.close")}><X size={17} /></button>
        <aside>
          <div className="settings-title">{t("settings.title")}</div>
          <button className={section === "general" ? "active" : ""} onClick={() => setSection("general")}><Languages size={16} /> {t("settings.general")}</button>
          <button className={section === "personalization" ? "active" : ""} onClick={() => setSection("personalization")}><Sparkles size={16} /> {t("settings.personalization")}</button>
          <button className={section === "models" ? "active" : ""} onClick={() => setSection("models")}><Bot size={16} /> {t("settings.models")}</button>
          <button className={section === "agent" ? "active" : ""} onClick={() => setSection("agent")}><TerminalSquare size={16} /> {t("settings.agent")}</button>
          <button className={section === "appearance" ? "active" : ""} onClick={() => setSection("appearance")}><Sun size={16} /> {t("settings.appearance")}</button>
          <button className={section === "about" ? "active" : ""} onClick={() => setSection("about")}><Info size={16} /> {t("settings.about")}</button>
        </aside>
        <section className="settings-content">
          {section === "general" && <>
            <h2>{t("settings.general")}</h2><p>{t("settings.generalDescription")}</p>
            <div className="profile-editor">
              <label className="profile-avatar-picker">
                <ProfileAvatar profile={{ nickname: profileNickname || props.profile.nickname, ...(profileAvatar ? { avatarDataUrl: profileAvatar } : {}) }} className="profile-avatar-preview" />
                <span><ImagePlus size={14} /> {t("settings.changeAvatar")}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void changeAvatar(event)} />
              </label>
              <div className="profile-fields">
                <label>
                  <span>{t("settings.nickname")}</span>
                  <input value={profileNickname} maxLength={60} onChange={(event) => setProfileNickname(event.target.value)} />
                </label>
                <small>{t("settings.nicknameDescription")}</small>
                <div className="profile-actions">
                  {profileAvatar && <button className="danger-link" onClick={() => setProfileAvatar(undefined)}><Trash2 size={14} /> {t("settings.removeAvatar")}</button>}
                  <button className="primary-button" disabled={profileBusy || !profileNickname.trim()} onClick={() => void saveProfile()}>
                    {profileBusy && <LoaderCircle className="spin" size={14} />}
                    {t("settings.saveProfile")}
                  </button>
                </div>
              </div>
            </div>
            <label className="setting-row">
              <span><strong>{t("settings.language")}</strong><small>{t("settings.languageDescription")}</small></span>
              <select value={language} onChange={(event) => void changeLanguage(event.target.value as LanguagePreference)}>
                <option value="system">{t("settings.languageSystem")}</option>
                <option value="zh-CN">{t("settings.languageZhCN")}</option>
                <option value="en">{t("settings.languageEnglish")}</option>
              </select>
            </label>
            <label className="setting-row">
              <span><strong>{t("settings.showReasoningProcess")}</strong><small>{t("settings.showReasoningProcessDescription")}</small></span>
              <input
                className="setting-switch"
                type="checkbox"
                role="switch"
                checked={props.showReasoningProcess}
                disabled={reasoningPreferenceBusy}
                onChange={(event) => void changeShowReasoningProcess(event.target.checked)}
              />
            </label>
          </>}
          {section === "personalization" && <>
            <h2>{t("settings.personalization")}</h2><p>{t("settings.personalizationDescription")}</p>
            <label className="setting-row personalization-tone-row">
              <span>
                <strong>{t("settings.basicStyleAndTone")}</strong>
                <small>{t("settings.basicStyleAndToneDescription")}</small>
              </span>
              <span className="personalization-tone-control">
                <select value={personalizationTone} onChange={(event) => setPersonalizationTone(event.target.value as TonePreset)}>
                  {PERSONALIZATION_TONES.map((tone) => <option key={tone.id} value={tone.id}>{t(tone.label)}</option>)}
                </select>
                <small>{t(selectedTone.description)}</small>
              </span>
            </label>
            <div className="personalization-editor">
              <div className="personalization-editor-heading">
                <strong>{t("settings.customInstructions")}</strong>
                <small>{t("settings.customInstructionsDescription")}</small>
              </div>
              <textarea
                value={customInstructions}
                placeholder={t("settings.customInstructionsPlaceholder")}
                aria-label={t("settings.customInstructions")}
                onChange={(event) => changeCustomInstructions(event.target.value)}
              />
              <div className="personalization-editor-meta">
                <small>{t("settings.customInstructionsScope")}</small>
                <span>{customInstructionLength} / {MAX_CUSTOM_INSTRUCTION_LENGTH}</span>
              </div>
              <div className="personalization-actions">
                <button
                  className="primary-button"
                  disabled={personalizationBusy || !personalizationChanged}
                  onClick={() => void savePersonalization()}
                >
                  {personalizationBusy && <LoaderCircle className="spin" size={14} />}
                  {t("common.confirm")}
                </button>
              </div>
            </div>
          </>}
          {section === "models" && <>
            <h2>{t("settings.modelsTitle")}</h2><p>{t("settings.credentialsDescription")}</p>
            <div className="provider-list">
              {props.providers.map((item) => (
                <button key={item.id} className={selected === item.id ? "selected" : ""} onClick={() => setSelected(item.id)}>
                  <span className="provider-monogram">{item.name.slice(0, 1)}</span>
                  <span><strong>{item.name}</strong><small>{item.defaultModel}</small></span>
                  <i className={item.configured ? "connected" : ""}>{item.configured ? t("settings.connected") : t("settings.notConnected")}</i>
                </button>
              ))}
            </div>
            <div className="credential-panel">
              <div><strong>{selectedProvider?.name}</strong><span>{selectedProvider?.configured ? t(selectedProvider.source === "environment" ? "settings.usingEnvironment" : "settings.usingStored") : t("settings.connectProvider")}</span></div>
              {selected !== "openai-codex" && <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={t("settings.apiKey")} autoComplete="off" />}
              {selected === "deepseek" && <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("settings.apiBaseUrl")} />}
              <div className="credential-actions">
                {selectedProvider?.configured && <button className="danger-link" onClick={() => void disconnect()}><Trash2 size={14} /> {t("settings.disconnect")}</button>}
                <button className="primary-button" disabled={busy || (selected !== "openai-codex" && !key.trim())} onClick={() => void connect()}>{busy && <LoaderCircle className="spin" size={14} />}{selected === "openai-codex" ? t("settings.signInChatGPT") : t("settings.saveCredential")}</button>
              </div>
            </div>
          </>}
          {section === "agent" && <>
            <h2>{t("settings.agentTitle")}</h2><p>{t("settings.agentDescription")}</p>
            <label className="setting-row"><span><strong>{t("settings.permissionMode")}</strong><small>{t("settings.permissionDescription")}</small></span><select value={props.permission} onChange={(event) => props.onPermission(event.target.value as PermissionMode)}><option value="plan">{t("permission.plan")}</option><option value="ask">{t("permission.ask")}</option><option value="auto">{t("permission.auto")}</option><option value="full">{t("permission.full")}</option></select></label>
            <label className="setting-row"><span><strong>{t("settings.sandbox")}</strong><small>{t("settings.sandboxDescription")}</small></span><select value={props.sandbox} onChange={(event) => props.onSandbox(event.target.value as SandboxMode)}><option value="read-only">{t("settings.readOnly")}</option><option value="workspace-write">{t("settings.workspaceWrite")}</option><option value="danger-full-access">{t("settings.fullFilesystem")}</option></select></label>
          </>}
          {section === "appearance" && <>
            <h2>{t("settings.appearance")}</h2>
            <p>{t("settings.appearanceDescription")}</p>
            <div className="theme-section">
              <div className="theme-section-heading">
                <span><strong>{t("settings.builtInThemes")}</strong><small>{t("settings.builtInThemesDescription")}</small></span>
              </div>
              <div className="theme-grid theme-grid-builtin">
                <button type="button" aria-pressed={props.themeId === null} className={`theme-card ${props.themeId === null ? "selected" : ""}`} onClick={() => props.onTheme(null)}>
                  <ThemePreview selected={props.themeId === null} />
                  <span className="theme-card-copy">
                    <span className="theme-card-title"><strong>DSCode</strong><i>{t("settings.builtIn")}</i></span>
                    <small>{t("settings.followsSystem")}</small>
                  </span>
                </button>
              </div>
            </div>
            <div className="theme-section theme-section-custom">
              <div className="theme-section-heading">
                <span><strong>{t("settings.customThemes")}</strong><small>~/.codexthemes/themes</small></span>
                <span className="theme-section-actions">
                  <button type="button" className="theme-action" onClick={props.onRefreshThemes} title={t("settings.refreshThemes")} aria-label={t("settings.refreshThemes")}><RefreshCwIcon /></button>
                  <button type="button" className="theme-action theme-browse-action" onClick={() => void window.dscode.app.openExternal("https://codexthemes.ai")}><ExternalLink size={13} />{t("settings.browseThemes")}</button>
                </span>
              </div>
              {props.themes.length > 0 ? (
                <div className="theme-grid theme-grid-custom">
                  {props.themes.map((theme) => (
                    <button type="button" key={theme.id} aria-pressed={props.themeId === theme.id} className={`theme-card ${props.themeId === theme.id ? "selected" : ""}`} onClick={() => props.onTheme(theme.id)}>
                      <ThemePreview theme={theme} selected={props.themeId === theme.id} />
                      <span className="theme-card-copy">
                        <span className="theme-card-title"><strong>{theme.displayName}</strong><i>{theme.mode === "dark" ? t("settings.dark") : t("settings.light")}</i></span>
                        {theme.description && <small className="theme-card-description">{theme.description}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="theme-empty">
                  <span><strong>{t("settings.noCustomThemes")}</strong><small>{t("settings.noCustomThemesDescription")}</small></span>
                  <button type="button" className="secondary-button" onClick={() => void window.dscode.app.openExternal("https://codexthemes.ai")}>{t("settings.browseThemes")}</button>
                </div>
              )}
            </div>
          </>}
          {section === "about" && (
            <div className="about-panel">
              <span className="brand-mark about"><span /></span>
              <h2>DSCode Desktop</h2>
              <p>{t("settings.aboutTagline")}</p>
              <div className="about-links">
                <button type="button" title={DSCODE_WEBSITE_URL} onClick={() => void window.dscode.app.openExternal(DSCODE_WEBSITE_URL)}>
                  <span className="about-link-icon"><Globe2 size={17} /></span>
                  <span><strong>{t("settings.website")}</strong><small>dscode.ai</small></span>
                  <ExternalLink size={14} />
                </button>
                <button type="button" title={DSCODE_GITHUB_URL} onClick={() => void window.dscode.app.openExternal(DSCODE_GITHUB_URL)}>
                  <span className="about-link-icon"><GitFork size={17} /></span>
                  <span><strong>{t("settings.githubRepository")}</strong><small>github.com/thinkany-ai/dscode</small></span>
                  <ExternalLink size={14} />
                </button>
                <button type="button" title={DSCODE_ISSUES_URL} onClick={() => void window.dscode.app.openExternal(DSCODE_ISSUES_URL)}>
                  <span className="about-link-icon"><MessageSquareWarning size={17} /></span>
                  <span><strong>{t("settings.reportIssue")}</strong><small>github.com/thinkany-ai/dscode/issues</small></span>
                  <ExternalLink size={14} />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const DEFAULT_THEME_PREVIEW = {
  canvas: "#f7f7f5",
  surface: "#eeedea",
  raised: "#ffffff",
  text: "#20201e",
  muted: "#74736e",
  accent: "#282825",
  border: "#ddddd8",
  focus: "#6774d9",
};

function ThemePreview({ theme, selected }: { theme?: ThemeSummary; selected: boolean }) {
  const palette = theme?.palette ?? DEFAULT_THEME_PREVIEW;
  const style = {
    "--theme-preview-canvas": palette.canvas,
    "--theme-preview-sidebar": palette.surface,
    "--theme-preview-surface": palette.raised,
    "--theme-preview-text": palette.text,
    "--theme-preview-muted": palette.muted,
    "--theme-preview-accent": palette.accent,
    "--theme-preview-border": palette.border,
    "--theme-preview-focus": palette.focus,
  } as CSSProperties;

  return (
    <span className="theme-preview" style={style} aria-hidden="true">
      <span className="theme-preview-shell">
        <span className="theme-preview-sidebar">
          <span className="theme-preview-brand"><i /><i /></span>
          <i /><i /><i /><i />
        </span>
        <span className="theme-preview-stage">
          <span className="theme-preview-topbar"><i /><i /></span>
          <span className="theme-preview-chat">
            <span className="theme-preview-user-message" />
            <span className="theme-preview-answer"><i /><i /><i /></span>
          </span>
          <span className="theme-preview-composer"><i /><b /></span>
        </span>
      </span>
      {theme?.previewDataUrl && <img src={theme.previewDataUrl} alt="" />}
      {selected && <span className="theme-selected-check"><Check size={12} strokeWidth={2.4} /></span>}
    </span>
  );
}

function CommandPalette({ onClose, onNew, onOpen, onSettings, onInspector }: { onClose(): void; onNew(): void; onOpen(): void; onSettings(): void; onInspector(): void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const commands = [
    { label: t("command.newThread"), icon: Plus, keys: "⌘N", run: onNew },
    { label: t("command.openWorkspace"), icon: FolderOpen, keys: "⌘O", run: onOpen },
    { label: t("command.showActivity"), icon: Eye, keys: "", run: onInspector },
    { label: t("command.openSettings"), icon: Settings, keys: "⌘,", run: onSettings },
  ].filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));
  return <div className="modal-backdrop command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="command-palette"><label><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("command.search")} /></label><div>{commands.map((command) => <button key={command.label} onClick={() => { command.run(); onClose(); }}><command.icon size={16} /><span>{command.label}</span><kbd>{command.keys}</kbd></button>)}</div></div></div>;
}

function SidebarSessionTitle({ children }: { children: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => setScrollDistance(Math.max(0, text.scrollWidth - viewport.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={viewportRef} className="session-title-viewport">
      <span
        ref={textRef}
        className={`session-title-scroll${scrollDistance > 0 ? " is-overflowing" : ""}`}
        style={{ "--session-title-distance": `${scrollDistance}px` } as CSSProperties}
      >
        {children}
      </span>
    </span>
  );
}

function SessionSearchDialog({
  sessions,
  workspaces,
  activeSession,
  query,
  onQuery,
  onClose,
  onOpen,
  onNew,
}: {
  sessions: SessionSummary[];
  workspaces: WorkspaceItem[];
  activeSession?: string;
  query: string;
  onQuery(value: string): void;
  onClose(): void;
  onOpen(session: SessionSummary): void;
  onNew(): void;
}) {
  const { locale, t } = useI18n();
  const projectNames = new Map(workspaces.map((item) => [item.path, item.name]));
  const normalizedQuery = query.trim().toLowerCase();
  const results = sessions.filter((session) => {
    if (!normalizedQuery) return true;
    const projectName = projectNames.get(session.cwd) ?? "";
    return `${session.title} ${session.preview ?? ""} ${projectName} ${session.cwd}`.toLowerCase().includes(normalizedQuery);
  }).slice(0, 14);

  return (
    <div
      className="modal-backdrop session-search-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <section className="session-search-dialog" role="dialog" aria-modal="true" aria-label={t("sidebar.searchThreads")}>
        <label className="session-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t("sidebar.searchThreads")}
          />
        </label>
        <div className="session-search-results">
          <div className="session-search-section-label">{t("sidebar.threads")}</div>
          {results.length === 0 ? (
            <div className="session-search-empty">{t("search.noResults")}</div>
          ) : results.map((session) => {
            const projectName = projectNames.get(session.cwd)
              ?? session.cwd.split(/[\\/]/).filter(Boolean).at(-1)
              ?? t("status.regularTask");
            return (
              <button
                key={session.path}
                className={`session-search-result ${session.path === activeSession ? "active" : ""}`}
                onClick={() => {
                  onOpen(session);
                  onClose();
                }}
              >
                <span className="session-search-dot" aria-hidden="true" />
                <strong>{session.title}</strong>
                <small>{projectName}</small>
                <time>{relativeTime(session.updatedAt, locale, t("status.now"))}</time>
              </button>
            );
          })}
        </div>
        <div className="session-search-footer">
          <button onClick={() => { onNew(); onClose(); }}><Plus size={16} /><span>{t("sidebar.newThread")}</span><kbd>⌘N</kbd></button>
        </div>
      </section>
    </div>
  );
}

function InlineExtensionRequest({ request, onDone, onError }: { request: ExtensionUiRequest; onDone(): void; onError(message: string): void }) {
  const { locale, t } = useI18n();
  const [value, setValue] = useState(request.prefill ?? "");
  const [pendingResponse, setPendingResponse] = useState<string>();
  const plan = request.method === "confirm" ? parseStructuredPlan(request.message) : undefined;
  const localizedRequest = localizeExtensionUiRequest(request, locale);
  const respond = async (response: Record<string, unknown>, action: string) => {
    if (pendingResponse) return;
    setPendingResponse(action);
    try {
      await window.dscode.agent.respondToUi(request.id, response);
      onDone();
    } catch (error) {
      setPendingResponse(undefined);
      onError(cleanError(error instanceof Error ? error.message : String(error)));
    }
  };
  const busy = Boolean(pendingResponse);
  return (
    <section className="inline-request" aria-live="polite">
      <div className="inline-request-icon">{plan ? <ListTodo size={16} /> : <TerminalSquare size={16} />}</div>
      <div className="inline-request-body">
        <h3>{plan ? t("dialog.updatePlan") : localizedRequest.title ?? (request.method === "confirm" ? t("dialog.approval") : t("dialog.chooseOption"))}</h3>
        {plan ? <PlanTodoList plan={plan} /> : localizedRequest.message && <p>{localizedRequest.message}</p>}
        {request.method === "select" && (
          <div className="approval-options">
            {localizedRequest.options.map((option) => (
              <button key={option.value} disabled={busy} onClick={() => void respond({ value: option.value }, `select:${option.value}`)}>
                <span>{option.label}</span>{pendingResponse === `select:${option.value}` ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}
              </button>
            ))}
          </div>
        )}
        {(request.method === "input" || request.method === "editor") && (
          request.method === "editor"
            ? <textarea autoFocus disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} />
            : <input autoFocus disabled={busy} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
        )}
        <div className="inline-request-actions">
          <button disabled={busy} onClick={() => void respond({ cancelled: true }, "cancel")}>
            {pendingResponse === "cancel" && <LoaderCircle className="spin" size={14} />}{t("common.cancel")}
          </button>
          {request.method === "confirm" && (
            <>
              <button disabled={busy} onClick={() => void respond({ confirmed: false }, "deny")}>
                {pendingResponse === "deny" && <LoaderCircle className="spin" size={14} />}{t("common.deny")}
              </button>
              <button className="primary-button" disabled={busy} onClick={() => void respond({ confirmed: true }, "allow")}>
                {pendingResponse === "allow" && <LoaderCircle className="spin" size={14} />}{t("common.allow")}
              </button>
            </>
          )}
          {(request.method === "input" || request.method === "editor") && (
            <button className="primary-button" disabled={busy} onClick={() => void respond({ value }, "continue")}>
              {pendingResponse === "continue" && <LoaderCircle className="spin" size={14} />}{t("common.continue")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PlanTodoList({ plan }: { plan: StructuredPlan }) {
  const { t } = useI18n();
  const completed = plan.steps.filter((item) => item.status === "completed").length;
  const statusLabels = {
    completed: t("plan.completed"),
    in_progress: t("plan.inProgress"),
    pending: t("plan.pending"),
  };

  return (
    <div className="plan-todo">
      {plan.explanation && <p className="plan-explanation">{plan.explanation}</p>}
      <div className="plan-progress">
        <span>{t("plan.tasks")}</span>
        <span>{t("plan.progress", { completed, total: plan.steps.length })}</span>
      </div>
      <ol className="plan-todo-list">
        {plan.steps.map((item, index) => (
          <li className={`plan-todo-item ${item.status}`} key={`${index}-${item.step}`}>
            <span className="plan-todo-status" title={statusLabels[item.status]} aria-label={statusLabels[item.status]}>
              {item.status === "completed" && <Check size={12} />}
              {item.status === "in_progress" && <LoaderCircle className="spin" size={12} />}
            </span>
            <span>{item.step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AuthPromptDialog({ event, onDone, onCancel }: { event: Extract<AuthUiEvent, { kind: "prompt" }>; onDone(): void; onCancel(): void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const respond = (answer: string, close = onDone) => {
    close();
    void window.dscode.auth.respond(event.id, answer).catch(() => undefined);
  };
  const cancel = () => respond(AUTH_PROMPT_CANCEL_VALUE, onCancel);
  const isCodexMethodPrompt = event.prompt.type === "select"
    && event.prompt.options?.some((option) => option.id === "browser")
    && event.prompt.options.some((option) => option.id === "device_code");
  const message = isCodexMethodPrompt
    ? t("auth.codexLoginMethod")
    : event.prompt.type === "manual_code"
      ? t("auth.manualCodePrompt")
      : event.prompt.message;
  const optionText = (option: NonNullable<typeof event.prompt.options>[number]) => {
    if (!isCodexMethodPrompt) return option;
    if (option.id === "browser") return { ...option, label: t("auth.browserLogin"), description: t("auth.browserLoginDescription") };
    if (option.id === "device_code") return { ...option, label: t("auth.deviceCodeLogin"), description: t("auth.deviceCodeLoginDescription") };
    return option;
  };
  const closeOnBackdrop = (pointerEvent: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerEvent.target === pointerEvent.currentTarget) cancel();
  };
  return (
    <div className="modal-backdrop" onPointerDown={closeOnBackdrop}>
      <div className="approval-dialog auth-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby={`auth-prompt-${event.id}`} onKeyDown={(key) => { if (key.key === "Escape") cancel(); }}>
        <button className="icon-button auth-dialog-close" onClick={cancel} aria-label={t("auth.cancelSignIn")} title={t("auth.cancelSignIn")}><X size={17} /></button>
        <div className="approval-icon"><Bot size={19} /></div>
        <h3 id={`auth-prompt-${event.id}`}>{message}</h3>
        {event.prompt.type === "select"
          ? <div className="approval-options">{event.prompt.options?.map(optionText).map((option, index) => <button key={option.id} autoFocus={index === 0} onClick={() => respond(option.id)}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><ChevronRight size={14} /></button>)}</div>
          : <input type={event.prompt.type === "secret" ? "password" : "text"} autoFocus value={value} placeholder={event.prompt.placeholder} onChange={(input) => setValue(input.target.value)} onKeyDown={(key) => { if (key.key === "Enter") respond(value); }} />}
        <div className="dialog-actions">
          <button onClick={cancel}>{t("common.cancel")}</button>
          {event.prompt.type !== "select" && <button className="primary-button" onClick={() => respond(value)}>{t("common.continue")}</button>}
        </div>
      </div>
    </div>
  );
}

function AuthNotice({ event, onClose }: { event: Extract<AuthUiEvent, { kind: "notice" }>; onClose(): void }) {
  const { t } = useI18n();
  const notice = event.event;
  const instructions = notice.type === "device_code" ? t("auth.deviceCodeInstructions") : t("auth.browserOpened");
  return <div className="modal-backdrop"><div className="approval-dialog" role="dialog" aria-modal="true"><div className="approval-icon"><Bot size={19} /></div><h3>{notice.type === "device_code" ? t("auth.completeSignIn") : t("auth.continueInBrowser")}</h3><p>{instructions}</p>{notice.userCode && <div className="device-code">{notice.userCode}</div>}<div className="dialog-actions"><button className="primary-button" onClick={onClose}>{t("auth.done")}</button></div></div></div>;
}

function AttachmentMenu({ onChange }: { onChange(event: ChangeEvent<HTMLInputElement>): void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="composer-popover" ref={rootRef}>
      <button
        type="button"
        className={`composer-tool-button${open ? " open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-label={t("composer.moreActions")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={17} />
      </button>
      {open && (
        <div className="composer-popup-menu attachment-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
          >
            <Paperclip size={16} />
            <span>{t("composer.uploadFile")}</span>
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        className="composer-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={onChange}
      />
    </div>
  );
}

function PermissionPicker({ value, updating, onChange }: { value: PermissionMode; updating: boolean; onChange(value: PermissionMode): void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const options = [
    { value: "plan" as const, label: t("permission.plan"), description: t("permission.planDescription"), icon: <MessageSquareText size={16} /> },
    { value: "ask" as const, label: t("permission.ask"), description: t("permission.askDescription"), icon: <CircleAlert size={16} /> },
    { value: "auto" as const, label: t("permission.auto"), description: t("permission.autoDescription"), icon: <Shield size={16} /> },
    { value: "full" as const, label: t("permission.full"), description: t("permission.fullDescription"), icon: <Globe2 size={16} /> },
  ];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="composer-popover permission-picker" ref={rootRef}>
      <button
        type="button"
        className={`permission-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        disabled={updating}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={updating}
      >
        {updating ? <LoaderCircle className="spin" size={13} /> : <Shield size={13} />}
        <span>{permissionLabel(value, t)}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="composer-popup-menu permission-menu" role="menu">
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={`permission-option ${option.value}${option.value === value ? " selected" : ""}`}
              key={option.value}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
            >
              <span className="permission-option-icon">{option.icon}</span>
              <span className="permission-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  provider,
  model,
  models,
  onChange,
}: {
  provider: string;
  model: string;
  models: AgentSnapshot["models"];
  onChange(value: string): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState(provider);
  const groupedModels = useMemo(() => {
    const options = [...models];
    if (!options.some((item) => item.provider === provider && item.id === model)) {
      options.unshift({ provider, id: model });
    }
    const grouped = new Map<string, AgentSnapshot["models"]>();
    for (const item of options) {
      const group = grouped.get(item.provider) ?? [];
      group.push(item);
      grouped.set(item.provider, group);
    }
    return grouped;
  }, [model, models, provider]);

  useEffect(() => {
    if (open) setActiveProvider(provider);
  }, [open, provider]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const modelGroups = [...groupedModels.entries()];

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${provider} · ${model}`}
      >
        <span>{shortModel(model)}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="model-menu" role="menu" aria-label="Models">
          {modelGroups.map(([providerId, providerModels], providerIndex) => (
            <div
              className="model-provider-item"
              key={providerId}
              onMouseEnter={() => setActiveProvider(providerId)}
              onFocus={() => setActiveProvider(providerId)}
            >
              <button
                type="button"
                className={`model-provider-button${activeProvider === providerId ? " active" : ""}`}
                onClick={() => setActiveProvider(providerId)}
                role="menuitem"
                aria-haspopup="menu"
              >
                <span>{providerId}</span>
                {providerId === provider ? <Check size={14} /> : <i />}
                <ChevronRight size={14} />
              </button>
              {activeProvider === providerId && (
                <div
                  className={`model-submenu${providerIndex >= Math.floor(modelGroups.length / 2) ? " align-up" : ""}`}
                  role="menu"
                  aria-label={`${providerId} models`}
                >
                  {providerModels.map((item) => {
                    const selected = item.provider === provider && item.id === model;
                    return (
                      <button
                        type="button"
                        className={selected ? "selected" : ""}
                        key={`${item.provider}/${item.id}`}
                        onClick={() => {
                          onChange(`${item.provider}/${item.id}`);
                          setOpen(false);
                        }}
                        role="menuitemradio"
                        aria-checked={selected}
                        title={item.id}
                      >
                        <span>{item.id}</span>
                        {selected && <Check size={14} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function profileInitials(nickname: string): string {
  const value = nickname.trim();
  if (!value) return "U";
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return Array.from(value).slice(0, 2).join("").toUpperCase();
}

async function fileToAvatarDataUrl(file: File): Promise<string> {
  const source = await readFileDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = () => reject(new Error("Unable to read avatar image"));
    next.src = source;
  });
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  if (!sourceSize) throw new Error("Avatar image is empty");
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to process avatar image");
  const sourceX = (image.naturalWidth - sourceSize) / 2;
  const sourceY = (image.naturalHeight - sourceSize) / 2;
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 256, 256);
  return canvas.toDataURL("image/webp", 0.86);
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await readFileDataUrl(file);
  return { name: file.name, mimeType: file.type, data: dataUrl.split(",")[1] ?? "" };
}

function imageDataUrl(image: ChatImage): string {
  return image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type Translator = ReturnType<typeof useI18n>["t"];

function permissionLabel(value: PermissionMode, t: Translator): string {
  return { plan: t("permission.plan"), ask: t("permission.ask"), auto: t("permission.auto"), full: t("permission.full") }[value];
}

function shortModel(value: string): string {
  return value.length > 22 ? `${value.slice(0, 20)}…` : value;
}

function workDuration(messages: ChatMessage[], liveNow?: number): number | undefined {
  const tools = messages.flatMap((message) => message.tools);
  const starts = tools
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  for (const message of messages) {
    const messageStart = normalizeTimestamp(message.timestamp);
    if (messageStart !== undefined) starts.push(messageStart);
  }
  if (starts.length === 0) return undefined;

  const ends = tools
    .map((tool) => tool.endedAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const end = liveNow ?? (ends.length > 0 ? Math.max(...ends) : undefined);
  if (end === undefined) return undefined;
  return Math.max(0, end - Math.min(...starts));
}

function normalizeTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatCompactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1_000) return Math.round(value).toLocaleString();
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  return `${Math.round(value / 1_000_000)}m`;
}

function formatCost(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function relativeTime(value: string, locale: string, nowLabel: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return nowLabel;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(value).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function formatJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatToolArgs(tool: ToolActivity): string {
  if (typeof tool.args === "string") return tool.args;
  if (!tool.args || typeof tool.args !== "object" || Array.isArray(tool.args)) return formatJson(tool.args);

  const args = tool.args as Record<string, unknown>;
  const commandKey = typeof args.cmd === "string" ? "cmd" : typeof args.command === "string" ? "command" : undefined;
  if (commandKey) {
    const command = String(args[commandKey]);
    const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== commandKey));
    return Object.keys(rest).length > 0 ? `${command}\n\n${formatJson(rest)}` : command;
  }

  const entries = Object.entries(args);
  if (entries.length === 1 && typeof entries[0]?.[1] === "string") return entries[0][1];
  return formatJson(tool.args);
}

function toolDisplayTitle(tool: ToolActivity, t: Translator): string {
  const name = tool.name.toLowerCase();
  const args = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args)
    ? tool.args as Record<string, unknown>
    : {};
  const fileValue = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  const file = fileValue ? crop(fileValue, 76) : undefined;

  if (name.includes("exec") || name.includes("bash") || name.includes("command")) return t("work.toolRanCommand");
  if (name.includes("read")) return file ? t("work.toolRead", { file }) : t("work.toolReadFiles");
  if (name.includes("write")) return file ? t("work.toolWrote", { file }) : t("work.toolWroteFile");
  if (name.includes("edit") || name.includes("patch")) return file ? t("work.toolEdited", { file }) : t("work.toolEditedFiles");
  if (name.includes("search")) return t("work.toolSearched");
  if (name === "update_plan") return t("work.toolUpdatedPlan");
  return tool.name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function toolFilePath(tool: ToolActivity): string | undefined {
  const name = tool.name.toLowerCase();
  if (!["read", "write", "edit", "patch", "file", "image"].some((part) => name.includes(part))) return undefined;
  if (!tool.args || typeof tool.args !== "object" || Array.isArray(tool.args)) return undefined;
  const args = tool.args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "target", "targetPath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function previewPathFromHref(href?: string): string | undefined {
  if (!href || /^(?:https?:|mailto:|#)/i.test(href)) return undefined;
  if (href.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(href).pathname);
    } catch {
      return undefined;
    }
  }
  if (/^(?:\/|\.\.?\/|~\/)/.test(href)) return decodeURIComponent(href);
  return undefined;
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function crop(value: string, length: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function cleanError(value: string): string {
  return value.replace(/^Error invoking remote method '[^']+':\s*/i, "").split("\n").filter(Boolean).slice(0, 3).join(" ");
}
