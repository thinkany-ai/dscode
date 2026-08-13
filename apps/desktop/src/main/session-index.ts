import { DSCodeStateStore, listDSCodeThreads } from "@thinkany/dscode-core";
import type { SessionSummary } from "../shared/types";

export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  return (await listDSCodeThreads(cwd ? { cwd } : {})).map(toSessionSummary);
}

export async function readSessionSummary(file: string): Promise<SessionSummary | undefined> {
  const store = new DSCodeStateStore(":memory:");
  try {
    const thread = await store.indexSession(file);
    return thread ? toSessionSummary(thread) : undefined;
  } finally {
    store.close();
  }
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<boolean> {
  return withStore((store) => store.setPinned(id, pinned));
}

export async function archiveSession(id: string): Promise<SessionSummary | undefined> {
  return withStore(async (store) => {
    const thread = await store.archive(id);
    return thread ? toSessionSummary(thread) : undefined;
  });
}

export async function unarchiveSession(id: string): Promise<SessionSummary | undefined> {
  return withStore(async (store) => {
    const thread = await store.unarchive(id);
    return thread ? toSessionSummary(thread) : undefined;
  });
}

function toSessionSummary(thread: Awaited<ReturnType<typeof listDSCodeThreads>>[number]): SessionSummary {
  return {
    path: thread.sessionPath,
    storagePath: thread.storagePath,
    id: thread.id,
    cwd: thread.cwd,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.provider ? { provider: thread.provider } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    messageCount: thread.messageCount,
    ...(thread.preview ? { preview: thread.preview } : {}),
    pinned: thread.pinned,
    archived: thread.archived,
  };
}

async function withStore<T>(task: (store: DSCodeStateStore) => T | Promise<T>): Promise<T> {
  const store = new DSCodeStateStore();
  try {
    return await task(store);
  } finally {
    store.close();
  }
}
