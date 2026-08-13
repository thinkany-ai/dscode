const PREVIEW_FILE_EXTENSIONS = new Set([
  "aac", "avif", "bash", "bmp", "c", "cc", "cjs", "conf", "config", "cpp", "cs", "css", "csv",
  "env", "fish", "flac", "gif", "go", "graphql", "h", "htm", "html", "ico", "ini", "java", "jpeg",
  "jpg", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "m4a", "m4v", "markdown", "md",
  "mdx", "mjs", "mov", "mp3", "mp4", "ogg", "ogv", "pdf", "php", "png", "py", "rb", "rs", "sass",
  "scss", "sh", "sql", "svelte", "svg", "swift", "toml", "ts", "tsv", "tsx", "txt", "vue", "wav",
  "webm", "webp", "xml", "yaml", "yml", "zsh",
]);

const PLAIN_FILE_REFERENCE = new RegExp(
  String.raw`(?:^|[\s"'(（【])((?:(?:~|\.\.?)\/)?(?:[\p{L}\p{N}_@.+-]+\/)*[\p{L}\p{N}_@.+-]+\.[\p{L}\p{N}]+)(?=$|[\s"'\x60,，。；;:：)）】])`,
  "gimu",
);

/** Finds previewable file references in assistant text and command output. */
export function previewPathsFromText(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const addPath = (rawValue: string) => {
    let candidate = rawValue.trim();
    if (!candidate || candidate.length > 500 || candidate.includes("\n")) return;

    if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1).trim();
    if (/^file:\/\//i.test(candidate)) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname);
      } catch {
        return;
      }
    }
    if (/^(?:https?:|data:|mailto:|#)/i.test(candidate)) return;

    candidate = candidate.replace(/^["'`(<（【]+|["'`>,，。；;:：)）】]+$/g, "");
    const pathWithoutQuery = candidate.split(/[?#]/, 1)[0] ?? candidate;
    const extension = /\.([\p{L}\p{N}]+)$/u.exec(pathWithoutQuery)?.[1]?.toLowerCase();
    if (!extension || !PREVIEW_FILE_EXTENSIONS.has(extension) || seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) addPath(match[1] ?? "");
  for (const match of text.matchAll(/!?\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)) {
    const destination = (match[1] ?? "").trim();
    addPath(destination.startsWith("<") ? destination : destination.split(/\s+["']/)[0] ?? destination);
  }
  for (const match of text.matchAll(PLAIN_FILE_REFERENCE)) addPath(match[1] ?? "");

  return paths;
}

/** Keeps inferred preview links scoped to the task's active workspace. */
export function isPreviewPathInWorkspace(filePath: string, workspaceRoot?: string): boolean {
  const candidate = normalizePath(filePath);
  if (!candidate || candidate.startsWith("~/")) return false;

  const absolute = candidate.startsWith("/") || /^[a-z]:\//i.test(candidate);
  if (!absolute) return !relativePathEscapesWorkspace(candidate);
  if (!workspaceRoot) return false;

  const root = normalizePath(workspaceRoot).replace(/\/$/, "");
  const caseInsensitive = /^[a-z]:\//i.test(candidate) || /^[a-z]:\//i.test(root);
  const comparableCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  return comparableCandidate === comparableRoot || comparableCandidate.startsWith(`${comparableRoot}/`);
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function relativePathEscapesWorkspace(value: string): boolean {
  let depth = 0;
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}
