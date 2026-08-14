import process from "node:process";
import pc from "picocolors";
import { ensureFirstRunAuth, runAuthCommand } from "./auth.js";
import { installDSCodeCredentialStore } from "./credential-store.js";
import { createDSCodeExtension } from "./dscode-extension.js";
import { initializeDSCodeHome } from "./home.js";
import { installPiLoginSecretMask } from "./pi-login-mask.js";
import { installPiMarkdownCodeBlocks } from "./pi-markdown.js";
import { parseSupportedProviderId, type SupportedProviderId } from "./providers.js";
import {
  evaluateReplay,
  formatEvaluationResult,
  type EvaluationOptions,
} from "./evaluation.js";
import {
  compareTraceReports,
  formatReplayReport,
  readTraceFile,
} from "./replay.js";
import { parseRuntimeArgs, printDSCodeHelp } from "./runtime-options.js";
import { installDSCodeRuntimeBranding } from "./runtime-branding.js";
import { ensureDSCodeUiDefaults } from "./ui-defaults.js";
import { DSCODE_VERSION } from "./version.js";
import {
  parseWindowsSandboxLifecycleCommand,
  runWindowsSandboxLifecycle,
} from "./windows-sandbox.js";

/** Run one DSCode CLI, JSON, or RPC process using the shared runtime. */
export async function runDSCode(argv: string[]): Promise<void> {
  const windowsSandboxCommand = parseWindowsSandboxLifecycleCommand(argv);
  if (windowsSandboxCommand) {
    runWindowsSandboxLifecycle(windowsSandboxCommand);
    return;
  }
  const traceCommand = parseTraceCommand(argv);
  if (traceCommand) {
    await runTraceCommand(traceCommand);
    return;
  }
  const parsed = parseRuntimeArgs(argv);
  if (parsed.help) {
    printDSCodeHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${DSCODE_VERSION}\n`);
    return;
  }
  process.chdir(parsed.options.cwd);
  const agentDirectory = await initializeDSCodeHome();
  process.env.PI_TELEMETRY ??= "0";
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
  await ensureDSCodeUiDefaults(agentDirectory);

  const authCommand = parseAuthCommand(argv);
  if (authCommand) {
    await runAuthCommand(authCommand.command, {
      ...parsed.options,
      providerId: authCommand.providerId ?? parsed.options.providerId,
    });
    return;
  }
  await ensureFirstRunAuth({
    providerId: parsed.options.providerId,
    piArgs: parsed.piArgs,
  });
  installPiLoginSecretMask();
  installPiMarkdownCodeBlocks();
  installDSCodeRuntimeBranding();
  await installDSCodeCredentialStore();

  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(parsed.piArgs, {
    extensionFactories: [createDSCodeExtension(parsed.options)],
  });
}

interface TraceCommand {
  command: "replay" | "evaluate";
  input: string;
  compare?: string;
  json: boolean;
  evaluation: EvaluationOptions;
}

function parseTraceCommand(argv: string[]): TraceCommand | undefined {
  const command = argv[0];
  if (command !== "replay" && command !== "evaluate" && command !== "eval") return undefined;
  const paths: string[] = [];
  let json = false;
  let compare = false;
  const evaluation: EvaluationOptions = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--compare") {
      compare = true;
      continue;
    }
    const [flag, inlineValue] = splitTraceFlag(argument);
    if (
      flag === "--max-tool-calls" ||
      flag === "--max-duration-ms" ||
      flag === "--max-total-tokens" ||
      flag === "--max-cost"
    ) {
      const value = inlineValue ?? argv[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative number`);
      if (flag === "--max-tool-calls") evaluation.maxToolCalls = parsed;
      if (flag === "--max-duration-ms") evaluation.maxDurationMs = parsed;
      if (flag === "--max-total-tokens") evaluation.maxTotalTokens = parsed;
      if (flag === "--max-cost") evaluation.maxCost = parsed;
      continue;
    }
    if (argument === "--allow-errors") {
      evaluation.failOnErrors = false;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown trace option: ${argument}`);
    paths.push(argument);
  }
  if (compare) {
    if (paths.length !== 2) throw new Error("replay --compare requires baseline and candidate trace files");
    return { command: "replay", input: paths[0]!, compare: paths[1]!, json, evaluation };
  }
  if (paths.length !== 1) throw new Error(`${command} requires one trace file`);
  return {
    command: command === "eval" ? "evaluate" : command,
    input: paths[0]!,
    json,
    evaluation,
  };
}

async function runTraceCommand(command: TraceCommand): Promise<void> {
  const report = await readTraceFile(command.input);
  if (command.compare) {
    const comparison = compareTraceReports(report, await readTraceFile(command.compare));
    process.stdout.write(
      command.json
        ? `${JSON.stringify(comparison, null, 2)}\n`
        : `${formatReplayReport(comparison.baseline)}\n\nCandidate\n${formatReplayReport(comparison.candidate)}\n\nDifferences\n${comparison.differences.join("\n") || "none"}\n`,
    );
    if (!comparison.candidate.valid) process.exitCode = 1;
    return;
  }
  if (command.command === "replay") {
    process.stdout.write(`${formatReplayReport(report, command.json)}\n`);
    if (!report.valid) process.exitCode = 1;
    return;
  }
  const result = evaluateReplay(report, command.evaluation);
  process.stdout.write(`${formatEvaluationResult(result, command.json)}\n`);
  if (!result.passed) process.exitCode = 1;
}

/** Process-oriented wrapper used by the terminal and bundled RPC entry points. */
export async function runDSCodeProcess(argv: string[]): Promise<void> {
  try {
    await runDSCode(argv);
  } catch (error) {
    process.stderr.write(`${pc.red("error:")} ${formatDSCodeError(error)}\n`);
    process.exitCode = 1;
  }
}

export function formatDSCodeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ZodError") return error.message;
    return error.message;
  }
  return String(error);
}

interface AuthCommand {
  command: "login" | "logout" | "status";
  providerId?: SupportedProviderId;
}

function splitTraceFlag(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--") || !argument.includes("=")) return [argument, undefined];
  const index = argument.indexOf("=");
  return [argument.slice(0, index), argument.slice(index + 1)];
}

function parseAuthCommand(argv: string[]): AuthCommand | undefined {
  const command = argv[0];
  if (command === "login" || command === "logout") {
    return {
      command,
      ...(argv[1] ? { providerId: parseSupportedProviderId(argv[1]) } : {}),
    };
  }
  if (command === "auth" && argv[1] === "status") {
    return {
      command: "status",
      ...(argv[2] ? { providerId: parseSupportedProviderId(argv[2]) } : {}),
    };
  }
  return undefined;
}
