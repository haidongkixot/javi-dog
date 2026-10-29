// JD-C01 public contract. Import from '@javis-dog/collector-claude-code' only (ADR-0001).
export { DEFAULT_ENDPOINT, main, type Io } from './cli.ts';
export {
  ATTENTION_NOTIFICATIONS,
  COLLECTOR_VERSION,
  HOOK_EVENTS,
  mapHook,
  opaqueRef,
} from './mapping.ts';
export { FLUSH_BACKLOG, FLUSH_DEBOUNCE_MS, FLUSH_INTERVAL_MS, runFlush, runHook } from './run.ts';
export { HOOK_MARKER, hookEntry, installHooks, settingsPath, uninstallHooks } from './settings.ts';
export {
  createState,
  javiHome,
  SESSION_TTL_MS,
  type CollectorState,
  type GeminiSettingsBefore,
  type GeminiUsageConfig,
  type ReceiverInfo,
  type UsageConfig,
} from './state.ts';
export {
  DEFAULT_PLATFORM,
  PLATFORMS,
  PLATFORM_NAMES,
  isPlatform,
  platformFlag,
  type Platform,
} from './platform.ts';
export {
  GEMINI_HOOK_TIMEOUT_MS,
  geminiHome,
  geminiHookCommand,
  geminiHookEntry,
  geminiHooksInstalled,
  geminiProjectSettingsPath,
  geminiUserSettingsPath,
  installGeminiHooks,
  uninstallGeminiHooks,
  type InstallGeminiResult,
} from './gemini-settings.ts';
export {
  GEMINI_TELEMETRY_ENV_KEYS,
  disableGeminiTelemetry,
  enableGeminiTelemetry,
  geminiTelemetryBlock,
  type DisableGeminiResult,
  type EnableGeminiResult,
} from './gemini-telemetry.ts';
export {
  createUsageReceiver,
  ensureReceiver,
  isPidAlive,
  liveReceiver,
  portConflictActive,
  probeReceiver,
  RECEIVER_PID_HEADER,
  RECEIVER_PORT_CONFLICT_BACKOFF_MS,
  MAX_BODY_BYTES,
  RECEIVER_IDLE_MS,
  type UsageReceiver,
  type UsageReceiverOptions,
} from './receiver.ts';
export {
  COST_METRIC,
  TOKEN_METRIC,
  parseOtlpMetrics,
  type ParseResult,
  type UsageCounter,
  type UsagePoint,
} from './otlp.ts';
export {
  toUsageGroups,
  toUsageRecord,
  usageEventId,
  usageThreadRef,
  type CumulativeBaselines,
  type UsageGroup,
  type UsagePlatform,
} from './usage.ts';
export {
  DEFAULT_USAGE_PORT,
  USAGE_ENV_KEYS,
  claudeUserSettingsPath,
  disableUsageEnv,
  enableUsageEnv,
  usageEnv,
  type DisableResult,
  type EnableResult,
} from './claude-env.ts';
