import { createHmac } from 'node:crypto';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { estimateGeminiCostUsd } from './prices.ts';

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

/** The only Notification type that means "the thread waits for a human" (hooks reference). */
const GEMINI_ATTENTION_NOTIFICATION = 'ToolPermission';

export interface AdapterContext {
  projectRef: string;
  /** Per-installation salt for keyed hashes (never sent). */
  salt: string;
  collectorVersion: string;
}

/**
 * Keyed hash with the per-installation salt → opaque ref matching JGR's REF pattern. Same
 * scheme as JD-C01's `opaqueRef` (HMAC-SHA-256, first 32 hex chars), kept local so JD-C02 does
 * not import JD-C01.
 */
const opaqueRef = (prefix: string, value: string, salt: string) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

/** `thread_ref` for a Gemini session id: `opaqueRef('gm', sessionId, salt)`. */
export const geminiThreadRef = (sessionId: string, salt: string) =>
  opaqueRef(GEMINI_THREAD_PREFIX, sessionId, salt);

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/** JGR attribute string limit (`JGR_LIMITS.maxAttributeStringLength`). */
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * The JGR record for one Gemini hook invocation, or `null` when it carries no signal we keep
 * (unknown event, missing `session_id`, a Notification other than `ToolPermission`).
 *
 * Only `session_id`, `hook_event_name`, `tool_name` (tool events) and `notification_type`
 * (Notification) are read. Statuses match JD-C01's Claude Code equivalents: SessionStart
 * `working`, SessionEnd `completed`, tool events without a status. `occurred_at` is left to
 * the SDK, as in JD-C01 (the hook `timestamp` is not read).
 */
export const mapGeminiHook = (raw: unknown, ctx: AdapterContext): RecordInput | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hook = raw as Record<string, unknown>;
  const sessionId = str(hook.session_id);
  const event = str(hook.hook_event_name);
  if (!sessionId || !event) return null;

  const attributes: Record<string, string | number> = {
    platform: GEMINI_PLATFORM,
    collector_version: ctx.collectorVersion,
  };
  const base = {
    project_ref: ctx.projectRef,
    thread_ref: geminiThreadRef(sessionId, ctx.salt),
    attributes,
  };
  const withTool = () => {
    const name = str(hook.tool_name)?.slice(0, MAX_TOOL_NAME_LENGTH);
    return { ...attributes, ...(name && { tool_name: name }) };
  };

  switch (event) {
    case 'SessionStart':
      return { ...base, type: 'session.started', status: 'working' };
    case 'SessionEnd':
      return { ...base, type: 'session.ended', status: 'completed' };
    case 'BeforeAgent':
      // `prompt` is never read.
      return { ...base, type: 'heartbeat', status: 'working' };
    case 'AfterAgent':
      // `prompt` and `prompt_response` are never read.
      return { ...base, type: 'heartbeat', status: 'idle' };
    case 'BeforeTool':
      return { ...base, type: 'task.started', attributes: withTool() };
    case 'AfterTool':
      // Failure is only visible inside `tool_response` (content), so AfterTool is always
      // `task.completed` (ADR-0016 §2, known gap).
      return { ...base, type: 'task.completed', attributes: withTool() };
    case 'Notification':
      // `message` and `details` are never read.
      return hook.notification_type === GEMINI_ATTENTION_NOTIFICATION
        ? { ...base, type: 'attention.requested', status: 'waiting' }
        : null;
    default:
      // BeforeModel, AfterModel, BeforeToolSelection, PreCompress and unknown events.
      return null;
  }
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

/** `gemini_cli.token.usage` attribute `type` → JGR counter (spec §12). `tool` is not mapped. */
const GEMINI_TOKEN_TYPES: Readonly<Record<string, AdapterUsageCounter>> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache: 'cache_read_tokens',
  thought: 'reasoning_tokens',
};

/** OTLP `AggregationTemporality` (JSON encodes enums as integers). */
const TEMPORALITY: Readonly<Record<number, AdapterUsagePoint['temporality']>> = {
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

/** A uint64 (`fixed64`) as a decimal string or a JSON number → bigint, or null. */
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

/** One `gemini_cli.token.usage` Sum data point → usage point, or null when it is not usable. */
const toPoint = (
  point: unknown,
  temporality: AdapterUsagePoint['temporality'],
  resourceSessionId: string | undefined,
): AdapterUsagePoint | null => {
  if (!isObj(point)) return null;
  const picked = pickAttributes(point.attributes);
  const { model, type } = picked;
  // Gemini puts `session.id` on every data point and on the resource (V-src metrics.ts, sdk.ts);
  // the point wins, the resource is the fallback. `model` and `type` have no fallback.
  const sessionId = picked.sessionId ?? resourceSessionId;
  if (!sessionId || !model || model.length > MAX_MODEL_LENGTH) return null;

  const counter =
    type !== undefined && Object.hasOwn(GEMINI_TOKEN_TYPES, type)
      ? GEMINI_TOKEN_TYPES[type]
      : undefined;
  if (!counter) return null;

  const start = uint64(point.startTimeUnixNano);
  const end = uint64(point.timeUnixNano);
  // Zero is the proto default, i.e. "not set".
  if (start === null || end === null || start === 0n || end === 0n || start > end) return null;

  const value = pointValue(point);
  if (value === null || value < 0 || !Number.isSafeInteger(value)) return null;

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
 * Allowlist parser for an OTLP/HTTP JSON metrics body: only `gemini_cli.token.usage` Sum points;
 * only `session.id` (data point, else resource), `model` and `type` attributes. `type` mapping:
 * input → input_tokens (still including cached tokens; see `geminiUsageDelta`), output →
 * output_tokens, cache → cache_read_tokens, thought → reasoning_tokens; `tool` and unknown
 * types are ignored (counted in `ignored`).
 *
 * `ignored` also counts points of other metrics, of a non-Sum `gemini_cli.token.usage`, of an
 * unknown temporality, and points with a missing session id or model, bad times, or a negative,
 * non-integer or non-finite value. `ok: false` only when the body is not a JSON object or
 * `resourceMetrics` is not an array; an absent or null `resourceMetrics` is an empty request.
 */
export const parseGeminiMetrics = (body: unknown): AdapterParseResult => {
  // An absent `resourceMetrics` is an empty request (proto3 default; unknown fields ignored).
  const resourceMetricsList = isObj(body) ? (body.resourceMetrics ?? []) : null;
  if (!Array.isArray(resourceMetricsList)) {
    return { ok: false, error: 'Expected an OTLP ExportMetricsServiceRequest (resourceMetrics).' };
  }
  const points: AdapterUsagePoint[] = [];
  let ignored = 0;

  for (const resourceMetrics of resourceMetricsList) {
    if (!isObj(resourceMetrics)) continue;
    const resource = isObj(resourceMetrics.resource) ? resourceMetrics.resource : {};
    const resourceSessionId = pickAttributes(resource.attributes).sessionId;
    for (const scopeMetrics of list(resourceMetrics.scopeMetrics)) {
      if (!isObj(scopeMetrics)) continue;
      for (const metric of list(scopeMetrics.metrics)) {
        if (!isObj(metric)) continue;
        if (metric.name !== GEMINI_TOKEN_METRIC || !isObj(metric.sum)) {
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
          const point = toPoint(dataPoint, temporality, resourceSessionId);
          if (point) points.push(point);
          else ignored += 1;
        }
      }
    }
  }
  return { ok: true, points, ignored };
};

export type UsageCounters = Partial<Record<Exclude<AdapterUsageCounter, 'cost_usd'>, number>>;

/**
 * Final `usage_delta` counters for one (session, model, interval) group of Gemini deltas:
 * `input_tokens` = input − cache_read (clamped at 0), because Gemini's prompt count includes
 * cached tokens; cost estimated from `GEMINI_PRICES` at `at` (`estimated: true`), or no
 * `cost_usd` and `estimated: false` for a model without a price.
 *
 * - Only the four Gemini counters are carried (`input_tokens`, `output_tokens`,
 *   `cache_read_tokens`, `reasoning_tokens`); any other key (e.g. `cache_write_tokens`, which
 *   Gemini never reports) is not copied.
 * - An absent counter stays absent; `input_tokens` is only set when the group has an input
 *   delta (a cache delta alone does not create one).
 * - Zero counters are kept, as computed (e.g. input fully served from cache → 0). Dropping
 *   empty groups is the caller's job, as in JD-C01 (`toUsageGroups` drops groups with no
 *   counter > 0); a group with any raw counter > 0 still has one after this rule, because the
 *   clamp only lowers `input_tokens` when `cache_read_tokens` > 0.
 */
export const geminiUsageDelta = (
  delta: UsageCounters,
  model: string,
  at: Date,
): UsageCounters & { cost_usd?: number; estimated: boolean } => {
  const counters: UsageCounters = {};
  const cache = delta.cache_read_tokens;
  if (delta.input_tokens !== undefined) {
    counters.input_tokens = Math.max(0, delta.input_tokens - (cache ?? 0));
  }
  if (delta.output_tokens !== undefined) counters.output_tokens = delta.output_tokens;
  if (cache !== undefined) counters.cache_read_tokens = cache;
  if (delta.reasoning_tokens !== undefined) counters.reasoning_tokens = delta.reasoning_tokens;

  const cost = estimateGeminiCostUsd(model, counters, at);
  return cost === null
    ? { ...counters, estimated: false }
    : { ...counters, cost_usd: cost, estimated: true };
};
