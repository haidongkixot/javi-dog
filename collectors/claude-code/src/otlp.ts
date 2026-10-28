// OTLP/HTTP JSON metrics → usage points (ADR-0011). Allowlist parser: from Claude Code's
// metrics only `claude_code.token.usage` and `claude_code.cost.usage` Sum points are read, and
// from their attributes only `session.id`, `model` and `type`. Identity and resource attributes
// (user.email, user.id, user.account_uuid, organization.id, terminal.type, …) are never copied.

export const TOKEN_METRIC = 'claude_code.token.usage';
export const COST_METRIC = 'claude_code.cost.usage';

export type UsageCounter =
  'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'cost_usd';

export interface UsagePoint {
  /** Raw Claude Code session id — hashed before it leaves memory (`opaqueRef`). */
  sessionId: string;
  model: string;
  counter: UsageCounter;
  /** Non-negative; integer for token counters. */
  value: number;
  /** `startTimeUnixNano` / `timeUnixNano` as decimal strings. */
  startNs: string;
  endNs: string;
  temporality: 'delta' | 'cumulative';
}

export type ParseResult =
  { ok: true; points: UsagePoint[]; ignored: number } | { ok: false; error: string };

/**
 * Parses an `ExportMetricsServiceRequest` (OTLP JSON encoding). `ignored` counts data points
 * skipped (other metrics, unknown `type`, missing session id or model, negative or non-finite
 * values). `ok: false` only when the body is not an OTLP metrics request at all.
 */
export const parseOtlpMetrics = (body: unknown): ParseResult => {
  void body;
  throw new Error('not implemented (S3e U1)');
};
