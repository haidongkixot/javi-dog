import { gzipSync } from 'node:zlib';
import {
  JGR_LIMITS,
  JGR_VERSION,
  validateEvent,
  type Issue,
  type JgrEvent,
  type JgrEventInput,
} from '@javis-dog/jgr-spec';
import { createMemorySpool, type Spool } from './spool.ts';
import { createUlid } from './ulid.ts';

/** What a producer supplies; the SDK fills `jgr`, `event_id`, `producer_id`, time and sequence. */
export type RecordInput = Omit<
  JgrEventInput,
  'jgr' | 'event_id' | 'producer_id' | 'occurred_at' | 'sequence'
> & { occurred_at?: string; sequence?: number };

export type RecordResult =
  { ok: true; event: JgrEvent; evicted: number } | { ok: false; issues: Issue[] };

export interface RejectedEvent {
  index: number;
  event_id?: string;
  issues: Issue[];
}

export interface FlushResult {
  /** `ok`: spool drained · `unauthorized`: 401/403, spool kept · `retry_later`: transient
   *  failures exhausted, spool kept · `failed`: unexpected status (e.g. 404), spool kept. */
  status: 'ok' | 'unauthorized' | 'retry_later' | 'failed';
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Events removed without delivery: malformed batch (400) or a single event over 413. */
  dropped: number;
  remaining: number;
  httpStatus?: number;
}

export interface JgrClientOptions {
  /** Full URL of the receiver, e.g. https://javisdog.vercel.app/api/v1/events */
  endpoint: string;
  /** Project ingest token. Sent as a bearer header only; never spooled or logged. */
  token: string;
  producerId: string;
  spool?: Spool;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1) — injectable for deterministic jitter in tests. */
  random?: () => number;
  now?: () => Date;
  /** Attempts per batch within one flush (JGR §8 retry rules). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  gzipThresholdBytes?: number;
  /** Per-request timeout; a timed-out request counts as a retryable network error. */
  requestTimeoutMs?: number;
  onRejected?: (rejected: RejectedEvent[]) => void;
}

const MAX_BATCHES_PER_FLUSH = 1_000;

type SendOutcome =
  | { kind: 'accepted'; accepted: number; duplicates: number; rejected: RejectedEvent[] }
  | { kind: 'too_large' | 'malformed' | 'unauthorized' | 'failed'; httpStatus: number }
  | { kind: 'retry_later'; httpStatus?: number };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Seconds or an HTTP date → milliseconds from now, or null. */
const parseRetryAfter = (value: string | null, now: Date): number | null => {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
};

export const createJgrClient = (options: JgrClientOptions) => {
  const {
    endpoint,
    token,
    producerId,
    spool = createMemorySpool(),
    fetch: doFetch = globalThis.fetch,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = () => new Date(),
    maxAttempts = 5,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    gzipThresholdBytes = 1_024,
    requestTimeoutMs = 10_000,
    onRejected,
  } = options;
  const ulid = createUlid();
  const sequences = new Map<string, number>();

  /** Full jitter (base 1 s, cap 60 s), or the server's Retry-After within the cap. */
  const backoff = (attempt: number, retryAfterMs: number | null) =>
    retryAfterMs !== null
      ? Math.min(retryAfterMs, maxDelayMs)
      : Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));

  const send = async (batch: JgrEvent[]): Promise<SendOutcome> => {
    const json = JSON.stringify({ events: batch });
    const gzip = byteLength(json) > gzipThresholdBytes;
    const body = gzip ? new Uint8Array(gzipSync(json)) : json;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    };
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let retryAfterMs: number | null = null;
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        lastStatus = res.status;
        if (res.status === 202) {
          const parsed = (await res.json()) as {
            accepted?: number;
            duplicates?: number;
            rejected?: RejectedEvent[];
          };
          return {
            kind: 'accepted',
            accepted: parsed.accepted ?? 0,
            duplicates: parsed.duplicates ?? 0,
            rejected: parsed.rejected ?? [],
          };
        }
        if (res.status === 400) return { kind: 'malformed', httpStatus: 400 };
        if (res.status === 401 || res.status === 403) {
          return { kind: 'unauthorized', httpStatus: res.status };
        }
        if (res.status === 413) return { kind: 'too_large', httpStatus: 413 };
        if (res.status !== 429 && res.status < 500) {
          return { kind: 'failed', httpStatus: res.status };
        }
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
      } catch {
        // Network error: retryable. The error itself is dropped (it may echo request data).
        lastStatus = undefined;
      }
      if (attempt < maxAttempts - 1) await sleep(backoff(attempt, retryAfterMs));
    }
    return { kind: 'retry_later', ...(lastStatus !== undefined && { httpStatus: lastStatus }) };
  };

  /** Largest prefix of `events` whose batch body fits the byte limit (at least one event). */
  const fitBytes = (events: JgrEvent[]) => {
    const batch = [...events];
    while (
      batch.length > 1 &&
      byteLength(JSON.stringify({ events: batch })) > JGR_LIMITS.maxBatchBytes
    ) {
      batch.pop();
    }
    return batch;
  };

  return {
    /** Builds, validates and spools one event. Invalid input is returned, never spooled. */
    async record(input: RecordInput): Promise<RecordResult> {
      const at = now();
      const sequence = input.sequence ?? (sequences.get(input.thread_ref) ?? -1) + 1;
      const candidate = {
        ...input,
        jgr: JGR_VERSION,
        event_id: ulid(at.getTime()),
        producer_id: producerId,
        occurred_at: input.occurred_at ?? at.toISOString(),
        sequence,
      };
      const result = validateEvent(candidate, at);
      if (!result.ok) return { ok: false, issues: result.issues };
      sequences.set(input.thread_ref, Math.max(sequence, sequences.get(input.thread_ref) ?? -1));
      const { evicted } = await spool.append([result.event]);
      return { ok: true, event: result.event, evicted };
    },

    /** Delivers the spool in batches (JGR §8). Safe to call from several processes. */
    async flush(): Promise<FlushResult> {
      const totals = { accepted: 0, duplicates: 0, rejected: 0, dropped: 0 };
      let limit: number = JGR_LIMITS.maxBatchEvents;
      const finish = async (
        status: FlushResult['status'],
        httpStatus?: number,
      ): Promise<FlushResult> => ({
        status,
        ...totals,
        remaining: await spool.count(),
        ...(httpStatus !== undefined && { httpStatus }),
      });

      for (let round = 0; round < MAX_BATCHES_PER_FLUSH; round++) {
        const pending = await spool.peek(limit);
        if (pending.length === 0) return finish('ok');
        const batch = fitBytes(pending);
        const ids = batch.map((e) => e.event_id);
        const outcome = await send(batch);

        switch (outcome.kind) {
          case 'accepted':
            await spool.remove(ids);
            totals.accepted += outcome.accepted;
            totals.duplicates += outcome.duplicates;
            totals.rejected += outcome.rejected.length;
            if (outcome.rejected.length) onRejected?.(outcome.rejected);
            break;
          case 'too_large':
            // Resending a smaller batch is a changed request; a lone event can never fit.
            if (batch.length > 1) {
              limit = Math.max(1, Math.floor(batch.length / 2));
            } else {
              await spool.remove(ids);
              totals.dropped += 1;
            }
            break;
          case 'malformed':
            await spool.remove(ids);
            totals.dropped += ids.length;
            break;
          case 'unauthorized':
            return finish('unauthorized', outcome.httpStatus);
          case 'failed':
            return finish('failed', outcome.httpStatus);
          case 'retry_later':
            return finish('retry_later', outcome.httpStatus);
        }
      }
      return finish('retry_later');
    },

    spool,
  };
};

export type JgrClient = ReturnType<typeof createJgrClient>;
