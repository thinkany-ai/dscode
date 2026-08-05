import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDSCodeHome } from "./home.js";
import type { SandboxOptions, SandboxedCommand } from "./sandbox.js";
import type { ShellInvocation } from "./shell.js";

const EXPERIMENTAL_ENV = "DSCODE_WINDOWS_SANDBOX";
const HELPER_ENV = "DSCODE_WINDOWS_SANDBOX_HELPER";
const STATE_ENV = "DSCODE_WINDOWS_SANDBOX_STATE";

interface WindowsSandboxStatus {
  ready: boolean;
  version?: number;
  missing?: string[];
}

interface WindowsSandboxRuntime {
  helperPath: string;
  statePath: string;
  shell?: ShellInvocation;
}

interface WindowsSandboxManifest {
  version: number;
  protocol: number;
  files: Record<string, string>;
}

export type WindowsSandboxLifecycleCommand = "setup" | "status" | "uninstall";

export function windowsNativeSandboxEnabled(): boolean {
  const value = process.env[EXPERIMENTAL_ENV]?.trim().toLowerCase();
  return process.platform === "win32" && (value === "1" || value === "true");
}

export function windowsNativeSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): SandboxedCommand {
  const runtime = configuredRuntime();
  const status = readStatus(runtime);
  if (!status.ready) {
    const details = status.missing?.length ? ` Missing: ${status.missing.join(", ")}.` : "";
    throw new Error(
      `The experimental Windows native sandbox is not ready.${details} ` +
        "Run the Windows sandbox setup command from an elevated terminal.",
    );
  }
  return buildWindowsSandboxCommand(shellCommand, cwd, options, runtime);
}

export function buildWindowsSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
  runtime: WindowsSandboxRuntime,
): SandboxedCommand {
  const shell = runtime.shell ?? nativePowerShellCommand(shellCommand);
  const requestPath = path.join(
    os.tmpdir(),
    `dscode-windows-sandbox-${process.pid}-${randomUUID()}.json`,
  );
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      version: 1,
      state_path: runtime.statePath,
      mode: options.mode,
      network: options.network,
      command: shell.command,
      args: shell.args,
      cwd: path.resolve(cwd),
    }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    command: runtime.helperPath,
    args: ["run", requestPath],
    description: `Windows native sandbox (${options.mode}${options.network ? ", network" : ", no network"})`,
  };
}

function nativePowerShellCommand(shellCommand: string): ShellInvocation {
  const configured = process.env.DSCODE_SHELL?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (path.basename(resolved).toLowerCase() !== "pwsh.exe" || !fs.existsSync(resolved)) {
      throw new Error("The Windows native sandbox requires DSCODE_SHELL to point to pwsh.exe.");
    }
    return powerShellInvocation(resolved, shellCommand);
  }
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, "pwsh.exe");
    if (fs.existsSync(candidate)) return powerShellInvocation(candidate, shellCommand);
  }
  throw new Error(
    "The experimental Windows native sandbox requires PowerShell 7 (pwsh.exe).",
  );
}

function powerShellInvocation(command: string, shellCommand: string): ShellInvocation {
  return {
    command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", shellCommand],
    description: `PowerShell 7 (${path.basename(command)})`,
  };
}

export function windowsNativeSandboxDescription(options: SandboxOptions): string {
  try {
    const status = readStatus(configuredRuntime());
    if (!status.ready) return `Windows native sandbox unavailable (${options.mode})`;
    return `Windows native ${options.mode}${options.network ? " + network" : ""}`;
  } catch {
    return `Windows native sandbox unavailable (${options.mode})`;
  }
}

function configuredRuntime(): WindowsSandboxRuntime {
  const helperPath = process.env[HELPER_ENV]?.trim();
  const resolvedHelper = helperPath
    ? path.resolve(helperPath)
    : resolvePackagedHelper(process.arch);
  const resolvedState = path.resolve(
    process.env[STATE_ENV]?.trim() ?? path.join(getDSCodeHome(), "windows-sandbox", "state.bin"),
  );
  if (!fs.existsSync(resolvedHelper)) {
    throw new Error(`Windows sandbox helper is missing: ${resolvedHelper}`);
  }
  return { helperPath: resolvedHelper, statePath: resolvedState };
}

export function parseWindowsSandboxLifecycleCommand(
  argv: string[],
): WindowsSandboxLifecycleCommand | undefined {
  if (argv[0] !== "sandbox") return undefined;
  const command = argv[1];
  if (command === "setup" || command === "status" || command === "uninstall") {
    if (argv.length !== 2) throw new Error(`dscode sandbox ${command} does not accept arguments.`);
    return command;
  }
  throw new Error("Usage: dscode sandbox <setup|status|uninstall>");
}

export function runWindowsSandboxLifecycle(command: WindowsSandboxLifecycleCommand): void {
  if (process.platform !== "win32") {
    throw new Error("The native Windows sandbox lifecycle is available only on Windows.");
  }
  const runtime = configuredRuntime();
  fs.mkdirSync(path.dirname(runtime.statePath), { recursive: true, mode: 0o700 });
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(readStatus(runtime), null, 2)}\n`);
    return;
  }
  if (command === "setup" && readStatus(runtime).ready) {
    process.stdout.write("Windows native sandbox is already ready.\n");
    return;
  }
  runHelper(runtime, command === "setup" ? "setup-install" : "setup-uninstall");
  if (command === "setup") {
    const status = readStatus(runtime);
    if (!status.ready) throw new Error("Windows sandbox setup completed without becoming ready.");
    process.stdout.write("Windows native sandbox setup completed.\n");
  } else {
    process.stdout.write("Windows native sandbox uninstalled.\n");
  }
}

function runHelper(runtime: WindowsSandboxRuntime, action: string): void {
  const result = spawnSync(runtime.helperPath, [action, runtime.statePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Windows sandbox ${action} failed (${result.status}).`);
  }
}

function resolvePackagedHelper(architecture: string): string {
  const target =
    architecture === "x64"
      ? "win32-x64"
      : architecture === "arm64"
        ? "win32-arm64"
        : undefined;
  if (!target) throw new Error(`Unsupported Windows sandbox architecture: ${architecture}`);
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const relative = `${target}/dscode-windows-sandbox.exe`;
  const helper = path.join(moduleRoot, "native", "windows-sandbox", relative);
  const manifestPath = path.join(moduleRoot, "native", "windows-sandbox", "manifest.json");
  if (!fs.existsSync(helper) || !fs.existsSync(manifestPath)) {
    throw new Error(
      `The packaged Windows sandbox helper is missing for ${target}. ` +
        `Set ${HELPER_ENV} only when testing a trusted development build.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WindowsSandboxManifest;
  if (manifest.version !== 1 || manifest.protocol !== 1) {
    throw new Error("The packaged Windows sandbox manifest is incompatible.");
  }
  const expected = manifest.files[relative];
  const actual = createHash("sha256").update(fs.readFileSync(helper)).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error(`Windows sandbox helper checksum verification failed for ${target}.`);
  }
  return helper;
}

function readStatus(runtime: WindowsSandboxRuntime): WindowsSandboxStatus {
  const result = spawnSync(runtime.helperPath, ["setup-status", runtime.statePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `Windows sandbox status failed with exit code ${result.status}.`,
    );
  }
  try {
    return JSON.parse(result.stdout) as WindowsSandboxStatus;
  } catch {
    throw new Error("Windows sandbox helper returned malformed status JSON.");
  }
}
