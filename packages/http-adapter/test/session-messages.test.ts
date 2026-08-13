import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/session-messages.js";
import { toHttpSessionMessages } from "../src/session-messages.js";

describe("toHttpSessionMessages", () => {
  it("normalizes string user content and drops image blocks", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "plain string", timestamp: 1 },
      {
        role: "user",
        content: [
          { type: "text", text: "block text" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        timestamp: 2,
      },
    ];
    expect(toHttpSessionMessages(messages)).toEqual([
      { role: "user", timestamp: 1, content: [{ type: "text", text: "plain string" }] },
      { role: "user", timestamp: 2, content: [{ type: "text", text: "block text" }] },
    ]);
  });

  it("keeps text and tool calls, drops thinking", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "visible" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
        ],
        api: "openai-completions",
        provider: "openrouter",
        model: "test-model",
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 3,
      },
    ];
    expect(toHttpSessionMessages(messages)).toEqual([
      {
        role: "assistant",
        timestamp: 3,
        content: [
          { type: "text", text: "visible" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ]);
  });

  it("maps tool results with identity fields", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: true,
        timestamp: 4,
      },
    ];
    expect(toHttpSessionMessages(messages)).toEqual([
      {
        role: "toolResult",
        timestamp: 4,
        toolCallId: "call-1",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "ok" }],
      },
    ]);
  });

  it("maps compaction summaries and drops non-chat roles", () => {
    const messages: AgentMessage[] = [
      { role: "compactionSummary", summary: "earlier work", tokensBefore: 1000, timestamp: 5 },
      {
        role: "bashExecution",
        command: "ls",
        output: "files",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 6,
      },
      { role: "branchSummary", summary: "branch", fromId: "entry-1", timestamp: 7 },
    ];
    expect(toHttpSessionMessages(messages)).toEqual([
      { role: "compactionSummary", timestamp: 5, summary: "earlier work" },
    ]);
  });
});
