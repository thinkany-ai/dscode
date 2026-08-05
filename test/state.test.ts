import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDSCodeHome } from "../packages/core/src/home.js";
import { DSCodeStateStore } from "../packages/core/src/state.js";

describe("DSCode state index", () => {
  const temporaryDirectories: string[] = [];
  const environment = new Map(
    [
      "DSCODE_HOME",
      "DSCODE_SESSIONS_DIR",
      "DSCODE_ARCHIVED_SESSIONS_DIR",
      "DSCODE_SQLITE_HOME",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
    ].map((name) => [name, process.env[name]]),
  );

  afterEach(async () => {
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
    );
  });

  it("partitions JSONL transcripts, indexes metadata, and archives reversibly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-state-test-"));
    temporaryDirectories.push(root);
    const home = path.join(root, "home");
    const sessions = path.join(home, "sessions");
    const archived = path.join(home, "archived_sessions");
    process.env.DSCODE_HOME = home;
    process.env.DSCODE_SESSIONS_DIR = sessions;
    process.env.DSCODE_ARCHIVED_SESSIONS_DIR = archived;
    process.env.DSCODE_SQLITE_HOME = home;
    await fs.mkdir(sessions, { recursive: true });
    const runtimePath = path.join(sessions, "thread-1.jsonl");
    await fs.writeFile(
      runtimePath,
      [
        JSON.stringify({
          type: "session",
          id: "thread-1",
          cwd: path.join(root, "workspace"),
          timestamp: "2026-08-03T03:04:05.000Z",
        }),
        JSON.stringify({ type: "model_change", provider: "deepseek", modelId: "deepseek-chat" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "Build the desktop app" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "Working on it" } }),
        "",
      ].join("\n"),
    );

    await initializeDSCodeHome();
    const storagePath = path.join(sessions, "2026", "08", "03", "thread-1.jsonl");
    const [runtimeStat, storageStat] = await Promise.all([fs.stat(runtimePath), fs.stat(storagePath)]);
    expect(runtimeStat.ino).toBe(storageStat.ino);
    expect(runtimeStat.nlink).toBeGreaterThanOrEqual(2);

    const store = new DSCodeStateStore(path.join(home, "state.sqlite"));
    try {
      await store.refresh();
      expect(store.list()).toEqual([
        expect.objectContaining({
          id: "thread-1",
          sessionPath: runtimePath,
          storagePath,
          title: "Build the desktop app",
          preview: "Working on it",
          provider: "deepseek",
          model: "deepseek-chat",
          messageCount: 2,
          archived: false,
        }),
      ]);

      expect(store.setPinned("thread-1", true)).toBe(true);
      const archivedThread = await store.archive("thread-1");
      expect(archivedThread).toMatchObject({ archived: true, pinned: true });
      await expect(fs.stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(store.list()).toEqual([]);
      expect(store.list({ includeArchived: true })).toHaveLength(1);

      const restored = await store.unarchive("thread-1");
      expect(restored).toMatchObject({ archived: false, pinned: true, sessionPath: runtimePath });
      await expect(fs.stat(runtimePath)).resolves.toBeDefined();
    } finally {
      store.close();
    }
  });
});
