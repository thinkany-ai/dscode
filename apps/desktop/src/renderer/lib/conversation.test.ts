import { describe, expect, it } from "vitest";
import { applyAgentEvent, coalesceStreamingAgentEvents, getAssistantActivity, groupConversation, normalizeMessages, optimisticUserMessage, splitAssistantTurn } from "./conversation";

describe("conversation events", () => {
  it("coalesces high-frequency streaming updates by payload key", () => {
    const firstMessageUpdate = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "A" }] } };
    const secondMessageUpdate = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "AB" }] } };
    const firstToolUpdate = { type: "tool_execution_update", toolCallId: "tool-1", partialResult: "A" };
    const secondToolUpdate = { type: "tool_execution_update", toolCallId: "tool-1", partialResult: "AB" };

    expect(coalesceStreamingAgentEvents([
      firstMessageUpdate,
      firstToolUpdate,
      secondMessageUpdate,
      secondToolUpdate,
    ])).toEqual([secondMessageUpdate, secondToolUpdate]);
  });

  it("normalizes assistant text, thinking, and tool calls", () => {
    const messages = normalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the project" },
          { type: "toolCall", id: "tool-1", name: "exec_command", arguments: { cmd: "rg --files" } },
          { type: "text", text: "Done." },
        ],
        timestamp: 1_700_000_000_000,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "exec_command",
        content: [{ type: "text", text: "src/index.ts" }],
        isError: false,
        timestamp: 1_700_000_003_000,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", text: "Done.", thinking: "Inspect the project" });
    expect(messages[0]?.tools[0]).toMatchObject({
      id: "tool-1",
      title: "Ran rg --files",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_003_000,
      output: "src/index.ts",
    });
    expect(messages[0]?.work).toEqual([
      { type: "thinking", id: "thinking-0", text: "Inspect the project" },
      { type: "tool", id: "tool-tool-1", toolId: "tool-1" },
      { type: "text", id: "text-2", text: "Done." },
    ]);
  });

  it("deduplicates optimistic user messages and streams one assistant message", () => {
    let messages = [optimisticUserMessage("Build the desktop app")];
    messages = applyAgentEvent(messages, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "Build the desktop app" }] },
    });
    messages = applyAgentEvent(messages, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    });
    messages = applyAgentEvent(messages, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Working. Done." }] },
    });

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", text: "Working. Done.", streaming: false });
  });

  it("keeps images on optimistic and stored user messages", () => {
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    const stored = normalizeMessages([{
      role: "user",
      content: [{ type: "text", text: "What is this?" }, image],
    }]);
    expect(stored[0]?.images).toEqual([{ mimeType: "image/png", data: "aW1hZ2U=" }]);

    let messages = [optimisticUserMessage("What is this?", false, [{ mimeType: "image/png", data: "aW1hZ2U=" }])];
    messages = applyAgentEvent(messages, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "What is this?" }, image] },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.images).toHaveLength(1);
  });

  it("correlates tool start and completion events", () => {
    let messages = applyAgentEvent([], { type: "tool_execution_start", toolCallId: "call-1", toolName: "apply_patch", args: {}, timestamp: 1_700_000_000_000 });
    expect(getAssistantActivity(messages)).toBe("tool");

    messages = applyAgentEvent(messages, { type: "tool_execution_end", toolCallId: "call-1", toolName: "apply_patch", result: "patched", isError: false, timestamp: 1_700_000_002_000 });
    expect(getAssistantActivity(messages)).toBe("thinking");

    expect(messages[0]?.tools).toHaveLength(1);
    expect(messages[0]?.tools[0]).toMatchObject({
      id: "call-1",
      status: "complete",
      output: "patched",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_002_000,
    });
    expect(messages[0]?.work).toEqual([{ type: "tool", id: "tool-call-1", toolId: "call-1" }]);
  });

  it("keeps thinking as the active fallback between message segments", () => {
    const messages = normalizeMessages([{
      role: "assistant",
      content: [{ type: "thinking", thinking: "Inspect the project" }],
    }]);

    expect(getAssistantActivity(messages)).toBe("thinking");
  });

  it("keeps reasoning and tools in their original content order", () => {
    const messages = normalizeMessages([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect first" },
        { type: "text", text: "I’ll read the file." },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } },
        { type: "thinking", thinking: "Then make the change" },
        { type: "toolCall", id: "call-2", name: "apply_patch", arguments: { path: "src/a.ts" } },
      ],
    }]);

    expect(messages[0]?.work.map((item) => item.type === "tool" ? item.toolId : item.text)).toEqual([
      "Inspect first",
      "I’ll read the file.",
      "call-1",
      "Then make the change",
      "call-2",
    ]);
  });

  it("groups consecutive assistant messages into one turn", () => {
    const messages = normalizeMessages([
      { role: "user", content: [{ type: "text", text: "Explain the codebase" }] },
      { role: "assistant", content: [{ type: "text", text: "I’ll inspect it." }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec_command", arguments: { cmd: "rg --files" } }] },
      { role: "assistant", content: [{ type: "text", text: "Here is the explanation." }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]);

    const groups = groupConversation(messages);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toMatchObject({ type: "assistant" });
    expect(groups[1]?.type === "assistant" ? groups[1].messages : []).toHaveLength(3);
  });

  it("keeps final response text outside work even when its message contains thinking", () => {
    const messages = normalizeMessages([
      { role: "assistant", content: [
        { type: "thinking", thinking: "Inspect the file" },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Summarize the result" },
        { type: "text", text: "Here is the final answer." },
      ] },
    ]);

    const turn = splitAssistantTurn(messages);
    expect(turn.work.map((entry) => entry.item.type)).toEqual(["thinking", "tool", "thinking"]);
    expect(turn.responses.map((entry) => entry.text)).toEqual(["Here is the final answer."]);
  });

  it("keeps all streamed text inside work until the turn is settled", () => {
    const messages = normalizeMessages([
      { role: "assistant", content: [
        { type: "thinking", thinking: "Inspect the file" },
        { type: "text", text: "I’ll inspect the evidence first." },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } },
      ] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Summarize the result" },
        { type: "text", text: "Here is the final answer." },
      ] },
    ]);

    const activeTurn = splitAssistantTurn(messages, true);
    expect(activeTurn.responses).toEqual([]);
    expect(activeTurn.work.map((entry) => entry.item.type)).toEqual(["thinking", "text", "tool", "thinking", "text"]);

    const settledTurn = splitAssistantTurn(messages, false);
    expect(settledTurn.work.map((entry) => entry.item.type)).toEqual(["thinking", "text", "tool", "thinking"]);
    expect(settledTurn.responses.map((entry) => entry.text)).toEqual(["Here is the final answer."]);
  });

  it("starts a new assistant message after a completed tool instead of reordering it", () => {
    let messages = applyAgentEvent([], {
      type: "message_start",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "Edit first" },
        { type: "toolCall", id: "call-1", name: "apply_patch", arguments: { path: "src/a.ts" } },
      ] },
    });
    messages = applyAgentEvent(messages, {
      type: "message_end",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "Edit first" },
        { type: "toolCall", id: "call-1", name: "apply_patch", arguments: { path: "src/a.ts" } },
      ] },
    });
    messages = applyAgentEvent(messages, { type: "tool_execution_start", toolCallId: "call-1", toolName: "apply_patch", args: { path: "src/a.ts" } });
    messages = applyAgentEvent(messages, { type: "tool_execution_end", toolCallId: "call-1", toolName: "apply_patch", result: "patched", isError: false });
    messages = applyAgentEvent(messages, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "Verify next" }] },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.streaming).toBe(false);
    expect(messages[1]?.thinking).toBe("Verify next");
    expect(groupConversation(messages)[0]?.type).toBe("assistant");
    expect(splitAssistantTurn(messages).work.map((entry) => entry.item.type === "tool" ? entry.item.toolId : entry.item.text)).toEqual([
      "Edit first",
      "call-1",
      "Verify next",
    ]);
  });
});
