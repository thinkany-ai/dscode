import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowUp, Bot, Check, CircleAlert, CircleStop, File, FolderOpen, LoaderCircle,
  MessageCircle, Paperclip, Pause, Play, QrCode, RotateCcw, Trash2, Wifi, WifiOff, X,
} from "lucide-react";
import type { WeixinBotStatus, WeixinLoginSession, WeixinMessage } from "../shared/types";

export function WeixinBotView({ sidebarOpen, onShowSidebar }: { sidebarOpen: boolean; onShowSidebar(): void }) {
  const [status, setStatus] = useState<WeixinBotStatus>();
  const [messages, setMessages] = useState<WeixinMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [before, setBefore] = useState<number>();
  const [login, setLogin] = useState<WeixinLoginSession>();
  const [loginState, setLoginState] = useState<string>();
  const [verifyCode, setVerifyCode] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [clearValue, setClearValue] = useState("");
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const timelineRef = useRef<VirtuosoHandle>(null);
  const followLatestRef = useRef(true);

  const refresh = useCallback(async () => {
    const [nextStatus, history] = await Promise.all([window.dscode.weixin.getStatus(), window.dscode.weixin.getHistory({ limit: 100 })]);
    setStatus(nextStatus);
    setMessages(history.messages);
    setFirstItemIndex(1_000_000 - history.messages.length);
    followLatestRef.current = true;
    setHasMore(history.hasMore);
    setBefore(history.before);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(messageOf(cause)));
    return window.dscode.weixin.onEvent((event) => {
      if (event.type === "status") setStatus(event.status);
      if (event.type === "history-reset") { setMessages([]); setFirstItemIndex(1_000_000); setLogin(undefined); }
      if (event.type === "message") {
        setMessages((current) => {
          const index = current.findIndex((item) => item.id === event.message.id);
          if (index < 0) { followLatestRef.current = true; return [...current, event.message]; }
          const next = [...current]; next[index] = event.message; return next;
        });
      }
    });
  }, [refresh]);

  useEffect(() => {
    if (!followLatestRef.current || messages.length === 0) return;
    followLatestRef.current = false;
    requestAnimationFrame(() => timelineRef.current?.scrollToIndex({ index: messages.length - 1, align: "end", behavior: status?.running ? "smooth" : "auto" }));
  }, [messages, status?.running]);

  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const result = await window.dscode.weixin.waitLogin(login.sessionId);
          if (cancelled) return;
          setLoginState(result.message);
          if (result.state === "connected") { setLogin(undefined); await refresh(); return; }
          if (result.state === "expired" || result.state === "error") return;
          if (result.state === "verify-required") return;
        } catch (cause) { if (!cancelled) setError(messageOf(cause)); return; }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [login, refresh]);

  const chooseWorkspace = async () => {
    setError(undefined);
    const selected = await window.dscode.weixin.chooseWorkspace();
    if (!selected) return;
    if (!window.confirm(`信任以下目录并允许微信 Bot 在目录内自动读写、执行命令和联网？\n\n${selected}\n\n目录一旦绑定，只能通过“清除微信 Bot 数据”更换。`)) return;
    await window.dscode.weixin.configureWorkspace(selected);
    await refresh();
  };

  const beginLogin = async () => {
    setBusy(true); setError(undefined); setLoginState("正在生成二维码…");
    try { const session = await window.dscode.weixin.startLogin(); setLogin(session); setLoginState("请使用微信扫码"); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  const submitVerify = async () => {
    if (!login || !verifyCode.trim()) return;
    await window.dscode.weixin.submitVerifyCode(login.sessionId, verifyCode.trim());
    setVerifyCode(""); setLoginState("验证码已提交，正在确认…");
    const current = login; setLogin(undefined); queueMicrotask(() => setLogin(current));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft(""); setAttachments([]); setError(undefined);
    try { await window.dscode.weixin.send({ text, attachmentPaths: attachments }); }
    catch (cause) { setDraft(text); setAttachments(attachments); setError(messageOf(cause)); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  const loadOlder = async () => {
    const page = await window.dscode.weixin.getHistory({ before, limit: 100 });
    setFirstItemIndex((current) => current - page.messages.length);
    setMessages((current) => [...page.messages, ...current]); setHasMore(page.hasMore); setBefore(page.before);
  };

  if (!status) return <div className="weixin-view"><div className="loading-state"><LoaderCircle className="spin" />正在加载微信 Bot…</div></div>;

  const bound = Boolean(status.accountId);
  return (
    <section className="weixin-view">
      <header className="thread-header weixin-header">
        <div className="header-left">
          {!sidebarOpen && <button className="icon-button sidebar-reveal" onClick={onShowSidebar}><MessageCircle size={16} /></button>}
          <span className="weixin-avatar"><Bot size={18} /></span>
          <div className="thread-heading"><strong>微信 Bot</strong><span>{status.online ? <Wifi size={12} /> : <WifiOff size={12} />}{status.online ? "已连接" : stateLabel(status.state)} · {status.defaults.model}</span></div>
        </div>
        {bound && <div className="header-actions">
          <button className="icon-button" title={status.online ? "暂停" : "恢复"} onClick={() => void (status.online ? window.dscode.weixin.pause() : window.dscode.weixin.start()).catch((cause) => setError(messageOf(cause)))}>{status.online ? <Pause size={16} /> : <Play size={16} />}</button>
        </div>}
      </header>

      {!status.workspacePath ? (
        <div className="weixin-onboarding">
          <span className="weixin-hero-icon"><FolderOpen size={28} /></span>
          <h1>先选择微信 Bot 的安全目录</h1>
          <p>Bot 只能在这个目录内自动读写和执行命令。目录内允许联网，但不能访问目录外的文件。</p>
          <button className="primary-button" onClick={() => void chooseWorkspace()}><FolderOpen size={15} />选择安全目录</button>
        </div>
      ) : !bound ? (
        <div className="weixin-onboarding">
          <span className="weixin-hero-icon"><QrCode size={28} /></span>
          <h1>绑定微信 Bot</h1>
          <p className="weixin-bound-path" title={status.workspacePath}>{status.workspacePath}</p>
          {login ? <>
            <img className="weixin-qr" src={login.qrImageDataUrl} alt="微信 Bot 登录二维码" />
            <p>{loginState}</p>
            {loginState?.includes("验证码") && <div className="weixin-verify"><input value={verifyCode} onChange={(event) => setVerifyCode(event.target.value)} placeholder="微信中显示的数字" /><button className="primary-button" onClick={() => void submitVerify()}>提交</button></div>}
            <button className="secondary-button" onClick={() => { setLogin(undefined); void beginLogin(); }}><RotateCcw size={14} />重新生成</button>
          </> : <button className="primary-button" disabled={busy} onClick={() => void beginLogin()}>{busy ? <LoaderCircle className="spin" size={15} /> : <QrCode size={15} />}生成二维码</button>}
        </div>
      ) : (
        <>
          <div className="weixin-status-strip">
            <span title={status.workspacePath}><FolderOpen size={12} />{shortPath(status.workspacePath)}</span>
            <span>上下文 {status.contextUsage?.percent == null ? "—" : `${Math.round(status.contextUsage.percent)}%`}</span>
            <span>已压缩 {status.compactionCount} 次</span>
            <span>媒体 {formatBytes(status.mediaBytes)}</span>
            <label><input type="checkbox" checked={status.autoLaunch} onChange={(event) => void window.dscode.weixin.setAutoLaunch(event.target.checked)} />开机启动</label>
          </div>
          {messages.length === 0 ? <div className="weixin-message-scroll"><div className="weixin-messages"><div className="weixin-chat-empty"><MessageCircle size={26} /><strong>固定会话已就绪</strong><span>从微信或这里发送第一条消息。</span></div>{status.running && <div className="working-line"><LoaderCircle className="spin" size={14} />微信 Bot 正在处理…</div>}</div></div> :
            <Virtuoso
              ref={timelineRef}
              className="weixin-message-scroll"
              data={messages}
              firstItemIndex={firstItemIndex}
              followOutput="smooth"
              components={{
                Header: () => hasMore ? <button className="weixin-load-more" onClick={() => void loadOlder()}>加载更早消息</button> : null,
                Footer: () => <div className="weixin-virtual-footer">{status.running && <div className="working-line"><LoaderCircle className="spin" size={14} />微信 Bot 正在处理…</div>}</div>,
              }}
              itemContent={(index, message) => <div className={`weixin-virtual-item${index === firstItemIndex ? " is-first" : ""}`}><WeixinMessageRow message={message} /></div>}
            />}
          <div className="weixin-composer-wrap">
            <div className="composer weixin-composer">
              {attachments.length > 0 && <div className="weixin-attachment-list">{attachments.map((file) => <span key={file}><File size={12} />{file.split(/[\\/]/).at(-1)}<button onClick={() => setAttachments((items) => items.filter((item) => item !== file))}><X size={11} /></button></span>)}</div>}
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} placeholder="向固定微信 Bot 会话发送消息…" rows={1} />
              <div className="composer-toolbar"><div className="composer-tools"><button className="composer-tool-button" title="添加安全目录内的文件" onClick={() => void window.dscode.weixin.chooseAttachments().then((files) => setAttachments((current) => [...current, ...files].slice(0, 10))).catch((cause) => setError(messageOf(cause)))}><Paperclip size={15} /></button></div><div className="composer-actions">
                {status.running && <button className="composer-tool-button" title="停止" onClick={() => void window.dscode.weixin.abortTurn()}><CircleStop size={16} /></button>}
                <button className="send-button" disabled={!draft.trim() && attachments.length === 0} onClick={() => void send()}><ArrowUp size={17} /></button>
              </div></div>
            </div>
            <details className="weixin-advanced"><summary>连接与高级设置</summary><div>
              <button onClick={() => void window.dscode.weixin.disconnect().catch((cause) => setError(messageOf(cause)))}><WifiOff size={14} />断开并移除本机凭据</button>
              <label>清除后才能更换账号或目录<input value={clearValue} onChange={(event) => setClearValue(event.target.value)} placeholder="输入：清除微信 Bot 数据" /></label>
              <button className="danger-button" disabled={clearValue !== "清除微信 Bot 数据"} onClick={() => void window.dscode.weixin.clearAllData(clearValue).then(() => { setClearValue(""); void refresh(); }).catch((cause) => setError(messageOf(cause)))}><Trash2 size={14} />清除全部 Bot 数据</button>
            </div></details>
          </div>
        </>
      )}
      {error && <div className="weixin-error"><CircleAlert size={15} /><span>{error}</span><button onClick={() => setError(undefined)}><X size={13} /></button></div>}
    </section>
  );
}

function WeixinMessageRow({ message }: { message: WeixinMessage }) {
  const outgoingUser = message.source === "desktop";
  const assistant = message.role === "assistant";
  return <article className={`weixin-message ${outgoingUser || message.source === "weixin" ? "weixin-user-message" : assistant ? "weixin-agent-message" : "weixin-system-message"}`}>
    <small>{sourceLabel(message)} · {new Date(message.createdAt).toLocaleString()} {message.status === "failed" ? "· 失败" : message.status === "processing" ? "· 处理中" : ""}</small>
    {message.text && (assistant ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div> : <p>{message.text}</p>)}
    {message.media.length > 0 && <div className="weixin-media-list">{message.media.map((media, index) => <span key={`${media.name}-${index}`}><File size={13} /><strong>{media.name}</strong><em>{formatBytes(media.size)}</em></span>)}</div>}
  </article>;
}

function sourceLabel(message: WeixinMessage): string {
  if (message.source === "weixin") return "微信";
  if (message.source === "desktop") return "桌面";
  if (message.source === "agent") return "DSCode";
  return "系统";
}
function stateLabel(value: WeixinBotStatus["state"]): string { return ({ unconfigured: "未配置", "workspace-ready": "待绑定", "login-required": "需重新绑定", connecting: "连接中", online: "已连接", paused: "已暂停", error: "连接异常" })[value]; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortPath(value: string): string { const parts = value.split(/[\\/]/).filter(Boolean); return parts.slice(-2).join("/"); }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB`; }
