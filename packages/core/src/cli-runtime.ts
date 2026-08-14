import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
import { readAgentFixtureFile } from "./fixture.js";
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
  execute?: boolean;
  prompt?: string;
  json: boolean;
  evaluation: EvaluationOptions;
}

function parseTraceCommand(argv: string[]): TraceCommand | undefined {
  const command = argv[0];
  if (command !== "replay" && command !== "evaluate" && command !== "eval") return undefined;
  const paths: string[] = [];
  let json = false;
  let compare = false;
  let execute = false;
  let prompt: string | undefined;
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
    if (flag === "--execute") {
      if (command !== "replay") {
        throw new Error("--execute is only supported by replay");
      }
      const value = inlineValue ?? argv[++index];
      if (!value) throw new Error("--execute requires a fixture file");
      execute = true;
      paths.push(value);
      continue;
    }
    if (flag === "--prompt") {
      prompt = inlineValue ?? argv[++index];
      if (!prompt) throw new Error("--prompt requires a value");
      continue;
    }
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
    if (execute) throw new Error("replay --execute cannot be combined with --compare");
    if (paths.length !== 2) throw new Error("replay --compare requires baseline and candidate trace files");
    return { command: "replay", input: paths[0]!, compare: paths[1]!, json, evaluation };
  }
  if (paths.length !== 1) throw new Error(`${command} requires one trace file`);
  return {
    command: command === "eval" ? "evaluate" : command,
    input: paths[0]!,
    ...(execute ? { execute } : {}),
    ...(prompt ? { prompt } : {}),
    json,
    evaluation,
  };
}

async function runTraceCommand(command: TraceCommand): Promise<void> {
  if (command.execute) {
    await runFixtureReplayCommand(command);
    return;
  }
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

async function runFixtureReplayCommand(command: TraceCommand): Promise<void> {
  const fixturePath = path.resolve(command.input);
  const fixture = await readAgentFixtureFile(fixturePath);
  if (fixture.provider !== "deepseek") {
    throw new Error(`Fixture provider "${fixture.provider}" is not supported by this runtime yet`);
  }
  const runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-fixture-replay-"));
  const traceDirectory = path.join(runDirectory, "traces");
  const homeDirectory = path.join(runDirectory, "home");
  try {
    const nestedExitCode = await runFixtureRuntime({
      fixturePath,
      fixtureModel: fixture.model,
      prompt: command.prompt ?? "Replay fixture",
      homeDirectory,
      traceDirectory,
    });
    const traceFiles = (await fs.readdir(traceDirectory))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    if (traceFiles.length === 0) {
      throw new Error("Fixture replay completed without producing a trace");
    }
    const report = await readTraceFile(path.join(traceDirectory, traceFiles[traceFiles.length - 1]!));
    const result = evaluateReplay(
      report,
      { ...(fixture.evaluation ?? {}), ...command.evaluation },
    );
    const assertionViolations = fixtureAssertionViolations(fixture, report);
    result.violations.push(...assertionViolations);
    if (nestedExitCode !== 0 && report.finalStatus === "completed") {
      result.violations.push(`fixture runtime exited with code ${nestedExitCode}`);
    }
    result.passed = result.violations.length === 0;
    process.stdout.write(`${formatEvaluationResult(result, command.json)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  } finally {
    await fs.rm(runDirectory, { recursive: true, force: true });
  }
}

interface FixtureRuntimeOptions {
  fixturePath: string;
  fixtureModel: string;
  prompt: string;
  homeDirectory: string;
  traceDirectory: string;
}

async function runFixtureRuntime(options: FixtureRuntimeOptions): Promise<number> {
  const invocation = currentCliInvocation();
  const child = spawn(
    invocation.command,
    [
      ...invocation.args,
      "--provider",
      "deepseek",
      "--model",
      options.fixtureModel,
      "--permission",
      "full",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-approve",
      options.prompt,
    ],
    {
      env: {
        ...process.env,
        DSCODE_HOME: options.homeDirectory,
        DSCODE_SESSIONS_DIR: path.join(options.homeDirectory, "sessions"),
        DSCODE_TRACE_DIR: options.traceDirectory,
        DSCODE_TRACE: "1",
        DSCODE_FIXTURE_PATH: options.fixturePath,
        DEEPSEEK_API_KEY: "dscode-fixture",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: "ignore",
    },
  );
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function currentCliInvocation(): { command: string; args: string[] } {
  const [nodePath, launcher, source] = process.argv;
  if (!nodePath || !launcher) throw new Error("Could not determine the current DSCode CLI invocation");
  if (source?.endsWith(".ts")) {
    return { command: nodePath, args: [launcher, source] };
  }
  return { command: nodePath, args: [launcher] };
}

function fixtureAssertionViolations(
  fixture: Awaited<ReturnType<typeof readAgentFixtureFile>>,
  report: Awaited<ReturnType<typeof readTraceFile>>,
): string[] {
  const violations: string[] = [];
  if (report.counts.modelResponses !== fixture.responses.length) {
    violations.push(
      `fixture responses consumed: ${report.counts.modelResponses} != ${fixture.responses.length}`,
    );
  }
  const assertions = fixture.assertions;
  if (!assertions) return violations;
  if (assertions.finalStatus && report.finalStatus !== assertions.finalStatus) {
    violations.push(`expected final status ${assertions.finalStatus}, got ${report.finalStatus ?? "missing"}`);
  }
  if (assertions.modelResponses !== undefined && report.counts.modelResponses !== assertions.modelResponses) {
    violations.push(
      `expected model responses ${assertions.modelResponses}, got ${report.counts.modelResponses}`,
    );
  }
  if (assertions.toolNames && JSON.stringify(report.toolNames) !== JSON.stringify(assertions.toolNames)) {
    violations.push(
      `expected tool sequence ${JSON.stringify(assertions.toolNames)}, got ${JSON.stringify(report.toolNames)}`,
    );
  }
  return violations;
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
