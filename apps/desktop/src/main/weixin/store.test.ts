import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WeixinStore } from "./store";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-weixin-store-"));
  temporary.push(root);
  return new WeixinStore(root);
}

describe("WeixinStore", () => {
  it("keeps one immutable bot state and durable full history", async () => {
    const store = await createStore();
    store.patchState({ workspacePath: "/workspace", sessionId: "fixed", trustedAt: 1 });
    const first = store.addMessage({ platformId: "wx-1", direction: "inbound", source: "weixin", role: "user", text: "hello", media: [], status: "processing" });
    const duplicate = store.addMessage({ platformId: "wx-1", direction: "inbound", source: "weixin", role: "user", text: "duplicate", media: [], status: "processing" });
    expect(duplicate.id).toBe(first.id);
    expect(store.getState()).toMatchObject({ workspacePath: "/workspace", sessionId: "fixed" });
    expect(store.history()).toMatchObject({ messages: [{ text: "hello" }], hasMore: false });
    store.close();
  });

  it("persists inbox before completion and keeps failed outbox work retryable", async () => {
    const store = await createStore();
    expect(store.persistInbox("wx-1", { message_id: 1 })).toBe(true);
    expect(store.persistInbox("wx-1", { message_id: 1 })).toBe(false);
    expect(store.pendingInbox()).toHaveLength(1);
    store.completeInbox("wx-1");
    expect(store.pendingInbox()).toHaveLength(0);
    store.enqueueOutbox("client-1", { to: "user", text: "reply" });
    store.failOutbox("client-1", "network");
    expect(store.pendingOutbox()).toMatchObject([{ clientId: "client-1", payload: { text: "reply" } }]);
    store.completeOutbox("client-1");
    expect(store.pendingOutbox()).toHaveLength(0);
    store.enqueueOutbox("client-2", { kind: "media", to: "user", localPath: "/tmp/a.png" });
    expect(store.pendingOutbox()).toMatchObject([{ clientId: "client-2", payload: { kind: "media", localPath: "/tmp/a.png" } }]);
    store.close();
  });

  it("removes all state and permanent media only after clear", async () => {
    const store = await createStore();
    const file = await store.saveMedia(Buffer.from("media"), "a.txt", "inbound");
    expect(store.mediaBytes()).toBe(5);
    await store.clearAll();
    expect(store.mediaBytes()).toBe(0);
    await expect(fs.access(file)).rejects.toThrow();
    expect(store.getState().workspacePath).toBeUndefined();
    store.close();
  });
});
