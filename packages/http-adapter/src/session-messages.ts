import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export type { AgentMessage };

export interface HttpMessageText {
  type: "text";
  text: string;
}

export interface HttpMessageToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type HttpSessionMessage =
  | { role: "user"; timestamp: number; content: HttpMessageText[] }
  | {
      role: "assistant";
      timestamp: number;
      content: Array<HttpMessageText | HttpMessageToolCall>;
    }
  | {
      role: "toolResult";
      timestamp: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: HttpMessageText[];
    }
  | { role: "compactionSummary"; timestamp: number; summary: string };

/**
 * Map the live agent transcript to the HTTP history shape. Thinking and image
 * content are omitted; non-chat roles (bashExecution, custom, branchSummary)
 * are dropped.
 */
export function toHttpSessionMessages(messages: readonly AgentMessage[]): HttpSessionMessage[] {
  const result: HttpSessionMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        result.push({
          role: "user",
          timestamp: message.timestamp,
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : textBlocks(message.content),
        });
        break;
      case "assistant":
        result.push({
          role: "assistant",
          timestamp: message.timestamp,
          content: assistantBlocks(message.content),
        });
        break;
      case "toolResult":
        result.push({
          role: "toolResult",
          timestamp: message.timestamp,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          content: textBlocks(message.content),
        });
        break;
      case "compactionSummary":
        result.push({
          role: "compactionSummary",
          timestamp: message.timestamp,
          summary: message.summary,
        });
        break;
      default:
        break;
    }
  }
  return result;
}

function textBlocks(blocks: ReadonlyArray<TextContent | ImageContent>): HttpMessageText[] {
  const result: HttpMessageText[] = [];
  for (const block of blocks) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
  }
  return result;
}

function assistantBlocks(
  blocks: ReadonlyArray<TextContent | ThinkingContent | ToolCall>,
): Array<HttpMessageText | HttpMessageToolCall> {
  const result: Array<HttpMessageText | HttpMessageToolCall> = [];
  for (const block of blocks) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
    else if (block.type === "toolCall") {
      result.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return result;
}
