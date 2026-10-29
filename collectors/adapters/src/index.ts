// JD-C02 public contract (ADR-0016).
export {
  GEMINI_HOOK_EVENTS,
  GEMINI_PLATFORM,
  GEMINI_THREAD_PREFIX,
  GEMINI_TOKEN_METRIC,
  geminiThreadRef,
  geminiUsageDelta,
  mapGeminiHook,
  parseGeminiMetrics,
} from './gemini.ts';
export type {
  AdapterContext,
  AdapterParseResult,
  AdapterUsageCounter,
  AdapterUsagePoint,
  GeminiHookEvent,
  UsageCounters,
} from './gemini.ts';
export { GEMINI_PRICES, estimateGeminiCostUsd, findGeminiPrice } from './prices.ts';
export type { ModelPrice, PriceTable } from './prices.ts';
