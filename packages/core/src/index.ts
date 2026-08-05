export {
  formatDSCodeError,
  runDSCode,
  runDSCodeProcess,
} from "./cli-runtime.js";
export { createDSCodeExtension } from "./dscode-extension.js";
export {
  createDSCodeRpcClient,
  getDSCodeRpcEntryPath,
  RpcClient,
  type DSCodeRpcClientOptions,
  type RpcClientOptions,
} from "./rpc-client.js";
export {
  authenticateProvider,
  getDSCodeAgentDir,
  getDSCodeAuthPath,
  hasDeepSeekEnvironmentKey,
  hasStoredDeepSeekKey,
  hasStoredProviderCredential,
  removeStoredDeepSeekKey,
  removeStoredProviderCredential,
  runAuthCommand,
  saveDeepSeekKey,
  saveProviderApiKey,
  validateDeepSeekKey,
  type ApiKeyProviderId,
  type KeyValidation,
  type ProviderLoginResult,
} from "./auth.js";
export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
export {
  createDSCodeCredentialStore,
  FileCredentialStore,
  installDSCodeCredentialStore,
  KeyringCredentialStore,
  type CreateCredentialStoreOptions,
  type DSCodeKeyringFactory,
} from "./credential-store.js";
export {
  getDSCodeArchivedSessionsDir,
  getDSCodeHome,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  migrateLegacyDSCodeHome,
  partitionExistingSessions,
  partitionSessionFile,
  type PartitionedSessionPath,
} from "./home.js";
export {
  DSCodeStateStore,
  getDSCodeStatePath,
  indexDSCodeSession,
  listDSCodeThreads,
  type DSCodeThread,
  type ListThreadOptions,
} from "./state.js";
export {
  DEFAULT_DEEPSEEK_BASE_URL,
  getDSCodeStorageSettings,
  getDSCodeSettingsPath,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
  type CredentialStoreMode,
  type DSCodeStorageSettings,
  type HistoryPersistence,
} from "./settings.js";
export {
  MODEL_CREDENTIAL_ENV_KEYS,
  SUPPORTED_PROVIDER_IDS,
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  isSupportedProviderId,
  parseSupportedProviderId,
  providerDisplayName,
  providerEnvironmentKey,
  stripModelCredentialEnvironment,
  type StoredModelSelection,
  type SupportedProviderId,
} from "./providers.js";
export {
  parseRuntimeArgs,
  printDSCodeHelp,
  sandboxModeSchema,
  type DSCodeRuntimeOptions,
  type ParsedRuntimeArgs,
  type SandboxMode,
} from "./runtime-options.js";
export { DSCODE_VERSION } from "./version.js";
