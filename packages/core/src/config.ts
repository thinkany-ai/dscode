import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
} from "./settings.js";

export const effortSchema = z.enum(["low", "high", "max"]);
export type Effort = z.infer<typeof effortSchema>;
export const transportSchema = z.enum(["responses", "chat"]);
export type ModelTransport = z.infer<typeof transportSchema>;
export const harnessSchema = z.enum(["minimal", "safe"]);
export type HarnessMode = z.infer<typeof harnessSchema>;
/**
 * `trusted-workspace` is reserved for local integrations (for example the
 * built-in Weixin channel).  It keeps the OS workspace sandbox while allowing
 * non-interactive work and network access.  It is intentionally not advertised
 * as a general CLI preset.
 */
export const permissionSchema = z.enum(["plan", "ask", "auto", "full", "trusted-workspace"]);
export type PermissionMode = z.infer<typeof permissionSchema>;

export interface AppConfig {
  workspace: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  effort: Effort;
  transport: ModelTransport;
  harness: HarnessMode;
  permission: PermissionMode;
  webSearch: boolean;
  resume: boolean;
  verbose: boolean;
}

export interface CliOptions {
  cwd?: string;
  baseUrl?: string;
  model?: string;
  effort?: string;
  transport?: string;
  harness?: string;
  permission?: string;
  web?: boolean;
  yes?: boolean;
  resume?: boolean;
  verbose?: boolean;
}

export function loadConfig(options: CliOptions): AppConfig {
  const workspace = path.resolve(options.cwd ?? process.cwd());
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  const effort = effortSchema.parse(options.effort ?? process.env.DSCODE_EFFORT ?? "max");
  const transport = transportSchema.parse(
    options.transport ?? process.env.DSCODE_TRANSPORT ?? "responses",
  );
  const harness = harnessSchema.parse(options.harness ?? process.env.DSCODE_HARNESS ?? "minimal");
  const permission = options.yes
    ? "full"
    : permissionSchema.parse(options.permission ?? process.env.DSCODE_PERMISSION ?? "auto");

  return {
    workspace,
    apiKey,
    baseUrl: normalizeDeepSeekBaseUrl(
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        getStoredDeepSeekBaseUrl() ??
        DEFAULT_DEEPSEEK_BASE_URL,
    ),
    modelId: options.model ?? process.env.DSCODE_MODEL ?? "deepseek-v4-flash",
    effort,
    transport,
    harness,
    permission,
    webSearch: options.web ?? false,
    resume: options.resume ?? true,
    verbose: options.verbose ?? false,
  };
}
