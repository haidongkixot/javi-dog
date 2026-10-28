import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { JGR_LIMITS, validateBatch } from '@javis-dog/jgr-spec';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPS,
  DEFAULT_PLAN,
  NEAR_LIMIT_TARGET_BYTES,
  NEAR_LIMIT_TOLERANCE_BYTES,
  assertValidBatch,
  buildNearLimitBatch,
  buildTypicalBatch,
  clampPlan,
  createBuildContext,
  createCapGuard,
  createIdFactory,
  exitCodeFor,
  latencyStats,
  percentile,
  runLoadTest,
} from '../scripts/load-test-lib.ts';
import { createIngestHandler } from '../src/index.ts';

// S5a R6 (TEST_PLAN §S5a): the bounded load script, unit-tested and run against a local
// node:http server only. Nothing here reaches a non-localhost endpoint.

const TOKEN = `jd_it_${'Zq9'.repeat(14)}x`;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SCRIPT = fileURLToPath(new URL('../scripts/load-test.ts', import.meta.url));

/** Virtual clock: sleeps resolve in order by advancing virtual time, never waiting for real. */
const fakeClock = (start = Date.parse('2026-10-28T12:00:00Z')) => {
  let t = start;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const flush = () => {
    if (!timers.length) return;
    timers.sort((a, b) => a.at - b.at);
    t = Math.max(t, timers[0]!.at);
    while (timers.length && timers[0]!.at <= t) timers.shift()!.resolve();
  };
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: t + ms, resolve });
        setImmediate(flush);
      }),
  };
};

type Received = { auth: string; encoding: string; events: Array<{ event_id: string }>; at: number };
type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

let server: Server;
let url: string;
let received: Received[] = [];
let reply: (n: number, events: unknown[]) => Reply = (_n, events) => ({
  status: 202,
  body: { accepted: events.length, duplicates: 0, rejected: [] },
});
let clockForServer: { now: () => number; advance: (ms: number) => void } | null = null;
const accept202 = reply;

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const encoding = String(req.headers['content-encoding'] ?? 'identity');
    const text = (encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
    const events = (JSON.parse(text) as { events: Array<{ event_id: string }> }).events;
    const at = clockForServer?.now() ?? Date.now();
    received.push({ auth: String(req.headers.authorization ?? ''), encoding, events, at });
    const r = reply(received.length, events);
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
    res.end(JSON.stringify(r.body ?? { error: 'x' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`;
});
afterEach(() => {
  received = [];
  reply = accept202;
  clockForServer = null;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('percentile (nearest rank)', () => {
  it('matches the nearest-rank definition on known samples', () => {
    const s = [15, 20, 35, 40, 50];
    expect(percentile(s, 30)).toBe(20);
    expect(percentile(s, 40)).toBe(20);
    expect(percentile(s, 50)).toBe(35);
    expect(percentile(s, 95)).toBe(50);
    expect(percentile(s, 100)).toBe(50);
    expect(percentile(s, 0)).toBe(15);
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i); // unsorted on purpose
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(hundred[0]).toBe(100); // input not mutated
    expect(() => percentile(s, 101)).toThrow(RangeError);
  });

  it('summarises count, p50, p95 and max', () => {
    expect(latencyStats([300, 100, 200, 1_000])).toEqual({
      count: 4,
      p50: 200,
      p95: 1_000,
      max: 1_000,
    });
    expect(latencyStats([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});

describe('caps', () => {
  it('are the ADR-0015 §6 budget and frozen', () => {
    expect(CAPS).toMatchObject({
      maxRequests: 70,
      maxEvents: 6_000,
      maxWallMs: 120_000,
      maxConcurrency: 5,
    });
    expect(CAPS.maxStartsPerMinute).toBeLessThan(60);
    expect(Object.isFrozen(CAPS)).toBe(true);
    expect(() => {
      (CAPS as { maxRequests: number }).maxRequests = 1_000;
    }).toThrow(TypeError);
  });

  it('the default plan fits without clamping: 50 × 100 + 5 near-limit', () => {
    const { plan, clamped } = clampPlan();
    expect(plan).toEqual(DEFAULT_PLAN);
    expect(clamped).toEqual([]);
    expect(plan.typicalBatches + plan.nearLimitBatches).toBeLessThanOrEqual(CAPS.maxRequests);
  });

  it('a plan asking for more is clamped down, never up', () => {
    const { plan, clamped, capsHit } = clampPlan({
      typicalBatches: 1_000,
      eventsPerTypicalBatch: 1_000,
      nearLimitBatches: 500,
      concurrency: 50,
    });
    expect(plan.concurrency).toBe(5);
    expect(plan.eventsPerTypicalBatch).toBe(100);
    const requests = plan.typicalBatches + plan.nearLimitBatches;
    const events = plan.typicalBatches * plan.eventsPerTypicalBatch + plan.nearLimitBatches * 100;
    expect(requests).toBeLessThanOrEqual(CAPS.maxRequests);
    expect(events).toBeLessThanOrEqual(CAPS.maxEvents);
    expect(clamped).toEqual(
      expect.arrayContaining(['concurrency', 'eventsPerTypicalBatch', 'nearLimitBatches']),
    );
    expect(capsHit.events).toBe(true);
    expect(clampPlan({ typicalBatches: 69, nearLimitBatches: 5 }).capsHit.requests).toBe(true);
    expect(clampPlan({ concurrency: -3, typicalBatches: Number.NaN }).plan).toMatchObject({
      concurrency: 1,
      typicalBatches: 0,
    });
  });

  it('the per-request guard refuses past 70 requests or 6 000 events', () => {
    const g = createCapGuard();
    for (let i = 0; i < 60; i++) expect(g.take(100)).toBe(true);
    expect(g.take(1)).toBe(false);
    expect(g.refused).toBe('event_cap');
    const r = createCapGuard();
    for (let i = 0; i < 70; i++) expect(r.take(1)).toBe(true);
    expect(r.take(1)).toBe(false);
    expect(r.refused).toBe('request_cap');
    expect(r.requests).toBe(70);
  });
});

describe('payload builders', () => {
  it('event ids are ULIDs, unique within a run', () => {
    const next = createIdFactory();
    const ids = Array.from({ length: 10_000 }, next);
    expect(ids.every((id) => ULID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('typical batches are small, valid L0 and use the stable producer id', () => {
    const ctx = createBuildContext('load-test');
    const batch = buildTypicalBatch(ctx, 0, 100);
    expect(batch.events).toHaveLength(100);
    expect(batch.rawBytes).toBeLessThan(64 * 1024);
    expect(batch.gzipBytes).toBeLessThan(batch.rawBytes);
    expect(gunzipSync(batch.gzip).toString('utf8')).toBe(batch.json);
    expect(() => assertValidBatch(batch)).not.toThrow();
    const types = new Set(batch.events.map((e) => e.type));
    expect([...types].sort()).toEqual(
      ['agent.started', 'heartbeat', 'task.completed', 'task.started'].sort(),
    );
    expect(new Set(batch.events.map((e) => e.producer_id))).toEqual(new Set(['prod_load-test']));
    // Sequences keep counting per thread across batches.
    const second = buildTypicalBatch(ctx, 1, 100);
    const thread = String(second.events[0]!.thread_ref);
    const seqs = [...batch.events, ...second.events]
      .filter((e) => e.thread_ref === thread)
      .map((e) => Number(e.sequence));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('near-limit batches sit just under 256 KiB uncompressed, ≤ 256 KiB gzip, all valid', () => {
    const ctx = createBuildContext('load-test');
    for (let i = 0; i < 2; i++) {
      const batch = buildNearLimitBatch(ctx, i);
      expect(batch.events).toHaveLength(JGR_LIMITS.maxBatchEvents);
      expect(batch.rawBytes).toBeLessThanOrEqual(NEAR_LIMIT_TARGET_BYTES);
      expect(batch.rawBytes).toBeGreaterThan(NEAR_LIMIT_TARGET_BYTES - NEAR_LIMIT_TOLERANCE_BYTES);
      expect(batch.rawBytes).toBeLessThanOrEqual(JGR_LIMITS.maxBatchBytes);
      expect(batch.gzipBytes).toBeLessThanOrEqual(JGR_LIMITS.maxBatchBytes);
      // High-entropy filler keeps gzip large (the server limit is on decompressed bytes).
      expect(batch.gzipBytes).toBeGreaterThan(0.6 * batch.rawBytes);
      const result = validateBatch(JSON.parse(batch.json));
      expect(result.ok && result.accepted.length).toBe(100);
      expect(result.ok && result.rejected).toEqual([]);
      for (const e of batch.events) {
        expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(JGR_LIMITS.maxEventBytes);
        // Numeric L0 attributes stay numbers.
        expect(typeof (e.attributes as Record<string, unknown>).duration_ms).toBe('number');
      }
    }
    // The receiver applies 256 KiB after decompression: the builder refuses targets above it.
    expect(() => buildNearLimitBatch(ctx, 9, JGR_LIMITS.maxBatchBytes + 1)).toThrow(RangeError);
  });

  it('the real ingest handler accepts a gzip near-limit batch (202, not 413)', async () => {
    const batch = buildNearLimitBatch(createBuildContext('load-test'), 0);
    let stored = 0;
    const handler = createIngestHandler({
      verifyToken: async (raw) =>
        raw === TOKEN
          ? {
              tokenId: 't1',
              projectId: 'p1',
              workspaceId: 'w1',
              projectSlug: 'load-test',
              privacyClass: 'L0',
            }
          : null,
      hitRateWindow: async () => ({ count: 1, resetAt: new Date(Date.now() + 60_000) }),
      insertEvents: async (rows) => (stored += rows.length),
      touchSignal: async () => {},
      markTokenUsed: async () => {},
    });
    const res = await handler(
      new Request('http://localhost/api/v1/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          authorization: `Bearer ${TOKEN}`,
        },
        body: new Uint8Array(batch.gzip),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 100, duplicates: 0, rejected: [] });
    expect(stored).toBe(100);
  });
});

describe('runLoadTest against a local server', () => {
  it('default plan: 55 × 202, every event accepted once, paced under 60/min, exit 0', async () => {
    const clock = fakeClock();
    clockForServer = clock;
    const summary = await runLoadTest({ url, token: TOKEN, now: clock.now, sleep: clock.sleep });
    expect(summary.pass).toBe(true);
    expect(exitCodeFor(summary)).toBe(0);
    expect(summary.requests).toEqual({ planned: 55, sent: 55, byStatus: { '202': 55 } });
    expect(summary.events).toMatchObject({ planned: 5_500, sent: 5_500, accepted: 5_500 });
    expect(summary.stoppedEarly).toBeNull();
    expect(summary.capsHit).toEqual({ requests: false, events: false, wallTime: false });
    expect(summary.phases.typical.requests).toBe(50);
    expect(summary.phases.near_limit.requests).toBe(5);
    expect(summary.phases.near_limit.rawBytesMax).toBeLessThanOrEqual(JGR_LIMITS.maxBatchBytes);
    expect(summary.latencyMs.count).toBe(55);
    expect(summary.latencyMs.p95).not.toBeNull();
    expect(summary.maxStartsInAnyMinute).toBeLessThanOrEqual(CAPS.maxStartsPerMinute);

    expect(received).toHaveLength(55);
    expect(received.every((r) => r.auth === `Bearer ${TOKEN}` && r.encoding === 'gzip')).toBe(true);
    const ids = received.flatMap((r) => r.events.map((e) => e.event_id));
    expect(new Set(ids).size).toBe(5_500);
    // Server-side view of the pacing (virtual arrival times): never ≥ 60 in a rolling minute.
    const at = received.map((r) => r.at).sort((a, b) => a - b);
    for (let i = 0; i < at.length; i++) {
      expect(at.filter((t) => t >= at[i]! && t < at[i]! + 60_000).length).toBeLessThan(60);
    }
    expect(summary.wallMs).toBeLessThanOrEqual(CAPS.maxWallMs);
    expect(JSON.stringify(summary)).not.toContain(TOKEN.slice(6));
  });

  it('cannot exceed the caps even when the caller asks for more', async () => {
    const clock = fakeClock();
    clockForServer = clock;
    const summary = await runLoadTest({
      url,
      token: TOKEN,
      now: clock.now,
      sleep: clock.sleep,
      plan: { typicalBatches: 10_000, nearLimitBatches: 0, concurrency: 99 },
    });
    expect(received.length).toBeLessThanOrEqual(CAPS.maxRequests);
    expect(received.reduce((n, r) => n + r.events.length, 0)).toBeLessThanOrEqual(CAPS.maxEvents);
    expect(summary.plan.concurrency).toBe(CAPS.maxConcurrency);
    expect(summary.capsHit.events).toBe(true);
    expect(summary.clamped).toEqual(expect.arrayContaining(['typicalBatches', 'concurrency']));
    expect(summary.maxStartsInAnyMinute).toBeLessThanOrEqual(CAPS.maxStartsPerMinute);
    expect(summary.wallMs).toBeLessThanOrEqual(CAPS.maxWallMs);
  });

  it('records 202 / 429 / 5xx, honours Retry-After and stops after three 5xx in a row', async () => {
    const clock = fakeClock();
    clockForServer = clock;
    const script: Reply[] = [
      { status: 202 },
      { status: 429, headers: { 'retry-after': '7' }, body: { error: 'rate_limited' } },
      { status: 202 },
      { status: 503, body: { error: 'unavailable' } },
      { status: 502, body: {} },
      { status: 202 },
      { status: 500, body: {} },
      { status: 503, body: {} },
      { status: 504, body: {} },
    ];
    reply = (n, events) => {
      const r = script[n - 1] ?? { status: 202 };
      return r.status === 202
        ? { status: 202, body: { accepted: events.length - 1, duplicates: 1, rejected: [] } }
        : r;
    };
    const summary = await runLoadTest({
      url,
      token: TOKEN,
      now: clock.now,
      sleep: clock.sleep,
      plan: { typicalBatches: 20, eventsPerTypicalBatch: 10, nearLimitBatches: 0, concurrency: 1 },
    });
    expect(summary.stoppedEarly).toBe('server_errors');
    expect(summary.requests.sent).toBe(9);
    expect(summary.requests.byStatus).toEqual({
      '202': 3,
      '429': 1,
      '500': 1,
      '502': 1,
      '503': 2,
      '504': 1,
    });
    expect(summary.events).toMatchObject({ sent: 90, accepted: 27, duplicates: 3 });
    const limited = summary.records.find((r) => r.status === 429)!;
    expect(limited.retryAfterSeconds).toBe(7);
    const after = summary.records.find((r) => r.index === limited.index + 1)!;
    expect(after.startedAtMs - limited.startedAtMs).toBeGreaterThanOrEqual(7_000);
    expect(summary.pass).toBe(false);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('a run with duplicates or rejections is not a pass', async () => {
    reply = (_n, events) => ({
      status: 202,
      body: {
        accepted: events.length - 1,
        duplicates: 0,
        rejected: [{ index: 0, issues: [{ code: 'project_mismatch' }] }],
      },
    });
    const clock = fakeClock();
    const summary = await runLoadTest({
      url,
      token: TOKEN,
      now: clock.now,
      sleep: clock.sleep,
      plan: { typicalBatches: 2, eventsPerTypicalBatch: 5, nearLimitBatches: 0, concurrency: 1 },
    });
    expect(summary.requests.byStatus).toEqual({ '202': 2 });
    expect(summary.events).toMatchObject({ sent: 10, accepted: 8, rejected: 2 });
    expect(summary.rejectedCodes).toEqual({ project_mismatch: 2 });
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('stops on the first 401', async () => {
    reply = () => ({ status: 401, body: { error: 'unauthorized' } });
    const clock = fakeClock();
    const summary = await runLoadTest({ url, token: TOKEN, now: clock.now, sleep: clock.sleep });
    expect(summary.stoppedEarly).toBe('unauthorized');
    // Only what was already in flight (≤ concurrency) is sent.
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeLessThanOrEqual(CAPS.maxConcurrency);
    expect(summary.phases.near_limit.requests).toBe(0);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('stops at the wall-time cap', async () => {
    const clock = fakeClock();
    clockForServer = clock;
    reply = (_n, events) => {
      clock.advance(25_000); // every request "takes" 25 s of run time
      return { status: 202, body: { accepted: events.length, duplicates: 0, rejected: [] } };
    };
    const summary = await runLoadTest({
      url,
      token: TOKEN,
      now: clock.now,
      sleep: clock.sleep,
      plan: { concurrency: 1 },
    });
    expect(summary.stoppedEarly).toBe('wall_time');
    expect(summary.capsHit.wallTime).toBe(true);
    expect(received.length).toBe(5); // starts at 0, 25, 50, 75, 100 s; none at 125 s
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('counts transport failures toward the burst stop', async () => {
    const clock = fakeClock();
    const summary = await runLoadTest({
      url: 'http://127.0.0.1:1/api/v1/events',
      token: TOKEN,
      now: clock.now,
      sleep: clock.sleep,
      plan: { concurrency: 1 },
    });
    expect(summary.stoppedEarly).toBe('server_errors');
    expect(summary.requests.byStatus).toEqual({ no_response: 3 });
    expect(summary.records[0]!.error).toMatch(/^TypeError/);
    expect(JSON.stringify(summary)).not.toContain(TOKEN.slice(6));
  });

  it('runs on the real clock too (small plan)', async () => {
    const summary = await runLoadTest({
      url,
      token: TOKEN,
      projectRef: 'web-app',
      plan: { typicalBatches: 3, eventsPerTypicalBatch: 20, nearLimitBatches: 1, concurrency: 2 },
    });
    expect(summary.pass).toBe(true);
    expect(summary.projectRef).toBe('web-app');
    expect(
      received.flatMap((r) => r.events.map((e) => (e as { project_ref?: string }).project_ref)),
    ).toSatisfy((refs: unknown[]) => refs.every((r) => r === 'web-app'));
    expect(summary.wallMs).toBeLessThan(10_000);
  });
});

describe('load-test.ts (process)', () => {
  type Run = { code: number | null; stdout: string; stderr: string };
  const runScript = (env: NodeJS.ProcessEnv) =>
    new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: { PATH: process.env.PATH, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  it('never prints or writes the token, and stops on 401 with exit 1', async () => {
    reply = () => ({ status: 401, body: { error: 'unauthorized' } });
    const dir = await mkdtemp(join(tmpdir(), 'jd-load-'));
    try {
      const tokenFile = join(dir, 'token');
      const out = join(dir, 'summary.json');
      await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
      const result = await runScript({
        INGEST_URL: url,
        LOAD_TOKEN_FILE: tokenFile,
        LOAD_OUT: out,
        LOAD_PROJECT_REF: 'load-test',
      });
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toContain('FAIL load test');
      expect(result.stdout).toContain('Stopped early: unauthorized');
      const summary = await readFile(out, 'utf8');
      expect(JSON.parse(summary)).toMatchObject({ stoppedEarly: 'unauthorized', pass: false });
      for (const text of [result.stdout, result.stderr, summary]) {
        expect(text).not.toContain(TOKEN.slice(6));
      }
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received.length).toBeLessThanOrEqual(CAPS.maxConcurrency);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start without INGEST_URL, a token file or a valid token (exit 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jd-load-'));
    try {
      const bad = join(dir, 'bad-token');
      await writeFile(bad, 'not-a-token-but-a-secret-value');
      const noUrl = await runScript({ LOAD_TOKEN_FILE: bad });
      expect(noUrl.code).toBe(2);
      expect(noUrl.stderr).toContain('INGEST_URL is not set');
      const badToken = await runScript({ INGEST_URL: url, LOAD_TOKEN_FILE: bad });
      expect(badToken.code).toBe(2);
      expect(badToken.stderr).not.toContain('secret-value');
      const plainHttp = await runScript({
        INGEST_URL: 'http://example.com/api/v1/events',
        LOAD_TOKEN_FILE: bad,
      });
      expect(plainHttp.code).toBe(2);
      expect(received).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
