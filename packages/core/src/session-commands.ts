import fs from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";

function isUserMessage(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
  return entry.type === "message" && entry.message.role === "user";
}

function sessionFileContent(header: SessionHeader | null, entries: SessionEntry[]): string {
  const fileEntries = header ? [header, ...entries] : entries;
  return fileEntries.map((entry) => JSON.stringify(entry)).join("\n") + (fileEntries.length > 0 ? "\n" : "");
}

/**
 * Replace the active session path in place. Pi sessions are append-only by
 * design, so rewriting the same file is the only way to remove the abandoned
 * assistant/tool response without creating a fork or a new session.
 */
async function rewriteSessionBeforeEntry(
  ctx: ExtensionCommandContext,
  target: Extract<SessionEntry, { type: "message" }>,
): Promise<boolean> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    const result = await ctx.navigateTree(target.id, { summarize: false });
    return !result.cancelled;
  }

  const activePrefix = target.parentId === null
    ? []
    : ctx.sessionManager.getBranch(target.parentId);
  const previousContent = await fs.readFile(sessionFile, "utf8");
  await fs.writeFile(sessionFile, sessionFileContent(ctx.sessionManager.getHeader(), activePrefix), "utf8");
  try {
    const result = await ctx.switchSession(sessionFile);
    if (result.cancelled) {
      await fs.writeFile(sessionFile, previousContent, "utf8");
    }
    return !result.cancelled;
  } catch (error) {
    await fs.writeFile(sessionFile, previousContent, "utf8").catch(() => undefined);
    throw error;
  }
}

async function editLastMessage(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.isIdle()) throw new Error("Wait for the current response to finish before editing the last message.");

  const target = [...ctx.sessionManager.getBranch()].reverse().find(isUserMessage);
  if (!target) throw new Error("There is no user message to edit.");
  await rewriteSessionBeforeEntry(ctx, target);
}

export function registerSessionCommands(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear context and start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      // Replacing a session invalidates this command context immediately. Do not access
      // ctx (including ctx.ui) after the awaited call.
      await ctx.newSession();
    },
  });

  pi.registerCommand("edit-last", {
    description: "Edit and replace the last user message in this session",
    handler: async (_args, ctx) => {
      await editLastMessage(ctx);
    },
  });
}
