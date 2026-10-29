import type { RecordInput } from '@javis-dog/jgr-sdk';

// Gemini CLI → JGR (ADR-0016). Pure functions: hook payloads and OTLP/HTTP JSON metrics in,
// operational metadata out. Prompts, responses, tool inputs/outputs, paths and identity
// attributes (user.email, installation.id) are never read into the output.

export const GEMINI_PLATFORM = 'gemini-cli';

/** Hook events `javi init --platform gemini-cli` registers (docs/hooks/reference.md). */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
] as const;
export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];

/** Opaque-ref prefix for Gemini session ids (`opaqueRef('gm', session_id, salt)`). */
export const GEMINI_THREAD_PREFIX = 'gm';

export interface AdapterContext {
  projectRef: string;
  /** Per-installation salt for keyed hashes (never sent). */
  salt: string;
  collectorVersion: string;
}

/**
 * The JGR record for one Gemini hook invocation, or `null` when it carries no signal we keep
 * (unknown event, missing `session_id`, a Notification other than `ToolPermission`).
 */
export const mapGeminiHook = (_raw: unknown, _ctx: AdapterContext): RecordInput | null => {
  void [_raw, _ctx];
  throw new Error('not implemented (S5b lane A)');
};

export const GEMINI_TOKEN_METRIC = 'gemini_cli.token.usage';

export type AdapterUsageCounter =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens'
  | 'reasoning_tokens'
  | 'cost_usd';

/** Same shape as JD-C01's `UsagePoint`, plus `reasoning_tokens`. */
export interface AdapterUsagePoint {
  /** Raw Gemini session id — hashed before it leaves memory. */
  sessionId: string;
  model: string;
  counter: AdapterUsageCounter;
  value: number;
  startNs: string;
  endNs: string;
  temporality: 'delta' | 'cumulative';
}

export type AdapterParseResult =
  { ok: true; points: AdapterUsagePoint[]; ignored: number } | { ok: false; error: string };

/**
 * Allowlist parser for an OTLP/HTTP JSON metrics body: only `gemini_cli.token.usage` Sum points;
 * only `session.id` (data point, else resource), `model` and `type` attributes. `type` mapping:
 * input → input_tokens (still including cached tokens; see `geminiUsageDelta`), output →
 * output_tokens, cache → cache_read_tokens, thought → reasoning_tokens; `tool` and unknown
 * types are ignored (counted in `ignored`).
 */
export const parseGeminiMetrics = (_body: unknown): AdapterParseResult => {
  void _body;
  throw new Error('not implemented (S5b lane A)');
};

export type UsageCounters = Partial<Record<Exclude<AdapterUsageCounter, 'cost_usd'>, number>>;

/**
 * Final `usage_delta` counters for one (session, model, interval) group of Gemini deltas:
 * `input_tokens` = input − cache_read (clamped at 0), because Gemini's prompt count includes
 * cached tokens; cost estimated from `GEMINI_PRICES` at `at` (`estimated: true`), or no
 * `cost_usd` and `estimated: false` for a model without a price.
 */
export const geminiUsageDelta = (
  _delta: UsageCounters,
  _model: string,
  _at: Date,
): UsageCounters & { cost_usd?: number; estimated: boolean } => {
  void [_delta, _model, _at];
  throw new Error('not implemented (S5b lane A)');
};
