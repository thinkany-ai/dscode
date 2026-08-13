import type { AgentEvent } from "../../shared/types";

export interface ToolActivity {
  id: string;
  name: string;
  title: string;
  status: "running" | "complete" | "error";
  startedAt?: number;
  endedAt?: number;
  args?: unknown;
  output?: string;
  expanded?: boolean;
}

export interface ChatImage {
  data: string;
  mimeType: string;
}

export type WorkItem =
  | { type: "thinking"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; toolId: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  timestamp?: number;
  streaming?: boolean;
  queued?: boolean;
  images: ChatImage[];
  tools: ToolActivity[];
  work: WorkItem[];
}

export type ConversationGroup =
  | { type: "user"; id: string; message: ChatMessage }
  | { type: "assistant"; id: string; messages: ChatMessage[] };

export interface TurnWorkEntry {
  key: string;
  message: ChatMessage;
  item: WorkItem;
}

export interface TurnResponseEntry {
  key: string;
  text: string;
  streaming: boolean;
}

export type AssistantActivity = "thinking" | "tool";

type JsonRecord = Record<string, unknown>;

export function normalizeMessages(messages: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const value of messages) {
    if (!isRecord(value)) continue;
    const role = value.role;
    if (role === "toolResult") {
      attachStoredToolResult(result, value);
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const parsed = messageFromRecord(value, `history-${result.length}`);
    if (parsed) result.push(parsed);
  }
  return result;
}

export function groupConversation(messages: ChatMessage[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.role === "assistant" && previous?.type === "assistant") {
      previous.messages.push(message);
      continue;
    }
    groups.push(message.role === "user"
      ? { type: "user", id: message.id, message }
      : { type: "assistant", id: message.id, messages: [message] });
  }
  return groups;
}

export function splitAssistantTurn(messages: ChatMessage[], active = false): { work: TurnWorkEntry[]; responses: TurnResponseEntry[] } {
  let lastToolMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.tools.length > 0) {
      lastToolMessageIndex = index;
      break;
    }
  }

  const work: TurnWorkEntry[] = [];
  const responses: TurnResponseEntry[] = [];
  messages.forEach((message, messageIndex) => {
    const textItems = message.work.filter((item): item is Extract<WorkItem, { type: "text" }> => item.type === "text");
    for (const item of message.work) {
      const key = `${message.id}:${item.id}`;
      if (!active && item.type === "text" && messageIndex > lastToolMessageIndex) {
        responses.push({ key, text: item.text, streaming: Boolean(message.streaming) });
      } else {
        work.push({ key, message, item });
      }
    }

    if (textItems.length === 0 && message.text.trim()) {
      const key = `${message.id}:fallback-text`;
      if (!active && messageIndex > lastToolMessageIndex) {
        responses.push({ key, text: message.text, streaming: Boolean(message.streaming) });
      } else {
        work.push({ key, message, item: { type: "text", id: "fallback-text", text: message.text } });
      }
    }
  });
  responses.forEach((response, index) => {
    if (index < responses.length - 1) response.streaming = false;
  });
  return { work, responses };
}

export function getAssistantActivity(messages: ChatMessage[]): AssistantActivity {
  return messages.some((message) => message.tools.some((tool) => tool.status === "running"))
    ? "tool"
    : "thinking";
}

export function applyAgentEvent(messages: ChatMessage[], event: AgentEvent): ChatMessage[] {
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    const raw = isRecord(event.message) ? event.message : undefined;
    if (!raw || (raw.role !== "user" && raw.role !== "assistant")) return messages;
    const incoming = messageFromRecord(raw, `event-${Date.now()}-${messages.length}`);
    if (!incoming) return messages;

    if (incoming.role === "user") {
      const last = messages.at(-1);
      if (last?.role === "user" && last.text === incoming.text) {
        return messages.map((message, index) =>
          index === messages.length - 1 ? {
            ...message,
            queued: false,
            timestamp: incoming.timestamp ?? message.timestamp,
            images: incoming.images.length > 0 ? incoming.images : message.images,
          } : message,
        );
      }
      if (event.type === "message_start") return [...messages, incoming];
      return messages;
    }

    const streamingIndex = findLastAssistant(messages, true);
    const lastAssistantIndex = findLastAssistant(messages, false);
    const targetIndex = streamingIndex >= 0 ? streamingIndex : event.type === "message_start" ? -1 : lastAssistantIndex;
    const isStreaming = event.type !== "message_end";
    if (targetIndex < 0 || (event.type === "message_start" && streamingIndex < 0)) {
      return [...messages, { ...incoming, streaming: isStreaming }];
    }
    return messages.map((message, index) => {
      if (index !== targetIndex) return message;
      const tools = mergeTools(message.tools, incoming.tools);
      return {
        ...message,
        ...incoming,
        id: message.id,
        streaming: isStreaming,
        tools,
        work: mergeWork(message.work, incoming.work, tools),
      };
    });
  }

  if (event.type === "tool_execution_start") {
    const activity = toolFromEvent(event, "running");
    return upsertLastAssistantTool(messages, activity);
  }
  if (event.type === "tool_execution_update") {
    const activity = toolFromEvent(event, "running");
    activity.output = stringifyToolResult(event.partialResult);
    return upsertLastAssistantTool(messages, activity);
  }
  if (event.type === "tool_execution_end") {
    const isError = event.isError === true;
    const activity = toolFromEvent(event, isError ? "error" : "complete");
    activity.output = stringifyToolResult(event.result);
    return upsertLastAssistantTool(messages, activity);
  }
  return messages;
}

export function optimisticUserMessage(text: string, queued = false, images: ChatImage[] = []): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: "user",
    text,
    timestamp: Date.now(),
    queued,
    images,
    tools: [],
    work: [],
  };
}

export function getMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function messageFromRecord(value: JsonRecord, id: string): ChatMessage | undefined {
  if (value.role !== "user" && value.role !== "assistant") return undefined;
  const content = value.content;
  const text = getMessageText(content);
  const thinking = getThinking(content);
  const images = getImages(content);
  const timestamp = normalizeTimestamp(value.timestamp);
  const tools = getTools(content, timestamp);
  const work = value.role === "assistant" ? getWork(content) : [];
  return {
    id,
    role: value.role,
    text,
    images,
    ...(thinking ? { thinking } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    tools,
    work,
  };
}

function getImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap<ChatImage>((part) => {
    if (part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") return [];
    if (!part.mimeType.startsWith("image/") || !part.data) return [];
    return [{ data: part.data, mimeType: part.mimeType }];
  });
}

function getThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
    .map((part) => String(part.thinking))
    .join("\n");
}

function getTools(content: unknown, startedAt?: number): ToolActivity[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap<ToolActivity>((part, index) => {
    if (part.type !== "toolCall" || typeof part.name !== "string") return [];
    const id = typeof part.id === "string" ? part.id : `content-tool-${index}`;
    return [{
      id,
      name: part.name,
      title: toolTitle(part.name, part.arguments),
      status: "complete" as const,
      ...(startedAt !== undefined ? { startedAt } : {}),
      args: part.arguments,
    }];
  });
}

function getWork(content: unknown): WorkItem[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap<WorkItem>((part, index) => {
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      return [{ type: "thinking" as const, id: `thinking-${index}`, text: part.thinking }];
    }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return [{ type: "text" as const, id: `text-${index}`, text: part.text }];
    }
    if (part.type === "toolCall" && typeof part.name === "string") {
      const toolId = typeof part.id === "string" ? part.id : `content-tool-${index}`;
      return [{ type: "tool" as const, id: `tool-${toolId}`, toolId }];
    }
    return [];
  });
}

function attachStoredToolResult(messages: ChatMessage[], result: JsonRecord): void {
  if (typeof result.toolCallId !== "string") return;
  const endedAt = normalizeTimestamp(result.timestamp);
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    const toolIndex = message.tools.findIndex((tool) => tool.id === result.toolCallId);
    if (toolIndex < 0) continue;
    const tools = [...message.tools];
    const output = stringifyToolResult(result);
    tools[toolIndex] = {
      ...tools[toolIndex]!,
      status: result.isError === true ? "error" : "complete",
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(output ? { output } : {}),
    };
    messages[messageIndex] = { ...message, tools };
    return;
  }
}

function toolFromEvent(event: AgentEvent, status: ToolActivity["status"]): ToolActivity {
  const name = typeof event.toolName === "string" ? event.toolName : "tool";
  const id = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${Date.now()}`;
  const timestamp = eventTimestamp(event);
  return {
    id,
    name,
    title: toolTitle(name, event.args),
    status,
    ...(status === "running" ? { startedAt: timestamp } : { endedAt: timestamp }),
    args: event.args,
  };
}

function eventTimestamp(event: AgentEvent): number {
  return normalizeTimestamp(event.timestamp) ?? Date.now();
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function toolTitle(name: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const command = stringField(record, "cmd") || stringField(record, "command");
  const file = stringField(record, "path") || stringField(record, "file_path");
  if (name.includes("exec") || name.includes("bash") || name.includes("command")) {
    return command ? `Ran ${crop(command, 90)}` : "Ran a command";
  }
  if (name.includes("read")) return file ? `Read ${file}` : "Read files";
  if (name.includes("write")) return file ? `Wrote ${file}` : "Wrote a file";
  if (name.includes("edit") || name.includes("patch")) return file ? `Edited ${file}` : "Edited files";
  if (name.includes("search")) return `Searched the workspace`;
  if (name === "update_plan") return "Updated the plan";
  return name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function upsertLastAssistantTool(messages: ChatMessage[], activity: ToolActivity): ChatMessage[] {
  let index = findLastAssistant(messages, false);
  let next = messages;
  if (index < 0) {
    next = [...messages, {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: "",
      timestamp: activity.startedAt ?? Date.now(),
      streaming: false,
      images: [],
      tools: [],
      work: [],
    }];
    index = next.length - 1;
  }
  return next.map((message, messageIndex) => {
    if (messageIndex !== index) return message;
    const toolIndex = message.tools.findIndex((tool) => tool.id === activity.id);
    const tools = toolIndex < 0
      ? [...message.tools, activity]
      : message.tools.map((tool, index) => index === toolIndex ? {
          ...tool,
          ...activity,
          args: activity.args ?? tool.args,
          output: activity.output ?? tool.output,
        } : tool);
    const hasWorkItem = message.work.some((item) => item.type === "tool" && item.toolId === activity.id);
    const work = hasWorkItem
      ? message.work
      : [...message.work, { type: "tool" as const, id: `tool-${activity.id}`, toolId: activity.id }];
    return { ...message, tools, work };
  });
}

function mergeTools(current: ToolActivity[], incoming: ToolActivity[]): ToolActivity[] {
  const merged = [...current];
  for (const tool of incoming) {
    const index = merged.findIndex((candidate) => candidate.id === tool.id);
    if (index < 0) merged.push(tool);
    else merged[index] = { ...tool, ...merged[index] };
  }
  return merged;
}

function mergeWork(current: WorkItem[], incoming: WorkItem[], tools: ToolActivity[]): WorkItem[] {
  const merged = incoming.length > 0 ? incoming : current;
  const toolIds = new Set(merged.flatMap((item) => item.type === "tool" ? [item.toolId] : []));
  const missingTools = tools
    .filter((tool) => !toolIds.has(tool.id))
    .map((tool) => ({ type: "tool" as const, id: `tool-${tool.id}`, toolId: tool.id }));
  return [...merged, ...missingTools];
}

function findLastAssistant(messages: ChatMessage[], streamingOnly: boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && (!streamingOnly || message.streaming)) return index;
  }
  return -1;
}

function stringifyToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return crop(value, 12_000);
  if (isRecord(value)) {
    if (typeof value.content === "string") return crop(value.content, 12_000);
    if (Array.isArray(value.content)) {
      const text = getMessageText(value.content);
      if (text) return crop(text, 12_000);
    }
  }
  try {
    return crop(JSON.stringify(value, null, 2), 12_000);
  } catch {
    return String(value);
  }
}

function stringField(value: JsonRecord, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function crop(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
