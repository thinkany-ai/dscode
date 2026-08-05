import path from "node:path";
import { z } from "zod";
import {
  harnessSchema,
  permissionSchema,
  transportSchema,
  type HarnessMode,
  type ModelTransport,
  type PermissionMode,
} from "./config.js";
import { DSCODE_VERSION } from "./version.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getDSCodeStorageSettings,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
} from "./settings.js";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  parseSupportedProviderId,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
} from "./providers.js";

export const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export interface DSCodeRuntimeOptions {
  cwd: string;
  providerId: SupportedProviderId;
  baseUrl: string;
  modelId: string;
  transport: ModelTransport;
  harness: HarnessMode;
  permission: PermissionMode;
  sandbox: SandboxMode;
  network: boolean;
  webSearch: boolean;
  activeTools: string[];
  toolsExplicit: boolean;
}

export interface ParsedRuntimeArgs {
  options: DSCodeRuntimeOptions;
  piArgs: string[];
  help: boolean;
  version: boolean;
}

export function parseRuntimeArgs(argv: string[]): ParsedRuntimeArgs {
  const forwarded: string[] = [];
  const storedSelection = getStoredModelSelection();
  let cwd = process.cwd();
  let baseUrl =
    process.env.DEEPSEEK_BASE_URL ??
    getStoredDeepSeekBaseUrl() ??
    DEFAULT_DEEPSEEK_BASE_URL;
  let providerId = parseSupportedProviderId(
    process.env.DSCODE_PROVIDER ?? storedSelection?.providerId ?? "deepseek",
  );
  let modelExplicit = process.env.DSCODE_MODEL !== undefined;
  let modelId =
    process.env.DSCODE_MODEL ??
    (storedSelection?.providerId === providerId ? storedSelection.modelId : undefined);
  let effortExplicit = process.env.DSCODE_EFFORT !== undefined;
  let effort = process.env.DSCODE_EFFORT;
  let transport = transportSchema.parse(process.env.DSCODE_TRANSPORT ?? "responses");
  let harness = harnessSchema.parse(process.env.DSCODE_HARNESS ?? "minimal");
  let permission = permissionSchema.parse(process.env.DSCODE_PERMISSION ?? "auto");
  let sandbox = sandboxModeSchema.parse(process.env.DSCODE_SANDBOX ?? "workspace-write");
  let network = false;
  let webSearch = false;
  let activeTools: string[] | undefined;
  let toolsExplicit = false;
  let help = false;
  let version = false;
  let yolo = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inlineValue] = splitFlag(argument);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };

    if (flag === "-C" || flag === "--cwd") {
      cwd = path.resolve(takeValue());
    } else if (flag === "--provider") {
      providerId = parseSupportedProviderId(takeValue());
      if (!modelExplicit) modelId = undefined;
      if (!effortExplicit) effort = undefined;
    } else if (flag === "--base-url") {
      baseUrl = takeValue();
    } else if (flag === "--transport") {
      transport = transportSchema.parse(takeValue());
    } else if (flag === "--harness") {
      harness = harnessSchema.parse(takeValue());
    } else if (flag === "--permission") {
      permission = permissionSchema.parse(takeValue());
    } else if (flag === "--sandbox") {
      sandbox = sandboxModeSchema.parse(takeValue());
    } else if (flag === "--network") {
      network = true;
    } else if (flag === "--web") {
      webSearch = true;
    } else if (flag === "--yes" || flag === "-y") {
      permission = "full";
      yolo = true;
    } else if (flag === "--effort") {
      effort = takeValue();
      effortExplicit = true;
    } else if (flag === "--model") {
      modelId = takeValue();
      modelExplicit = true;
    } else if (flag === "--tools") {
      activeTools = takeValue()
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      toolsExplicit = true;
    } else if (flag === "--no-tools") {
      activeTools = [];
      toolsExplicit = true;
    } else if (flag === "--no-resume") {
      // Pi starts a new persisted session unless --continue/--resume is passed.
    } else if (flag === "--help" || flag === "-h") {
      help = true;
    } else if (
      flag === "--version" ||
      flag === "-V" ||
      (flag === "version" && argv.length === 1)
    ) {
      version = true;
    } else {
      forwarded.push(argument);
    }
  }

  if (
    yolo &&
    !["--approve", "-a", "--no-approve", "-na"].some((flag) => hasFlag(forwarded, flag))
  ) {
    forwarded.unshift("--approve");
  }
  if (
    getDSCodeStorageSettings().historyPersistence === "none" &&
    !["--no-session", "--session", "--resume", "--continue", "--fork"].some((flag) =>
      hasFlag(forwarded, flag),
    )
  ) {
    forwarded.unshift("--no-session");
  }
  modelId ??= defaultModelForProvider(providerId);
  effort ??= defaultEffortForProvider(providerId);
  forwarded.unshift("--provider", providerId);
  if (!hasFlag(forwarded, "--model")) forwarded.unshift("--model", modelId);
  if (!hasFlag(forwarded, "--thinking")) forwarded.unshift("--thinking", effort);
  activeTools ??= defaultActiveTools(harness);

  return {
    options: {
      cwd,
      providerId,
      baseUrl: normalizeDeepSeekBaseUrl(baseUrl),
      modelId,
      transport,
      harness,
      permission,
      sandbox,
      network,
      webSearch,
      activeTools,
      toolsExplicit,
    },
    piArgs: forwarded,
    help,
    version,
  };
}

function defaultActiveTools(harness: HarnessMode): string[] {
  const delegation = Number(process.env.DSCODE_SUBAGENT_DEPTH ?? "0") < 1 ? ["delegate"] : [];
  return harness === "minimal"
    ? ["update_plan", "exec_command", "write_stdin", "apply_patch", ...delegation]
    : [
        "update_plan",
        "read_file",
        "list_files",
        "search_files",
        "language_diagnostics",
        "exec_command",
        "write_stdin",
        "apply_patch",
        ...delegation,
      ];
}

export function printDSCodeHelp(): void {
  process.stdout.write(`DSCode ${DSCODE_VERSION} — local-first coding agent

Usage:
  dscode [options] [prompt]
  dscode -p "task"                 Non-interactive text mode
  dscode --mode json -p "task"     JSONL/CI mode
  dscode --mode rpc                IDE/RPC server
  dscode --resume                  Pick a saved session
  dscode --continue                Continue the latest workspace session

DSCode options:
  -C, --cwd <dir>                  Workspace directory
  --provider <id>                 ${SUPPORTED_PROVIDER_IDS.join("|")}
  --base-url <url>                 DeepSeek API base URL
  --model <id>                     Model ID (provider default when omitted)
  --effort <level>                 Alias for --thinking; defaults by provider
  --transport <responses|chat>     API transport (default: responses)
  --harness <minimal|safe>         Tool harness (default: minimal)
  --permission <mode>              plan|ask|auto|full (full grants host + network)
  --sandbox <mode>                 read-only|workspace-write|danger-full-access
  --network                        Pre-authorize command network access for this run
  --web                            Enable DeepSeek server-side web search
  -y, --yes                        YOLO: trust project, skip approvals, allow host + network

Session and editor features:
  /help /settings /new /clear /name /resume /tree /compact /reload /export
  Ctrl+O tool folding, Ctrl+G external editor, Ctrl+P model cycle
  --name, --fork, --session, --session-dir, --skills, --extension
  --mode text|json|rpc, --print, --no-session, --continue, --resume

DSCode commands:
  /plan /permissions /effort /base-url /status /undo /checkpoints /diff /jobs /mcp /agents /doctor

Authentication:
  dscode login [provider]           Sign in to a supported model provider
  dscode logout [provider]          Remove the selected provider credential
  dscode auth status                Show credential sources without revealing secrets
  /login                            Choose a provider interactively
  /login <provider>                 Authenticate a specific provider

Experimental Windows sandbox:
  dscode sandbox setup              Install identities and WFP filters (elevated terminal)
  dscode sandbox status             Inspect native sandbox readiness
  dscode sandbox uninstall          Remove native sandbox state (elevated terminal)
  DSCODE_WINDOWS_SANDBOX=1          Explicitly opt in after setup succeeds
`);
}

function splitFlag(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--") || !argument.includes("=")) return [argument, undefined];
  const index = argument.indexOf("=");
  return [argument.slice(0, index), argument.slice(index + 1)];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}
