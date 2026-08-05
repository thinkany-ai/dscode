import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Provider,
} from "@earendil-works/pi-ai";
import pc from "picocolors";
import { createDSCodeCredentialStore } from "./credential-store.js";
import { getDSCodeHome } from "./home.js";
import {
  defaultModelForProvider,
  providerDisplayName,
  providerEnvironmentKey,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
} from "./providers.js";
import {
  getDSCodeSettingsPath,
  getDSCodeStorageSettings,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
} from "./settings.js";

const PROVIDER_ID = "deepseek";

interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export type ApiKeyProviderId = Exclude<SupportedProviderId, "openai-codex">;

export interface ProviderLoginResult {
  providerId: Exclude<SupportedProviderId, "deepseek">;
  modelId: string;
}

export type KeyValidation =
  | { status: "valid"; modelAvailable: boolean }
  | { status: "invalid"; message: string }
  | { status: "unverified"; message: string };

export function getDSCodeAgentDir(): string {
  return getDSCodeHome();
}

export function getDSCodeAuthPath(): string {
  return path.join(getDSCodeAgentDir(), "auth.json");
}

export async function hasStoredDeepSeekKey(authPath?: string): Promise<boolean> {
  const credential = await (await credentialStore(authPath)).read(PROVIDER_ID);
  return isApiKeyCredential(credential) && credential.key.trim().length > 0;
}

export async function hasStoredProviderCredential(
  providerId: SupportedProviderId,
  authPath?: string,
): Promise<boolean> {
  return isStoredCredential(await (await credentialStore(authPath)).read(providerId));
}

export function hasDeepSeekEnvironmentKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function saveDeepSeekKey(
  key: string,
  authPath?: string,
): Promise<void> {
  await saveProviderApiKey(PROVIDER_ID, key, authPath);
}

export async function saveProviderApiKey(
  providerId: ApiKeyProviderId,
  key: string,
  authPath?: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error(`${providerDisplayName(providerId)} API key cannot be empty`);
  await (await credentialStore(authPath)).modify(
    providerId,
    async () => ({ type: "api_key", key: trimmed }) satisfies ApiKeyCredential,
  );
}

export async function removeStoredDeepSeekKey(
  authPath?: string,
): Promise<boolean> {
  return removeStoredProviderCredential(PROVIDER_ID, authPath);
}

export async function removeStoredProviderCredential(
  providerId: SupportedProviderId,
  authPath?: string,
): Promise<boolean> {
  const store = await credentialStore(authPath);
  if (!(await store.read(providerId))) return false;
  await store.delete(providerId);
  return true;
}

export async function validateDeepSeekKey(
  key: string,
  baseUrl: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key.trim()}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", message: `DeepSeek rejected the key (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return {
        status: "unverified",
        message: `DeepSeek validation returned HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as unknown;
    const modelAvailable =
      isRecord(body) &&
      Array.isArray(body.data) &&
      body.data.some((model) => isRecord(model) && model.id === modelId);
    return { status: "valid", modelAvailable };
  } catch (error) {
    return {
      status: "unverified",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isInteractiveInvocation(piArgs: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (piArgs.includes("--print") || piArgs.includes("-p")) return false;
  const mode = optionValue(piArgs, "--mode");
  return mode === undefined || mode === "tui" || mode === "interactive";
}

export async function ensureFirstRunAuth(options: {
  providerId: SupportedProviderId;
  piArgs: string[];
}): Promise<void> {
  const environmentKey = providerEnvironmentKey(options.providerId);
  const configured =
    Boolean(environmentKey && process.env[environmentKey]?.trim()) ||
    (await hasStoredProviderCredential(options.providerId));
  if (configured || isInteractiveInvocation(options.piArgs)) return;

  const environmentHint = environmentKey ? ` or set ${environmentKey}` : "";
  throw new Error(
    `${providerDisplayName(options.providerId)} is not configured. Run \`dscode login ${options.providerId}\`${environmentHint}.`,
  );
}

export async function runAuthCommand(
  command: "login" | "logout" | "status",
  options: { providerId: SupportedProviderId; baseUrl: string; modelId: string },
): Promise<void> {
  if (command === "logout") {
    const removed = await removeStoredProviderCredential(options.providerId);
    const providerName = providerDisplayName(options.providerId);
    process.stdout.write(
      removed
        ? `${pc.green("✓")} Removed the stored ${providerName} credential.\n`
        : `No stored ${providerName} credential was found.\n`,
    );
    const environmentKey = providerEnvironmentKey(options.providerId);
    if (environmentKey && process.env[environmentKey]?.trim()) {
      process.stdout.write(
        `${pc.yellow("!")} ${environmentKey} is still set in this environment.\n`,
      );
    }
    return;
  }
  if (command === "status") {
    const store = await createDSCodeCredentialStore();
    const storedProviders = new Set((await store.list()).map((entry) => entry.providerId));
    const providers = SUPPORTED_PROVIDER_IDS.map((providerId) => {
      const environmentKey = providerEnvironmentKey(providerId);
      const stored = storedProviders.has(providerId);
      const environment = Boolean(environmentKey && process.env[environmentKey]?.trim());
      return `${providerId.padEnd(13)} ${stored || environment ? pc.green("configured") : pc.yellow("not configured")}${stored ? " · stored" : ""}${environment ? ` · ${environmentKey}` : ""}`;
    });
    process.stdout.write(
      [
        `Active provider: ${options.providerId}`,
        ...providers,
        `DeepSeek API base URL: ${options.baseUrl}`,
        `Credential store: ${getDSCodeStorageSettings().credentialStore}`,
        `Credential file fallback: ${getDSCodeAuthPath()}`,
        `DeepSeek config file: ${getDSCodeSettingsPath()}`,
      ].join("\n") + "\n",
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`dscode login` requires an interactive terminal");
  }
  if (options.providerId === "deepseek") {
    await promptAndStoreKey(options.baseUrl, options.modelId);
    return;
  }
  await loginWithProvider(options.providerId);
}

async function promptAndStoreKey(baseUrl: string, modelId: string): Promise<string> {
  while (true) {
    const key = await readSecret("DeepSeek API key: ");
    if (!key.trim()) throw new Error("API key setup cancelled");
    const selectedBaseUrl = await promptBaseUrl(baseUrl);
    process.stdout.write(pc.dim(`Validating with ${selectedBaseUrl}… `));
    const validation = await validateDeepSeekKey(key, selectedBaseUrl, modelId);
    if (validation.status === "invalid") {
      process.stdout.write(`${pc.red("failed")}\n${pc.red(validation.message)}. Try again.\n`);
      baseUrl = selectedBaseUrl;
      continue;
    }
    if (validation.status === "unverified") {
      process.stdout.write(`${pc.yellow("could not verify")}\n`);
      process.stdout.write(`${pc.dim(validation.message)}\n`);
      const save = await confirmLine("Save this key anyway? [y/N] ");
      if (!save) continue;
    } else {
      process.stdout.write(`${pc.green("verified")}\n`);
      if (!validation.modelAvailable) {
        process.stdout.write(
          `${pc.yellow("!")} The key works, but ${modelId} was not returned by /models.\n`,
        );
      }
    }
    await saveDeepSeekKey(key);
    await saveDeepSeekBaseUrl(selectedBaseUrl);
    await saveDefaultModelSelection("deepseek", modelId);
    process.stdout.write(`${pc.green("✓")} API key saved securely. Start coding with ${pc.bold("dscode")}.\n`);
    return selectedBaseUrl;
  }
}

async function loginWithProvider(providerId: Exclude<SupportedProviderId, "deepseek">): Promise<void> {
  process.stdout.write(`${pc.bold(providerDisplayName(providerId))}\n`);
  const result = await authenticateProvider(providerId, terminalAuthInteraction());
  process.stdout.write(
    `${pc.green("✓")} Signed in securely. ${result.providerId}/${result.modelId} is now the default.\n`,
  );
}

/** Authenticate a non-DeepSeek provider using callbacks supplied by a terminal or graphical host. */
export async function authenticateProvider(
  providerId: Exclude<SupportedProviderId, "deepseek">,
  interaction: AuthInteraction,
): Promise<ProviderLoginResult> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    credentials: await createDSCodeCredentialStore(),
    modelsPath: path.join(getDSCodeAgentDir(), "models.json"),
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`Provider ${providerId} is unavailable in this DSCode build`);
  const authType = await selectProviderAuthType(provider, interaction);
  await runtime.login(providerId, authType, interaction);
  const modelId = defaultModelForProvider(providerId);
  await saveDefaultModelSelection(providerId, modelId);
  return { providerId, modelId };
}

async function selectProviderAuthType(
  provider: Provider,
  interaction: AuthInteraction,
): Promise<AuthType> {
  const methods: Array<{
    id: AuthType;
    label: string;
    description: string;
  }> = [];
  if (provider.auth.oauth) {
    methods.push({
      id: "oauth",
      label: provider.auth.oauth.loginLabel ?? "Sign in with an account",
      description: provider.auth.oauth.name,
    });
  }
  if (provider.auth.apiKey?.login) {
    methods.push({
      id: "api_key",
      label: "Sign in with an API key",
      description: provider.auth.apiKey.name,
    });
  }
  if (methods.length === 0) {
    throw new Error(`Provider ${provider.id} has no interactive login method`);
  }
  if (methods.length === 1) return methods[0]!.id;
  const selected = await interaction.prompt({
    type: "select",
    message: `Select authentication method for ${provider.name}`,
    options: methods,
  });
  const method = methods.find((candidate) => candidate.id === selected);
  if (!method) throw new Error(`Unknown authentication method: ${selected}`);
  return method.id;
}

async function saveDefaultModelSelection(
  providerId: SupportedProviderId,
  modelId: string,
): Promise<void> {
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const settings = SettingsManager.create(process.cwd(), getDSCodeAgentDir());
  settings.setDefaultModelAndProvider(providerId, modelId);
  await settings.flush();
}

function terminalAuthInteraction(): AuthInteraction {
  return {
    prompt: promptForAuth,
    notify: notifyAuth,
  };
}

async function promptForAuth(prompt: AuthPrompt): Promise<string> {
  if (prompt.signal?.aborted) throw new Error("Login cancelled");
  if (prompt.type === "secret") {
    return readSecret(`${prompt.message}${prompt.message.endsWith(" ") ? "" : " "}`);
  }
  if (prompt.type === "select") {
    process.stdout.write(`${prompt.message}\n`);
    prompt.options.forEach((option, index) => {
      process.stdout.write(
        `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`,
      );
    });
    const answer = await readLine("Choose [1]: ", prompt.signal);
    if (!answer) return prompt.options[0]?.id ?? "";
    const numeric = Number.parseInt(answer, 10);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
      return prompt.options[numeric - 1]!.id;
    }
    const matched = prompt.options.find((option) => option.id === answer);
    if (matched) return matched.id;
    throw new Error(`Unknown selection: ${answer}`);
  }
  return readLine(
    `${prompt.message}${prompt.placeholder ? ` [${prompt.placeholder}]` : ""}: `,
    prompt.signal,
  );
}

function notifyAuth(event: AuthEvent): void {
  if (event.type === "auth_url") {
    process.stdout.write(`${event.instructions ?? "Complete login in your browser."}\n${event.url}\n`);
    openExternalUrl(event.url);
    return;
  }
  if (event.type === "device_code") {
    process.stdout.write(
      `Open ${event.verificationUri} and enter code ${pc.bold(event.userCode)}.\n`,
    );
    openExternalUrl(event.verificationUri);
    return;
  }
  process.stdout.write(`${event.message}\n`);
  if (event.type === "info") {
    for (const link of event.links ?? []) {
      process.stdout.write(`${link.label ? `${link.label}: ` : ""}${link.url}\n`);
    }
  }
}

async function readLine(message: string, signal?: AbortSignal): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = signal
      ? await readline.question(message, { signal })
      : await readline.question(message);
    return value.trim();
  } catch (error) {
    if (signal?.aborted) throw new Error("Login prompt cancelled");
    throw error;
  } finally {
    readline.close();
  }
}

function openExternalUrl(url: string): void {
  const invocation =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => undefined);
  child.unref();
}

async function promptBaseUrl(defaultBaseUrl: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const value = (await readline.question(formatBaseUrlPrompt(defaultBaseUrl))).trim();
      try {
        return normalizeDeepSeekBaseUrl(value || defaultBaseUrl);
      } catch (error) {
        process.stdout.write(`${pc.red((error as Error).message)}. Try again.\n`);
      }
    }
  } finally {
    readline.close();
  }
}

export function formatBaseUrlPrompt(defaultBaseUrl: string): string {
  return `API base URL (optional, press Enter to use default) [${defaultBaseUrl}]: `;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("A TTY is required for secret input");
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const wasFlowing = stdin.readableFlowing === true;
  let value = "";
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error): void => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      if (!wasFlowing) stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const data = chunk
        .toString()
        .replaceAll("\u001b[200~", "")
        .replaceAll("\u001b[201~", "")
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
      if (data === "\u0003") {
        finish(new Error("API key setup cancelled"));
        return;
      }
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u001b") {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function confirmLine(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/i.test((await readline.question(prompt)).trim());
  } finally {
    readline.close();
  }
}

async function credentialStore(authPath?: string) {
  return createDSCodeCredentialStore(
    authPath ? { authPath, mode: "file" } : undefined,
  );
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
  return isRecord(value) && value.type === "api_key" && typeof value.key === "string";
}

function isStoredCredential(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") return typeof value.key === "string" && value.key.trim().length > 0;
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
