import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionSummary } from "./session-index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("session index", () => {
  it("extracts workspace, model, title, and message count from JSONL", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-desktop-test-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "session.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/tmp/project" }),
      JSON.stringify({ type: "model_change", modelId: "deepseek-v4-flash" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Implement a polished desktop client" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the core package." }] } }),
    ].join("\n"));

    await expect(readSessionSummary(file)).resolves.toMatchObject({
      id: "session-1",
      cwd: "/tmp/project",
      model: "deepseek-v4-flash",
      title: "Implement a polished desktop client",
      messageCount: 2,
    });
  });
});
