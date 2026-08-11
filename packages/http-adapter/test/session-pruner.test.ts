import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { pruneSessionFile } from "../src/session-pruner.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dscode-prune-"));
  tempDirs.push(dir);
  return dir;
}

function userMessage(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
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
    timestamp,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pruneSessionFile", () => {
  it("drops compacted-out history and dead branches without changing context", () => {
    const cwd = tempDir();
    const sessionDir = tempDir();
    const manager = SessionManager.create(cwd, sessionDir);

    manager.appendMessage(userMessage("first question", 1));
    manager.appendMessage(assistantMessage("first answer", 2));
    const keptUserId = manager.appendMessage(userMessage("second question", 3));
    manager.appendMessage(assistantMessage("second answer", 4));
    manager.appendCompaction("earlier context summarized", keptUserId, 1000);
    manager.appendMessage(userMessage("third question", 5));
    const leafId = manager.appendMessage(assistantMessage("third answer", 6));

    manager.branch(manager.getEntries()[1]!.id);
    manager.appendMessage(userMessage("abandoned branch", 7));
    manager.appendMessage(assistantMessage("abandoned answer", 8));
    manager.branch(leafId);

    const contextBefore = manager.buildSessionContext().messages;
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const linesBefore = readFileSync(sessionFile!, "utf8").trim().split("\n").length;

    expect(pruneSessionFile(manager)).toBe(true);

    const linesAfter = readFileSync(sessionFile!, "utf8").trim().split("\n").length;
    expect(linesAfter).toBeLessThan(linesBefore);

    const reopened = SessionManager.open(sessionFile!, sessionDir, cwd);
    expect(reopened.getSessionId()).toBe(manager.getSessionId());
    expect(reopened.buildSessionContext().messages).toEqual(contextBefore);
  });

  it("keeps appending to the pruned file", () => {
    const cwd = tempDir();
    const sessionDir = tempDir();
    const manager = SessionManager.create(cwd, sessionDir);

    manager.appendMessage(userMessage("old", 1));
    manager.appendMessage(assistantMessage("old answer", 2));
    const keptUserId = manager.appendMessage(userMessage("kept", 3));
    manager.appendMessage(assistantMessage("kept answer", 4));
    manager.appendCompaction("summary", keptUserId, 1000);
    expect(pruneSessionFile(manager)).toBe(true);

    manager.appendMessage(userMessage("after prune", 5));
    const reopened = SessionManager.open(manager.getSessionFile()!, sessionDir, cwd);
    const texts: string[] = [];
    for (const message of reopened.buildSessionContext().messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (typeof message.content === "string") {
        texts.push(message.content);
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text") texts.push(block.text);
      }
    }
    expect(texts).toContain("after prune");
    expect(texts).not.toContain("old");
  });

  it("is a no-op for in-memory sessions and sessions with nothing to prune", () => {
    const memory = SessionManager.inMemory(tempDir());
    memory.appendMessage(userMessage("hello", 1));
    memory.appendMessage(assistantMessage("hi", 2));
    expect(pruneSessionFile(memory)).toBe(false);

    const cwd = tempDir();
    const sessionDir = tempDir();
    const linear = SessionManager.create(cwd, sessionDir);
    linear.appendMessage(userMessage("hello", 1));
    linear.appendMessage(assistantMessage("hi", 2));
    expect(pruneSessionFile(linear)).toBe(false);
  });
});
