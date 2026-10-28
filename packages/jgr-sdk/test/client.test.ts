import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileSpool,
  createJgrClient,
  type JgrClientOptions,
  type RecordInput,
} from '../src/index.ts';

const TOKEN = `jd_it_${'S'.repeat(43)}`;
const NOW = new Date('2026-10-23T10:00:00Z');

type Call = { body: { events: Array<Record<string, unknown>> }; headers: Record<string, string> };

/** Fake receiver: answers each call with the next scripted response (default 202 all accepted). */
const fakeFetch = (script: Array<Response | Error | ((c: Call) => Response)> = []) => {
  const calls: Call[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    const raw = init!.body as string | Uint8Array;
    const text =
      headers['content-encoding'] === 'gzip'
        ? gunzipSync(raw as Uint8Array).toString('utf8')
        : (raw as string);
    const call = { body: JSON.parse(text), headers };
    calls.push(call);
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(call);
    return (
      next ??
      Response.json(
        { accepted: call.body.events.length, duplicates: 0, rejected: [] },
        { status: 202 },
      )
    );
  });
  return { fn, calls };
};

const client = (overrides: Partial<JgrClientOptions> = {}) => {
  const sleeps: number[] = [];
  const c = createJgrClient({
    endpoint: 'https://javisdog.test/api/v1/events',
    token: TOKEN,
    producerId: 'prod_claude-code_7f3a',
    now: () => NOW,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { c, sleeps };
};

const input = (extra: Partial<RecordInput> = {}): RecordInput => ({
  project_ref: 'web-app',
  thread_ref: 'sess_1',
  type: 'heartbeat',
  status: 'working',
  ...extra,
});

describe('record', () => {
  it('fills envelope fields, validates and spools', async () => {
    const { c } = client({ fetch: fakeFetch().fn });
    const r = await c.record(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({
      jgr: '0.1',
      producer_id: 'prod_claude-code_7f3a',
      occurred_at: NOW.toISOString(),
      sequence: 0,
      privacy_class: 'L0',
    });
    expect(r.event.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await c.spool.count()).toBe(1);
  });

  it('counts sequence per thread and honours an explicit sequence', async () => {
    const { c } = client({ fetch: fakeFetch().fn });
    const seq = async (extra: Partial<RecordInput>) => {
      const r = await c.record(input(extra));
      return r.ok ? r.event.sequence : null;
    };
    expect([await seq({}), await seq({}), await seq({ thread_ref: 'sess_2' })]).toEqual([0, 1, 0]);
    expect(await seq({ sequence: 10 })).toBe(10);
    expect(await seq({})).toBe(11);
  });

  it('keeps a caller-supplied event_id in canonical form and refuses an invalid one', async () => {
    const { c } = client({ fetch: fakeFetch().fn });
    const id = '0F8FAD5B-D9CB-869F-A165-70867728950E';
    const r = await c.record(input({ event_id: id }));
    expect(r.ok && r.event.event_id).toBe(id.toLowerCase());
    expect(await c.record(input({ event_id: 'usage-1' }))).toMatchObject({ ok: false });
    expect(await c.spool.count()).toBe(1);
  });

  it('returns issues and spools nothing for invalid input (e.g. a prompt attribute)', async () => {
    const { c } = client({ fetch: fakeFetch().fn });
    const r = await c.record(input({ attributes: { prompt: 'secret plan' } }));
    expect(r).toMatchObject({ ok: false, issues: [{ code: 'privacy_forbidden_attribute' }] });
    expect(await c.record(input({ status: undefined }))).toMatchObject({ ok: false });
    expect(await c.spool.count()).toBe(0);
  });
});

describe('flush', () => {
  it('drains the spool in batches of at most 100 and sends the bearer token', async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn });
    for (let i = 0; i < 230; i++) await c.record(input());
    const r = await c.flush();
    expect(r).toMatchObject({ status: 'ok', accepted: 230, remaining: 0 });
    expect(f.calls.map((call) => call.body.events.length)).toEqual([100, 100, 30]);
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const seqs = f.calls.flatMap((call) => call.body.events.map((e) => e.sequence));
    expect(seqs).toEqual([...seqs].sort((a, b) => Number(a) - Number(b)));
  });

  it('gzips bodies above the threshold and sends small ones plain', async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn, gzipThresholdBytes: 1_024 });
    await c.record(input());
    await c.flush();
    for (let i = 0; i < 20; i++) await c.record(input());
    await c.flush();
    expect(f.calls.map((call) => call.headers['content-encoding'])).toEqual([undefined, 'gzip']);
  });

  it('keeps batches under 256 KB even with fewer than 100 events', async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn });
    // ~3.9 KB per event (16 attributes of 128 chars would be rejected; use allowed keys).
    const big = Object.fromEntries(
      [
        'platform',
        'platform_version',
        'collector_version',
        'provider',
        'model',
        'tool_name',
        'task_kind',
        'error_code',
      ].map((k) => [k, 'x'.repeat(128)]),
    );
    for (let i = 0; i < 100; i++) await c.record(input({ attributes: big }));
    await c.flush();
    for (const call of f.calls) {
      expect(new TextEncoder().encode(JSON.stringify(call.body)).length).toBeLessThanOrEqual(
        256 * 1024,
      );
    }
    expect(f.calls.reduce((n, call) => n + call.body.events.length, 0)).toBe(100);
  });

  it('retries 429/5xx/network errors with full jitter and Retry-After, then succeeds', async () => {
    const f = fakeFetch([
      new Response(null, { status: 503 }),
      new TypeError('fetch failed'),
      new Response(null, { status: 429, headers: { 'retry-after': '7' } }),
    ]);
    const { c, sleeps } = client({ fetch: f.fn, random: () => 0.5 });
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'ok', accepted: 1, remaining: 0 });
    // attempt 0: 0.5 × 1 s; attempt 1: 0.5 × 2 s; attempt 2: Retry-After 7 s.
    expect(sleeps).toEqual([500, 1_000, 7_000]);
  });

  it('caps the delay at 60 s and keeps the spool after the last attempt', async () => {
    const f = fakeFetch(Array.from({ length: 5 }, () => new Response(null, { status: 500 })));
    const { c, sleeps } = client({ fetch: f.fn, random: () => 0.999, baseDelayMs: 20_000 });
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'retry_later', remaining: 1, httpStatus: 500 });
    expect(f.fn).toHaveBeenCalledTimes(5);
    expect(Math.max(...sleeps)).toBeLessThan(60_000);
    expect(sleeps).toHaveLength(4);
  });

  it('stops on 401/403 without retrying and keeps every event', async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch([new Response(null, { status })]);
      const { c, sleeps } = client({ fetch: f.fn });
      await c.record(input());
      expect(await c.flush()).toMatchObject({
        status: 'unauthorized',
        remaining: 1,
        httpStatus: status,
      });
      expect(f.fn).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('halves the batch on 413 and drops a single event that still does not fit', async () => {
    const f = fakeFetch([new Response(null, { status: 413 }), new Response(null, { status: 413 })]);
    const { c } = client({ fetch: f.fn });
    for (let i = 0; i < 4; i++) await c.record(input());
    const r = await c.flush();
    // 4 → 413 → 2 → 413 → 1 per batch for the rest of this flush.
    expect(f.calls.map((call) => call.body.events.length)).toEqual([4, 2, 1, 1, 1, 1]);
    expect(r).toMatchObject({ status: 'ok', accepted: 4, dropped: 0 });

    const lone = fakeFetch([new Response(null, { status: 413 })]);
    const { c: c2 } = client({ fetch: lone.fn });
    await c2.record(input());
    expect(await c2.flush()).toMatchObject({ status: 'ok', dropped: 1, remaining: 0 });
  });

  it('drops a 400 batch without retrying and reports it', async () => {
    const f = fakeFetch([new Response(null, { status: 400 })]);
    const { c, sleeps } = client({ fetch: f.fn });
    await c.record(input());
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'ok', dropped: 2, remaining: 0 });
    expect(sleeps).toEqual([]);
  });

  it('removes partially rejected batches and reports the rejections', async () => {
    const rejected = [
      {
        index: 1,
        event_id: 'x',
        issues: [{ code: 'project_mismatch', path: 'project_ref', message: 'm' }],
      },
    ];
    const f = fakeFetch([Response.json({ accepted: 1, duplicates: 0, rejected }, { status: 202 })]);
    const onRejected = vi.fn();
    const { c } = client({ fetch: f.fn, onRejected });
    await c.record(input());
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'ok', accepted: 1, rejected: 1, remaining: 0 });
    expect(onRejected).toHaveBeenCalledWith(rejected);
  });

  it('times out a hung request and treats it as retryable', async () => {
    const hung = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        }),
    );
    const { c } = client({ fetch: hung, requestTimeoutMs: 20, maxAttempts: 2 });
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'retry_later', remaining: 1 });
    expect(hung).toHaveBeenCalledTimes(2);
  });

  it('keeps every event on 415 (media type or encoding refused) and drops nothing', async () => {
    const f = fakeFetch([
      Response.json({ error: 'unsupported_media_type', message: 'm' }, { status: 415 }),
    ]);
    const { c, sleeps } = client({ fetch: f.fn });
    for (let i = 0; i < 3; i++) await c.record(input());
    const before = (await c.spool.peek(10)).map((e) => e.event_id);
    expect(await c.flush()).toEqual({
      status: 'failed',
      httpStatus: 415,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      dropped: 0,
      remaining: 3,
    });
    expect((await c.spool.peek(10)).map((e) => e.event_id)).toEqual(before);
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    // Once the path is fixed, the next flush delivers the same events.
    expect(await c.flush()).toMatchObject({ status: 'ok', accepted: 3, remaining: 0 });
  });

  it('stops on unexpected statuses (e.g. 404) and keeps the spool', async () => {
    const f = fakeFetch([new Response(null, { status: 404 })]);
    const { c } = client({ fetch: f.fn });
    await c.record(input());
    expect(await c.flush()).toMatchObject({ status: 'failed', httpStatus: 404, remaining: 1 });
  });

  it('never writes the token to the file spool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jgr-sdk-'));
    try {
      const f = fakeFetch([new Response(null, { status: 503 })]);
      const { c } = client({ fetch: f.fn, spool: createFileSpool(dir), maxAttempts: 1 });
      await c.record(input());
      await c.flush();
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const content = await readFile(join(dir, files[0]!), 'utf8');
      expect(content).not.toContain(TOKEN.slice(6));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
