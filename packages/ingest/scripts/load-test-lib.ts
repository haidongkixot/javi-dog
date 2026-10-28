// Bounded ingest load test (S5a R6, ADR-0015 §6): pure helpers and the runner behind
// scripts/load-test.ts. Nothing here reads the environment, prints, or logs: the CLI owns I/O,
// so tests can drive the runner against a local server with an injected clock.
//
// Budget (ADR-0015 §6): ≤ 70 requests, ≤ 6 000 events, ≤ 120 s wall time, concurrency ≤ 5,
// under the receiver's 60 batches/min/token (ADR-0008). The caps live in CAPS below; no option,
// flag or env var can raise them — a caller's plan is clamped down, never up, and the runner
// re-checks every request against the same constants before it sends.
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { JGR_LIMITS, validateBatch } from '@javis-dog/jgr-spec';

export const CAPS = Object.freeze({
  maxRequests: 70,
  maxEvents: 6_000,
  maxWallMs: 120_000,
  maxConcurrency: 5,
  /** Request starts per rolling 60 s; below the receiver's 60/min so other traffic fits. */
  maxStartsPerMinute: 50,
  /** Stop after this many consecutive 5xx or transport failures. */
  maxConsecutiveFailures: 3,
});

/** Per-request client timeout; also never past the wall-time deadline. */
const REQUEST_TIMEOUT_MS = 30_000;
const MINUTE_MS = 60_000;

/** Near-limit payloads aim just under the receiver's 256 KiB (decompressed) limit. */
export const NEAR_LIMIT_TARGET_BYTES = JGR_LIMITS.maxBatchBytes - 1_024;
/** The builder lands within this many bytes below the target. */
export const NEAR_LIMIT_TOLERANCE_BYTES = 64;

export const PRODUCER_ID = 'prod_load-test';
export const DEFAULT_PROJECT_REF = 'load-test';
const COLLECTOR_VERSION = 'load-test-0.1.0';

export interface LoadPlan {
  /** Phase (a): batches of typical L0 events. */
  typicalBatches: number;
  eventsPerTypicalBatch: number;
  /** Phase (b): batches of 100 events whose JSON is just under 256 KiB. */
  nearLimitBatches: number;
  concurrency: number;
}

export const DEFAULT_PLAN: Readonly<LoadPlan> = Object.freeze({
  typicalBatches: 50,
  eventsPerTypicalBatch: 100,
  nearLimitBatches: 5,
  concurrency: 5,
});

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Clamps a requested plan to the caps. Values only ever go down; `clamped` names each value
 * that was reduced so the summary shows that the caller asked for more than the budget.
 */
export const clampPlan = (
  requested: Partial<LoadPlan> = {},
): { plan: LoadPlan; clamped: string[]; capsHit: { requests: boolean; events: boolean } } => {
  const clamped: string[] = [];
  const want = { ...DEFAULT_PLAN, ...requested };
  const concurrency = clampInt(want.concurrency, 1, CAPS.maxConcurrency, 1);
  const perBatch = clampInt(want.eventsPerTypicalBatch, 1, JGR_LIMITS.maxBatchEvents, 1);
  let nearLimit = clampInt(want.nearLimitBatches, 0, CAPS.maxRequests, 0);
  let typical = clampInt(want.typicalBatches, 0, CAPS.maxRequests, 0);
  const nearEvents = JGR_LIMITS.maxBatchEvents;

  if (concurrency < (want.concurrency ?? 0)) clamped.push('concurrency');
  if (perBatch < (want.eventsPerTypicalBatch ?? 0)) clamped.push('eventsPerTypicalBatch');

  // Near-limit batches first: they are the rarer, more informative probe.
  const nearByEvents = Math.floor(CAPS.maxEvents / nearEvents);
  const capsHit = {
    requests: nearLimit > CAPS.maxRequests,
    events: nearLimit > nearByEvents,
  };
  nearLimit = Math.min(nearLimit, CAPS.maxRequests, nearByEvents);
  const typicalByRequests = CAPS.maxRequests - nearLimit;
  const typicalByEvents = Math.floor((CAPS.maxEvents - nearLimit * nearEvents) / perBatch);
  if (typical > typicalByRequests) capsHit.requests = true;
  if (typical > typicalByEvents) capsHit.events = true;
  typical = Math.min(typical, typicalByRequests, typicalByEvents);
  if (nearLimit < (want.nearLimitBatches ?? 0)) clamped.push('nearLimitBatches');
  if (typical < (want.typicalBatches ?? 0)) clamped.push('typicalBatches');

  return {
    plan: {
      typicalBatches: typical,
      eventsPerTypicalBatch: perBatch,
      nearLimitBatches: nearLimit,
      concurrency,
    },
    clamped,
    capsHit,
  };
};

/**
 * Second line of defence: every request takes from this budget before it is sent, so even a
 * runner bug cannot send more than CAPS allows in one run.
 */
export const createCapGuard = () => {
  let requests = 0;
  let events = 0;
  let refused: 'request_cap' | 'event_cap' | null = null;
  return {
    take(batchEvents: number): boolean {
      if (requests + 1 > CAPS.maxRequests) {
        refused ??= 'request_cap';
        return false;
      }
      if (events + batchEvents > CAPS.maxEvents) {
        refused ??= 'event_cap';
        return false;
      }
      requests += 1;
      events += batchEvents;
      return true;
    },
    get requests() {
      return requests;
    },
    get events() {
      return events;
    },
    get refused() {
      return refused;
    },
  };
};

/**
 * Nearest-rank percentile: sort ascending, rank = ceil(p / 100 × N), value = sorted[rank − 1]
 * (rank 1 for p = 0). Always one of the samples, no interpolation. Empty input → null.
 */
export const percentile = (samples: readonly number[], p: number): number | null => {
  if (samples.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError('p must be within [0, 100].');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
};

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export const latencyStats = (samples: readonly number[]): LatencyStats => ({
  count: samples.length,
  p50: percentile(samples, 50),
  p95: percentile(samples, 95),
  max: samples.length ? Math.max(...samples) : null,
});

// --- Event ids and payloads ---

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULIDs unique within a run: 48-bit time + 48-bit per-run random nonce + 32-bit counter.
 * The counter guarantees uniqueness inside the run; the nonce separates runs.
 */
export const createIdFactory = (now: () => number = Date.now, nonce: Buffer = randomBytes(6)) => {
  const prefix = BigInt(`0x${nonce.toString('hex').padStart(12, '0')}`) << 32n;
  let counter = 0;
  return () => {
    const time = BigInt(Math.floor(now())) & 0xffffffffffffn;
    let value = (time << 80n) | (prefix | BigInt(counter++ >>> 0));
    let out = '';
    for (let i = 0; i < 26; i++) {
      out = CROCKFORD[Number(value & 31n)]! + out;
      value >>= 5n;
    }
    return out;
  };
};

export type JsonEvent = Record<string, unknown>;
export interface BuiltBatch {
  phase: Phase;
  events: JsonEvent[];
  /** The exact bytes sent before gzip (compact JSON). */
  json: string;
  rawBytes: number;
  gzip: Buffer;
  gzipBytes: number;
}
export type Phase = 'typical' | 'near_limit';

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

const finish = (phase: Phase, events: JsonEvent[]): BuiltBatch => {
  const json = JSON.stringify({ events });
  const gzip = gzipSync(json);
  return { phase, events, json, rawBytes: byteLength(json), gzip, gzipBytes: gzip.byteLength };
};

export interface BuildContext {
  projectRef: string;
  /** Short per-run id so thread refs of two runs never collide. */
  runId: string;
  nextId: () => string;
  now: () => number;
  /** Persisted per thread across batches (JGR sequence is per thread). */
  sequences: Map<string, number>;
  random: () => number;
}

export const createBuildContext = (
  projectRef: string,
  opts: { now?: () => number; random?: () => number; runId?: string } = {},
): BuildContext => {
  const now = opts.now ?? Date.now;
  return {
    projectRef,
    runId: opts.runId ?? randomBytes(4).toString('hex'),
    nextId: createIdFactory(now),
    now,
    sequences: new Map(),
    random: opts.random ?? Math.random,
  };
};

const nextSeq = (ctx: BuildContext, thread: string) => {
  const n = ctx.sequences.get(thread) ?? 0;
  ctx.sequences.set(thread, n + 1);
  return n;
};

const TOOLS = ['Bash', 'Edit', 'Read', 'Grep', 'Write', 'Glob'];

/**
 * A typical L0 batch: a few simulated sessions emitting heartbeats and tool start/complete
 * pairs with small operational attributes — the shape the Claude Code collector sends.
 */
export const buildTypicalBatch = (ctx: BuildContext, batchIndex: number, size: number) => {
  const events: JsonEvent[] = [];
  const occurred = new Date(ctx.now()).toISOString();
  for (let i = 0; i < size; i++) {
    const thread = `lt_${ctx.runId}_t${(batchIndex * 7 + i) % 8}`;
    const tool = TOOLS[(batchIndex + i) % TOOLS.length]!;
    const base = {
      jgr: '0.1',
      event_id: ctx.nextId(),
      producer_id: PRODUCER_ID,
      project_ref: ctx.projectRef,
      thread_ref: thread,
      sequence: nextSeq(ctx, thread),
      occurred_at: occurred,
    };
    const attrs = { platform: 'claude-code', collector_version: COLLECTOR_VERSION };
    switch (i % 5) {
      case 0:
        events.push({ ...base, type: 'heartbeat', status: 'working', attributes: attrs });
        break;
      case 1:
        events.push({ ...base, type: 'task.started', attributes: { ...attrs, tool_name: tool } });
        break;
      case 2:
        events.push({
          ...base,
          type: 'task.completed',
          attributes: {
            ...attrs,
            tool_name: tool,
            duration_ms: 20 + Math.floor(ctx.random() * 4_000),
            exit_code: 0,
          },
        });
        break;
      case 3:
        events.push({
          ...base,
          agent_ref: `lt_${ctx.runId}_a${i % 3}`,
          type: 'agent.started',
          status: 'working',
          attributes: { ...attrs, model: 'claude-sonnet-4-5' },
        });
        break;
      default:
        events.push({
          ...base,
          type: 'heartbeat',
          status: 'idle',
          attributes: { ...attrs, context_used_ratio: Math.round(ctx.random() * 100) / 100 },
        });
    }
  }
  return finish('typical', events);
};

// Two-byte UTF-8 code points U+0100–U+07FF (without the combining marks U+0300–U+036F): ~10.7
// bits of entropy per 2 bytes, so gzip keeps ~80 % of the size, while each attribute stays within
// its 128-character limit. JSON.stringify never escapes them, so byte counts are exact.
const TWO_BYTE_FIRST = 0x0100;
const COMBINING_FIRST = 0x0300;
const COMBINING_SPAN = 0x70;
const TWO_BYTE_SPAN = 0x0800 - TWO_BYTE_FIRST - COMBINING_SPAN;
// Ref characters allowed by the JGR REF pattern.
const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

const twoByteFiller = (len: number) => {
  const bytes = randomBytes(len * 2);
  let s = '';
  for (let i = 0; i < len; i++) {
    let cp = TWO_BYTE_FIRST + (bytes.readUInt16BE(i * 2) % TWO_BYTE_SPAN);
    if (cp >= COMBINING_FIRST) cp += COMBINING_SPAN;
    s += String.fromCharCode(cp);
  }
  return s;
};
// Three-byte code points (CJK U+4E00–U+9FFF) for one attribute: more bytes per character, so
// 100 events can reach the limit; ~15 bits per 3 bytes, gzip keeps ~72 %.
const THREE_BYTE_FIRST = 0x4e00;
const THREE_BYTE_SPAN = 0xa000 - THREE_BYTE_FIRST;
const threeByteFiller = (len: number) => {
  const bytes = randomBytes(len * 2);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(THREE_BYTE_FIRST + (bytes.readUInt16BE(i * 2) % THREE_BYTE_SPAN));
  }
  return s;
};
const refFiller = (len: number) => {
  let s = '';
  for (const b of randomBytes(len)) s += REF_ALPHABET[b % REF_ALPHABET.length]!;
  return s;
};

/** L0 attributes whose meaning is text; numeric ones stay numbers so readers never cast junk. */
const TEXT_ATTRIBUTES = [
  'platform_version',
  'collector_version',
  'provider',
  'model',
  'tool_name',
  'task_kind',
  'error_code',
] as const;
const MAX_TEXT = JGR_LIMITS.maxAttributeStringLength;
const MAX_REF = JGR_LIMITS.maxRefLength;

/**
 * One near-limit batch: 100 valid L0 `task.completed` events whose compact JSON is within
 * NEAR_LIMIT_TOLERANCE_BYTES below `targetBytes` (default 255 KiB). The receiver's 256 KiB
 * limit applies AFTER decompression (ADR-0008), so the uncompressed size is what is pushed to
 * the edge; text attributes and agent refs carry random filler so gzip stays as large as valid
 * envelopes allow. Throws if the target cannot be reached with valid events.
 */
export const buildNearLimitBatch = (
  ctx: BuildContext,
  batchIndex: number,
  targetBytes: number = NEAR_LIMIT_TARGET_BYTES,
) => {
  if (targetBytes > JGR_LIMITS.maxBatchBytes) {
    throw new RangeError(`targetBytes must be ≤ ${JGR_LIMITS.maxBatchBytes}.`);
  }
  const occurred = new Date(ctx.now()).toISOString();
  const thread = `lt_${ctx.runId}_n${batchIndex}_${refFiller(MAX_REF - 20)}`.slice(0, MAX_REF);
  const events: JsonEvent[] = [];
  for (let i = 0; i < JGR_LIMITS.maxBatchEvents; i++) {
    const attributes: Record<string, string | number> = { platform: 'claude-code' };
    for (const key of TEXT_ATTRIBUTES) {
      attributes[key] = key === 'error_code' ? threeByteFiller(MAX_TEXT) : twoByteFiller(MAX_TEXT);
    }
    Object.assign(attributes, {
      duration_ms: 20 + Math.floor(ctx.random() * 4_000),
      exit_code: 0,
      retry_count: 0,
      attempt: 1,
      context_used_ratio: Math.round(ctx.random() * 100) / 100,
      budget_remaining_ratio: Math.round(ctx.random() * 100) / 100,
    });
    events.push({
      jgr: '0.1',
      event_id: ctx.nextId(),
      producer_id: PRODUCER_ID,
      project_ref: ctx.projectRef,
      thread_ref: thread,
      agent_ref: refFiller(MAX_REF),
      sequence: nextSeq(ctx, thread),
      type: 'task.completed',
      occurred_at: occurred,
      attributes,
    });
  }

  // Trim filler from the end until the batch fits (a slot's characters all have one UTF-8 width).
  let size = byteLength(JSON.stringify({ events }));
  if (size < targetBytes - NEAR_LIMIT_TOLERANCE_BYTES) {
    throw new Error(`Near-limit batch reaches only ${size} bytes (target ${targetBytes}).`);
  }
  for (let e = events.length - 1; e >= 0 && size > targetBytes; e--) {
    const attrs = events[e]!.attributes as Record<string, string | number>;
    for (let k = TEXT_ATTRIBUTES.length - 1; k >= 0 && size > targetBytes; k--) {
      const key = TEXT_ATTRIBUTES[k]!;
      const value = attrs[key] as string;
      const width = byteLength(value[0]!);
      const cut = Math.min(value.length - 1, Math.ceil((size - targetBytes) / width));
      attrs[key] = value.slice(0, value.length - cut);
      size -= cut * width;
    }
  }
  const batch = finish('near_limit', events);
  if (batch.rawBytes > targetBytes) {
    throw new Error(`Near-limit batch is ${batch.rawBytes} bytes, above ${targetBytes}.`);
  }
  return batch;
};

/** Refuses to send anything unless every generated event is valid JGR v0.1 with no issue. */
export const assertValidBatch = (batch: BuiltBatch, now: Date = new Date()) => {
  const result = validateBatch(JSON.parse(batch.json), now);
  if (!result.ok) {
    throw new Error(`Generated batch is invalid: ${result.issues.map((i) => i.code).join(', ')}`);
  }
  if (result.rejected.length) {
    const codes = [...new Set(result.rejected.flatMap((r) => r.issues.map((i) => i.code)))];
    throw new Error(`Generated batch has invalid events: ${codes.join(', ')}`);
  }
  for (const e of batch.events) {
    if (byteLength(JSON.stringify(e)) > JGR_LIMITS.maxEventBytes) {
      throw new Error('Generated event exceeds the per-event byte limit.');
    }
  }
};

// --- Runner ---

export interface RequestRecord {
  phase: Phase;
  index: number;
  /** HTTP status, or 0 when no response arrived (network error, timeout). */
  status: number;
  /** Error class only (e.g. "TypeError:ECONNREFUSED"); never a message or header. */
  error?: string;
  /** Client-side, request start to full response body, in ms (performance.now). */
  latencyMs: number;
  /** Start time relative to the run start, from the run clock. */
  startedAtMs: number;
  events: number;
  rawBytes: number;
  gzipBytes: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  rejectedCodes?: Record<string, number>;
  retryAfterSeconds?: number;
}

export type StopReason =
  'unauthorized' | 'server_errors' | 'wall_time' | 'request_cap' | 'event_cap';

export interface PhaseSummary {
  requests: number;
  events: number;
  accepted: number;
  latencyMs: LatencyStats;
  rawBytesMax: number;
  gzipBytesMax: number;
  rawBytesTotal: number;
  gzipBytesTotal: number;
}

export interface LoadSummary {
  tool: 'javis-dog-load-test';
  /** Endpoint without credentials, query or fragment. */
  endpoint: string;
  projectRef: string;
  producerId: string;
  startedAt: string;
  wallMs: number;
  caps: typeof CAPS;
  plan: LoadPlan;
  /** Plan values reduced to fit the caps (the caller asked for more). */
  clamped: string[];
  capsHit: { requests: boolean; events: boolean; wallTime: boolean };
  stoppedEarly: StopReason | null;
  requests: { planned: number; sent: number; byStatus: Record<string, number> };
  events: { planned: number; sent: number; accepted: number; duplicates: number; rejected: number };
  rejectedCodes: Record<string, number>;
  /** Over every request that got an HTTP response (status ≠ 0); nearest-rank percentiles. */
  latencyMs: LatencyStats;
  phases: Record<Phase, PhaseSummary>;
  /** Nearest-limit payload actually built (bytes). */
  nearLimit: { targetRawBytes: number; maxRawBytes: number; maxGzipBytes: number } | null;
  /** Rolling-minute pacing: the most request starts seen in any 60 s window. */
  maxStartsInAnyMinute: number;
  pass: boolean;
  records: RequestRecord[];
}

export interface RunOptions {
  url: string;
  token: string;
  projectRef?: string;
  plan?: Partial<LoadPlan>;
  fetch?: typeof fetch;
  /** Run clock for pacing and the wall-time cap (ms). Latency always uses performance.now. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Origin + path only: never credentials, query strings or fragments in the summary. */
export const safeEndpoint = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

const errorClass = (e: unknown) => {
  const err = e as { name?: unknown; cause?: { code?: unknown } };
  const name = typeof err?.name === 'string' ? err.name : typeof e;
  const code = typeof err?.cause?.code === 'string' ? `:${err.cause.code}` : '';
  return `${name}${code}`;
};

const maxStartsInWindow = (starts: number[]) => {
  const sorted = [...starts].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi]! - sorted[lo]! >= MINUTE_MS) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
};

const summarisePhase = (records: RequestRecord[]): PhaseSummary => ({
  requests: records.length,
  events: records.reduce((n, r) => n + r.events, 0),
  accepted: records.reduce((n, r) => n + r.accepted, 0),
  latencyMs: latencyStats(records.filter((r) => r.status !== 0).map((r) => r.latencyMs)),
  rawBytesMax: Math.max(0, ...records.map((r) => r.rawBytes)),
  gzipBytesMax: Math.max(0, ...records.map((r) => r.gzipBytes)),
  rawBytesTotal: records.reduce((n, r) => n + r.rawBytes, 0),
  gzipBytesTotal: records.reduce((n, r) => n + r.gzipBytes, 0),
});

/**
 * Runs phase (a) then phase (b) against `url`. Stops early on any 401 or on
 * CAPS.maxConsecutiveFailures consecutive 5xx/transport failures; a 429 pauses new starts for
 * its Retry-After (the batch is not retried). Never logs; the token is only ever placed in the
 * Authorization header.
 */
export const runLoadTest = async (opts: RunOptions): Promise<LoadSummary> => {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = opts.fetch ?? fetch;
  const projectRef = opts.projectRef ?? DEFAULT_PROJECT_REF;
  const { plan, clamped, capsHit: planCapsHit } = clampPlan(opts.plan);
  const endpoint = safeEndpoint(opts.url);

  // Build and validate everything before the first request: an invalid generator sends nothing.
  const ctx = createBuildContext(projectRef, { now });
  const typical = Array.from({ length: plan.typicalBatches }, (_, i) =>
    buildTypicalBatch(ctx, i, plan.eventsPerTypicalBatch),
  );
  const nearLimit = Array.from({ length: plan.nearLimitBatches }, (_, i) =>
    buildNearLimitBatch(ctx, i),
  );
  const validateAt = new Date(now());
  for (const b of [...typical, ...nearLimit]) assertValidBatch(b, validateAt);

  const startedAt = now();
  const deadline = startedAt + CAPS.maxWallMs;
  const guard = createCapGuard();
  const records: RequestRecord[] = [];
  /** Starts inside the current rolling minute (pruned) and every start (for the summary). */
  const starts: number[] = [];
  const allStarts: number[] = [];
  let stop: StopReason | null = null;
  let wallHit = false;
  let failureStreak = 0;
  let pauseUntil = 0;

  /** Waits for a start slot under the rolling-minute pace; false when the deadline passes. */
  const acquireSlot = async (): Promise<boolean> => {
    for (;;) {
      if (stop) return false;
      const t = now();
      if (t >= deadline) {
        wallHit = true;
        return false;
      }
      while (starts.length && t - starts[0]! >= MINUTE_MS) starts.shift();
      let wait = 0;
      if (pauseUntil > t) wait = pauseUntil - t;
      else if (starts.length >= CAPS.maxStartsPerMinute) wait = starts[0]! + MINUTE_MS - t;
      if (wait <= 0) {
        starts.push(t);
        allStarts.push(t);
        return true;
      }
      if (t + wait >= deadline) {
        wallHit = true;
        return false;
      }
      await sleep(wait);
    }
  };

  const send = async (batch: BuiltBatch, index: number): Promise<RequestRecord> => {
    const startedAtMs = now() - startedAt;
    const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));
    const record: RequestRecord = {
      phase: batch.phase,
      index,
      status: 0,
      latencyMs: 0,
      startedAtMs,
      events: batch.events.length,
      rawBytes: batch.rawBytes,
      gzipBytes: batch.gzipBytes,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
    };
    const t0 = performance.now();
    try {
      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          authorization: `Bearer ${opts.token}`,
        },
        body: new Uint8Array(batch.gzip),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      record.latencyMs = Math.round((performance.now() - t0) * 10) / 10;
      record.status = res.status;
      if (res.status === 202) {
        const body = JSON.parse(text) as {
          accepted?: unknown;
          duplicates?: unknown;
          rejected?: Array<{ issues?: Array<{ code?: unknown }> }>;
        };
        record.accepted = typeof body.accepted === 'number' ? body.accepted : 0;
        record.duplicates = typeof body.duplicates === 'number' ? body.duplicates : 0;
        const rejected = Array.isArray(body.rejected) ? body.rejected : [];
        record.rejected = rejected.length;
        if (rejected.length) {
          const codes: Record<string, number> = {};
          for (const r of rejected) {
            for (const i of r.issues ?? []) {
              const code = typeof i.code === 'string' ? i.code : 'unknown';
              codes[code] = (codes[code] ?? 0) + 1;
            }
          }
          record.rejectedCodes = codes;
        }
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0) {
        record.retryAfterSeconds = retryAfter;
      }
    } catch (e) {
      record.latencyMs = Math.round((performance.now() - t0) * 10) / 10;
      record.error = errorClass(e);
      if (now() >= deadline) wallHit = true;
    }
    return record;
  };

  const onResult = (record: RequestRecord) => {
    records.push(record);
    if (record.status === 401) stop ??= 'unauthorized';
    if (record.status === 429) {
      pauseUntil = Math.max(pauseUntil, now() + (record.retryAfterSeconds ?? 1) * 1_000);
    }
    if (record.status >= 500 || record.status === 0) failureStreak++;
    else failureStreak = 0;
    if (wallHit) stop ??= 'wall_time';
    if (failureStreak >= CAPS.maxConsecutiveFailures) stop ??= 'server_errors';
  };

  const runPhase = async (batches: BuiltBatch[]) => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (stop) return;
        const index = next++;
        const batch = batches[index];
        if (!batch) return;
        // Budget first: a refused batch never takes a pacing slot.
        if (!guard.take(batch.events.length)) {
          stop ??= guard.refused ?? 'request_cap';
          return;
        }
        if (!(await acquireSlot())) {
          if (wallHit) stop ??= 'wall_time';
          return;
        }
        onResult(await send(batch, index));
      }
    };
    await Promise.all(Array.from({ length: plan.concurrency }, worker));
  };

  await runPhase(typical);
  if (!stop) await runPhase(nearLimit);

  const wallMs = now() - startedAt;
  const byStatus: Record<string, number> = {};
  const rejectedCodes: Record<string, number> = {};
  for (const r of records) {
    const key = r.status === 0 ? 'no_response' : String(r.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    for (const [code, n] of Object.entries(r.rejectedCodes ?? {})) {
      rejectedCodes[code] = (rejectedCodes[code] ?? 0) + n;
    }
  }
  const plannedRequests = plan.typicalBatches + plan.nearLimitBatches;
  const plannedEvents =
    plan.typicalBatches * plan.eventsPerTypicalBatch +
    plan.nearLimitBatches * JGR_LIMITS.maxBatchEvents;
  const sum = (f: (r: RequestRecord) => number) => records.reduce((n, r) => n + f(r), 0);
  const events = {
    planned: plannedEvents,
    sent: sum((r) => r.events),
    accepted: sum((r) => r.accepted),
    duplicates: sum((r) => r.duplicates),
    rejected: sum((r) => r.rejected),
  };
  const pass =
    stop === null &&
    records.length === plannedRequests &&
    records.every((r) => r.status === 202) &&
    events.accepted === events.sent;

  return {
    tool: 'javis-dog-load-test',
    endpoint,
    projectRef,
    producerId: PRODUCER_ID,
    startedAt: new Date(startedAt).toISOString(),
    wallMs,
    caps: CAPS,
    plan,
    clamped,
    capsHit: {
      requests: planCapsHit.requests || guard.refused === 'request_cap',
      events: planCapsHit.events || guard.refused === 'event_cap',
      wallTime: wallHit,
    },
    stoppedEarly: stop,
    requests: { planned: plannedRequests, sent: records.length, byStatus },
    events,
    rejectedCodes,
    latencyMs: latencyStats(records.filter((r) => r.status !== 0).map((r) => r.latencyMs)),
    phases: {
      typical: summarisePhase(records.filter((r) => r.phase === 'typical')),
      near_limit: summarisePhase(records.filter((r) => r.phase === 'near_limit')),
    },
    nearLimit: nearLimit.length
      ? {
          targetRawBytes: NEAR_LIMIT_TARGET_BYTES,
          maxRawBytes: Math.max(...nearLimit.map((b) => b.rawBytes)),
          maxGzipBytes: Math.max(...nearLimit.map((b) => b.gzipBytes)),
        }
      : null,
    maxStartsInAnyMinute: maxStartsInWindow(allStarts),
    pass,
    records: records.sort((a, b) =>
      a.phase === b.phase ? a.index - b.index : a.phase === 'typical' ? -1 : 1,
    ),
  };
};

/** 0 only when every planned request got 202 and every sent event was accepted. */
export const exitCodeFor = (summary: LoadSummary) => (summary.pass ? 0 : 1);
