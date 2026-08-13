import type { PermissionMode } from "./config.js";
import type { ManagedProcessResult } from "./managed-process.js";
import type { SandboxMode } from "./runtime-options.js";

export type AccessBoundary = "network" | "host";

export interface EffectiveAccess {
  sandbox: SandboxMode;
  network: boolean;
}

/** Session-scoped grants layered over safe startup defaults. */
export class SessionAccessController {
  private readonly networkCommands = new Set<string>();
  private readonly hostCommands = new Set<string>();

  constructor(
    private readonly baseSandbox: SandboxMode,
    private readonly baseNetwork: boolean,
  ) {}

  effective(permission: PermissionMode): EffectiveAccess {
    if (permission === "full") return { sandbox: "danger-full-access", network: true };
    if (permission === "trusted-workspace") return { sandbox: this.baseSandbox, network: true };
    return {
      sandbox: permission === "plan" ? "read-only" : this.baseSandbox,
      network: this.baseNetwork || this.baseSandbox === "danger-full-access",
    };
  }

  forCommand(permission: PermissionMode, command: string): EffectiveAccess {
    const current = this.effective(permission);
    const key = commandKey(command);
    if (permission !== "plan" && this.hostCommands.has(key)) {
      return { sandbox: "danger-full-access", network: true };
    }
    return this.networkCommands.has(key) ? { ...current, network: true } : current;
  }

  grantForSession(boundary: AccessBoundary, command: string): void {
    const commands = boundary === "network" ? this.networkCommands : this.hostCommands;
    commands.add(commandKey(command));
  }

  grantOnce(permission: PermissionMode, boundary: AccessBoundary): EffectiveAccess {
    const current = this.effective(permission);
    return boundary === "network"
      ? { ...current, network: true }
      : { sandbox: "danger-full-access", network: true };
  }

  describeGrants(): string[] {
    return [
      ...(this.networkCommands.size > 0
        ? [`network (${grantCount(this.networkCommands.size)})`]
        : []),
      ...(this.hostCommands.size > 0 ? [`host (${grantCount(this.hostCommands.size)})`] : []),
    ];
  }
}

function commandKey(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

function grantCount(count: number): string {
  return `${count} ${count === 1 ? "command" : "commands"}`;
}

export function commandNeedsNetwork(command: string): boolean {
  const normalized = command.replace(/\\\n/g, " ").trim();
  if (!normalized) return false;
  return (
    /(^|[;&|]\s*)(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|gh)\b/i.test(normalized) ||
    /\bgit\s+(push|pull|fetch|clone|ls-remote|submodule\s+(update|sync))\b/i.test(normalized) ||
    /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|publish|login|logout|whoami|view|info|audit)\b/i.test(normalized) ||
    /\b(pip|pip3)\s+install\b/i.test(normalized) ||
    /\b(cargo\s+(fetch|install|publish)|go\s+(get|install)|go\s+mod\s+download)\b/i.test(normalized) ||
    /\b(docker\s+(pull|push|login)|brew\s+(install|update|upgrade)|terraform\s+init)\b/i.test(normalized)
  );
}

export function detectSandboxBoundary(
  command: string,
  result: ManagedProcessResult,
  access: EffectiveAccess,
): AccessBoundary | undefined {
  if (result.running || result.exitCode === 0 || access.sandbox === "danger-full-access") {
    return undefined;
  }
  const output = result.output.toLocaleLowerCase("en-US");
  if (
    !access.network &&
    (commandNeedsNetwork(command) ||
      /connect to host|could not resolve host|network is unreachable|socket.*operation not permitted|failed to connect|getaddrinfo|enotfound|eai_again/.test(output))
  ) {
    return "network";
  }
  if (/operation not permitted|permission denied|read-only file system|sandbox violation/.test(output)) {
    return "host";
  }
  return undefined;
}
