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

/** `claude_code.token.usage` attribute `type` → JGR counter (spec §12). */
const TOKEN_TYPES: Readonly<Record<string, UsageCounter>> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_tokens',
  cacheCreation: 'cache_write_tokens',
};

/** OTLP `AggregationTemporality` (JSON encodes enums as integers). */
const TEMPORALITY: Readonly<Record<number, UsagePoint['temporality']>> = {
  1: 'delta',
  2: 'cumulative',
};

/** JGR `usage_delta.model` limit (jgr-spec UsageDelta); longer names are not truncated. */
const MAX_MODEL_LENGTH = 64;
const MAX_UINT64 = (1n << 64n) - 1n;
const DATA_KINDS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'] as const;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Reads only the allowlisted string attributes; every other key is skipped unread. */
const pickAttributes = (attributes: unknown) => {
  const picked: { sessionId?: string; model?: string; type?: string } = {};
  for (const attr of list(attributes)) {
    if (!isObj(attr) || !isObj(attr.value)) continue;
    const text = attr.value.stringValue;
    if (typeof text !== 'string' || text.length === 0) continue;
    if (attr.key === 'session.id') picked.sessionId ??= text;
    else if (attr.key === 'model') picked.model ??= text;
    else if (attr.key === 'type') picked.type ??= text;
  }
  return picked;
};

/** A uint64 (`fixed64`) as a decimal string or a JSON number → canonical decimal, or null. */
const uint64 = (value: unknown): bigint | null => {
  let n: bigint;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) n = BigInt(value);
  else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) n = BigInt(value);
  else return null;
  return n <= MAX_UINT64 ? n : null;
};

const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** `asInt` (int64: string or number) or `asDouble` (number, or numeric string) → number. */
const pointValue = (point: Obj): number | null => {
  if (point.asInt !== undefined) {
    const raw = point.asInt;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
    if (typeof raw !== 'string' || !/^-?\d{1,20}$/.test(raw)) return null;
    const n = BigInt(raw);
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(n)
      : null;
  }
  const raw = point.asDouble;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && DECIMAL.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** One allowlisted Sum data point → usage point, or null when it is not usable. */
const toPoint = (
  metricName: string,
  point: unknown,
  temporality: UsagePoint['temporality'],
  resourceSessionId: string | undefined,
): UsagePoint | null => {
  if (!isObj(point)) return null;
  const picked = pickAttributes(point.attributes);
  const { model, type } = picked;
  // The docs do not say whether standard attributes sit on the data point or the resource
  // block, so `session.id` falls back to the resource (S3e merge; `model`/`type` do not).
  const sessionId = picked.sessionId ?? resourceSessionId;
  if (!sessionId || !model || model.length > MAX_MODEL_LENGTH) return null;

  const counter: UsageCounter | undefined =
    metricName === COST_METRIC
      ? 'cost_usd'
      : type !== undefined && Object.hasOwn(TOKEN_TYPES, type)
        ? TOKEN_TYPES[type]
        : undefined;
  if (!counter) return null;

  const start = uint64(point.startTimeUnixNano);
  const end = uint64(point.timeUnixNano);
  // Zero is the proto default, i.e. "not set".
  if (start === null || end === null || start === 0n || end === 0n || start > end) return null;

  const value = pointValue(point);
  if (value === null || value < 0) return null;
  if (counter !== 'cost_usd' && !Number.isSafeInteger(value)) return null;

  return {
    sessionId,
    model,
    counter,
    value,
    startNs: start.toString(),
    endNs: end.toString(),
    temporality,
  };
};

/** Data points under any metric data field — counted as ignored for unread metrics. */
const countDataPoints = (metric: Obj) =>
  DATA_KINDS.reduce(
    (n, kind) => n + (isObj(metric[kind]) ? list((metric[kind] as Obj).dataPoints).length : 0),
    0,
  );

/**
 * Parses an `ExportMetricsServiceRequest` (OTLP JSON encoding). `ignored` counts data points
 * skipped (other metrics, unknown `type`, missing session id or model, negative or non-finite
 * values). `ok: false` only when the body is not an OTLP metrics request at all.
 */
export const parseOtlpMetrics = (body: unknown): ParseResult => {
  if (!isObj(body) || !Array.isArray(body.resourceMetrics)) {
    return { ok: false, error: 'Expected an OTLP ExportMetricsServiceRequest (resourceMetrics).' };
  }
  const points: UsagePoint[] = [];
  let ignored = 0;

  for (const resourceMetrics of body.resourceMetrics) {
    if (!isObj(resourceMetrics)) continue;
    const resource = isObj(resourceMetrics.resource) ? resourceMetrics.resource : {};
    const resourceSessionId = pickAttributes(resource.attributes).sessionId;
    for (const scopeMetrics of list(resourceMetrics.scopeMetrics)) {
      if (!isObj(scopeMetrics)) continue;
      for (const metric of list(scopeMetrics.metrics)) {
        if (!isObj(metric)) continue;
        const name = metric.name;
        if ((name !== TOKEN_METRIC && name !== COST_METRIC) || !isObj(metric.sum)) {
          ignored += countDataPoints(metric);
          continue;
        }
        const dataPoints = list(metric.sum.dataPoints);
        const raw = metric.sum.aggregationTemporality;
        const temporality = typeof raw === 'number' ? TEMPORALITY[raw] : undefined;
        if (!temporality) {
          ignored += dataPoints.length;
          continue;
        }
        for (const dataPoint of dataPoints) {
          const point = toPoint(name, dataPoint, temporality, resourceSessionId);
          if (point) points.push(point);
          else ignored += 1;
        }
      }
    }
  }
  return { ok: true, points, ignored };
};
