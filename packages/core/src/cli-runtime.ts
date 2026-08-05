import process from "node:process";
import pc from "picocolors";
import { ensureFirstRunAuth, runAuthCommand } from "./auth.js";
import { installDSCodeCredentialStore } from "./credential-store.js";
import { createDSCodeExtension } from "./dscode-extension.js";
import { initializeDSCodeHome } from "./home.js";
import { installPiLoginSecretMask } from "./pi-login-mask.js";
import { installPiMarkdownCodeBlocks } from "./pi-markdown.js";
import { parseSupportedProviderId, type SupportedProviderId } from "./providers.js";
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
