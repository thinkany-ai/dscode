import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stripModelCredentialEnvironment } from "./providers.js";
import type { SandboxMode } from "./runtime-options.js";
import { hostShellCommand } from "./shell.js";
import {
  windowsNativeSandboxCommand,
  windowsNativeSandboxDescription,
  windowsNativeSandboxEnabled,
} from "./windows-sandbox.js";

export interface SandboxOptions {
  mode: SandboxMode;
  network: boolean;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  description: string;
}

export function sandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): SandboxedCommand {
  if (options.mode === "danger-full-access") {
    return hostShellCommand(shellCommand);
  }

  if (windowsNativeSandboxEnabled()) {
    return windowsNativeSandboxCommand(shellCommand, cwd, options);
  }

  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const shell = process.env.SHELL ?? "/bin/sh";
    const workspace = fs.realpathSync(cwd);
    const temporary = fs.realpathSync(os.tmpdir());
    const writable =
      options.mode === "workspace-write"
        ? [workspace, temporary, "/dev/null", "/dev/tty"]
        : ["/dev/null", "/dev/tty"];
    const rules = [
      "(version 1)",
      "(allow default)",
      writable.length === 0
        ? "(deny file-write*)"
        : `(deny file-write* (require-not (require-any ${writable
            .map((directory) => `(subpath "${escapeSeatbelt(directory)}")`)
            .join(" ")})))`,
      options.network ? "" : "(deny network*)",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", rules, shell, "-lc", shellCommand],
      description: `macOS Seatbelt (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  const image = process.env.DSCODE_SANDBOX_IMAGE;
  if (image && commandExists("docker")) {
    const networkArgs = options.network ? [] : ["--network", "none"];
    const userArgs =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    const mount = options.mode === "read-only" ? `${cwd}:/workspace:ro` : `${cwd}:/workspace`;
    const readOnlyArgs =
      options.mode === "read-only"
        ? ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"]
        : [];
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        ...userArgs,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        ...networkArgs,
        ...readOnlyArgs,
        "-v",
        mount,
        "-w",
        "/workspace",
        image,
        "/bin/sh",
        "-lc",
        shellCommand,
      ],
      description: `Docker ${image} (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  throw new Error(
    `No OS sandbox backend is available for ${options.mode}. ` +
      "Install macOS sandbox-exec, or set DSCODE_SANDBOX_IMAGE to a trusted Docker image. " +
      "Use --sandbox danger-full-access only for a trusted workspace.",
  );
}

export function sandboxDescription(options: SandboxOptions): string {
  if (options.mode === "danger-full-access") return "host access";
  if (windowsNativeSandboxEnabled()) return windowsNativeSandboxDescription(options);
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return `Seatbelt ${options.mode}${options.network ? " + network" : ""}`;
  }
  if (process.env.DSCODE_SANDBOX_IMAGE && commandExists("docker")) {
    return `Docker ${options.mode}${options.network ? " + network" : ""}`;
  }
  return `unavailable (${options.mode})`;
}

export function executeSandboxedCommand(
  shellCommand: string,
  cwd: string,
  sandbox: SandboxOptions,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const invocation = sandboxCommand(shellCommand, cwd, sandbox);
  return new Promise((resolve, reject) => {
    const environment = stripModelCredentialEnvironment({ ...(options.env ?? process.env) });
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const stop = (): void => {
      if (child.killed) return;
      signalSandboxProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(
        () => {
          if (child.exitCode === null && child.signalCode === null) {
            signalSandboxProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          }
        },
        1_500,
      ).unref();
    };
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(stop, Math.max(1, options.timeout));
    timer?.unref();
    const abort = (): void => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode });
    });
  });
}

function signalSandboxProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
  if (process.platform === "win32" || pid === undefined) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

function escapeSeatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .some((directory) => fs.existsSync(path.join(directory, command)));
}
