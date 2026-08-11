import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Rewrite a persisted session file down to its active content: the header plus the
 * compaction-aware leaf path. Drops compacted-out history and dead branches without
 * changing the live context. The parentId chain is rebuilt linearly because pruning
 * removes ancestors that retained entries point at (same re-chaining pi performs in
 * createBranchedSession). Returns whether the file was rewritten.
 */
export function pruneSessionFile(manager: SessionManager): boolean {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) return false;

  const entries = manager.getEntries();
  const keptIds = new Set(manager.buildContextEntries().map((entry) => entry.id));
  const kept = entries.filter((entry) => keptIds.has(entry.id));
  if (kept.length === entries.length) return false;

  const header = manager.getHeader();
  if (!header) return false;

  const lines = [JSON.stringify(header)];
  let parentId: string | null = null;
  for (const entry of kept) {
    lines.push(JSON.stringify({ ...entry, parentId }));
    parentId = entry.id;
  }

  const tempFile = path.join(
    path.dirname(sessionFile),
    `.${path.basename(sessionFile)}.${randomUUID()}.tmp`,
  );
  writeFileSync(tempFile, `${lines.join("\n")}\n`);
  renameSync(tempFile, sessionFile);
  return true;
}
