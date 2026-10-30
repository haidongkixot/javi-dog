import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { validateBatch } from '@javis-dog/jgr-spec';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIngestDeps, createIngestHandler, type IngestDeps } from '../src/index.ts';

// Real validator by default; one test forces a result the validator may return (H4).
vi.mock('@javis-dog/jgr-spec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@javis-dog/jgr-spec')>();
  return { ...actual, validateBatch: vi.fn(actual.validateBatch) };
});

const NOW = new Date('2026-10-23T10:00:00Z');

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let projects: ReturnType<typeof createProjectRepository>;

// One in-process Postgres with the committed migrations (TEST_PLAN S3a).
beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  projects = createProjectRepository(db);
});
beforeEach(async () => {
  await client.exec('truncate workspaces, ingest_rate_windows cascade');
});
afterEach(() => vi.restoreAllMocks());

const setup = async (privacyClass: 'L0' | 'L1' | 'L2' = 'L0', name = 'Signal team') => {
  const ws = await projects.createWorkspace({ name });
  const p = await projects.createProject(ws.id, {
    name: 'Web App',
    platforms: ['claude-code'],
    privacyClass,
  });
  const { token, record } = await projects.issueToken(ws.id, p.id, 'laptop');
  return { ws, p, token, tokenId: record.id };
};

const ulid = (n: number) => `01JBZ4XQ80${String(n).padStart(16, '0')}`;
const event = (n: number, extra: Record<string, unknown> = {}) => ({
  jgr: '0.1',
  event_id: ulid(n),
  producer_id: 'prod_claude-code_7f3a',
  project_ref: 'web-app',
  thread_ref: 'sess_2b9c',
  sequence: n,
  type: 'heartbeat',
  status: 'working',
  occurred_at: '2026-10-23T09:59:00Z',
  ...extra,
});

const post = (token: string | null, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request('https://javisdog.test/api/v1/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: (typeof body === 'string' || body instanceof Uint8Array
      ? body
      : JSON.stringify(body)) as BodyInit,
  });

/**
 * In-memory stand-in for the store's rate window. The real window comes from the DB clock (H6),
 * so the handler's `now` no longer picks it; the store's own tests cover the SQL.
 */
const fakeRateWindow = (resetAt = new Date('2026-10-23T10:01:00Z')) => {
  const counts = new Map<string, number>();
  return vi.fn(async (tokenId: string) => {
    const n = (counts.get(tokenId) ?? 0) + 1;
    counts.set(tokenId, n);
    return { count: n, resetAt };
  });
};

const handler = (overrides: Partial<IngestDeps> = {}) =>
  createIngestHandler({
    ...createIngestDeps(db),
    hitRateWindow: fakeRateWindow(),
    now: () => NOW,
    ...overrides,
  });

const count = async (table: string) =>
  (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

describe('authentication', () => {
  it('answers 401 with WWW-Authenticate for missing, malformed, unknown and revoked tokens', async () => {
    const { ws, token, tokenId } = await setup();
    const hitRateWindow = fakeRateWindow();
    const h = handler({ hitRateWindow });
    const unknown = `jd_it_${'A'.repeat(43)}`;
    for (const t of [null, 'nope', unknown]) {
      const res = await h(post(t, { events: [event(1)] }));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    await projects.revokeToken(ws.id, tokenId);
    expect((await h(post(token, { events: [event(1)] }))).status).toBe(401);
    expect(await count('events')).toBe(0);
    expect(hitRateWindow).not.toHaveBeenCalled();
  });

  it('checks the token before the media type', async () => {
    const res = await handler()(post('nope', 'x', { 'content-type': 'text/plain' }));
    expect(res.status).toBe(401);
  });
});

describe('accepting events', () => {
  it('stores valid events, returns 202 counts and marks a verified signal', async () => {
    const { ws, p, token } = await setup();
    const res = await handler()(post(token, { events: [event(1), event(2)] }));
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    const row = (
      await client.query<Record<string, unknown>>(
        'select project_id, workspace_id, producer_id, type, status, privacy_class, received_at from events order by sequence limit 1',
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      project_id: p.id,
      workspace_id: ws.id,
      producer_id: 'prod_claude-code_7f3a',
      type: 'heartbeat',
      status: 'working',
      privacy_class: 'L0',
    });
    expect(row.received_at).toEqual(NOW);
    expect((await projects.getProject(ws.id, p.id))?.lastSignalAt).toEqual(NOW);
    expect((await projects.listTokens(ws.id, p.id))[0]?.lastUsedAt).toEqual(NOW);
  });

  it('accepts project_ref as the project id too', async () => {
    const { p, token } = await setup();
    const res = await handler()(post(token, { events: [event(1, { project_ref: p.id })] }));
    expect(await res.json()).toMatchObject({ accepted: 1 });
  });

  it('accepts gzip bodies', async () => {
    const { token } = await setup();
    const body = gzipSync(JSON.stringify({ events: [event(1)] }));
    const res = await handler()(post(token, new Uint8Array(body), { 'content-encoding': 'gzip' }));
    expect(await res.json()).toMatchObject({ accepted: 1 });
  });

  it('reports a retried batch as duplicates and still marks the signal (H2)', async () => {
    const { ws, p, token } = await setup();
    const batch = { events: [event(1), event(2)] };
    await handler()(post(token, batch));
    const later = new Date(NOW.getTime() + 30_000);
    const res = await handler({ now: () => later })(post(token, batch));
    expect(await res.json()).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(await count('events')).toBe(2);
    expect((await projects.getProject(ws.id, p.id))?.lastSignalAt).toEqual(later);
  });

  it('writes the signal on the retry when the first bookkeeping write failed (H2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws, p, token, tokenId } = await setup();
    const batch = { events: [event(1), event(2)] };
    const touchSignal = vi
      .fn<IngestDeps['touchSignal']>()
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValue(undefined);
    const markTokenUsed = vi.fn<IngestDeps['markTokenUsed']>(async () => {});

    const first = await handler({ touchSignal, markTokenUsed })(post(token, batch));
    expect(first.status).toBe(503);
    expect(await count('events')).toBe(2); // the insert itself committed

    const later = new Date(NOW.getTime() + 5_000);
    const second = await handler({ touchSignal, markTokenUsed, now: () => later })(
      post(token, batch),
    );
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(touchSignal).toHaveBeenCalledTimes(2);
    expect(touchSignal).toHaveBeenLastCalledWith({ projectId: p.id, workspaceId: ws.id }, later);
    expect(markTokenUsed).toHaveBeenLastCalledWith(tokenId, later);
  });

  it('marks no signal when every event was rejected', async () => {
    const { token } = await setup();
    const touchSignal = vi.fn<IngestDeps['touchSignal']>(async () => {});
    const markTokenUsed = vi.fn<IngestDeps['markTokenUsed']>(async () => {});
    const res = await handler({ touchSignal, markTokenUsed })(
      post(token, { events: [event(1, { project_ref: 'someone-elses-project' })] }),
    );
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 0 });
    expect(touchSignal).not.toHaveBeenCalled();
    expect(markTokenUsed).not.toHaveBeenCalled();
  });

  it('collapses a duplicate inside one batch', async () => {
    const { token } = await setup();
    const res = await handler()(post(token, { events: [event(1), event(1)] }));
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 1, rejected: [] });
  });
});

describe('partial acceptance and tenant rules', () => {
  it('stores valid events and rejects others by index with stable codes', async () => {
    const { token } = await setup();
    const res = await handler()(
      post(token, {
        events: [
          event(1),
          event(2, { project_ref: 'someone-elses-project' }),
          event(3, { attributes: { prompt: 'secret plan' } }),
          event(4, { status: undefined }),
          event(5),
        ],
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: number;
      rejected: Array<{ index: number; event_id: string; issues: Array<{ code: string }> }>;
    };
    expect(body.accepted).toBe(2);
    expect(body.rejected.map((r) => [r.index, r.event_id, r.issues.map((i) => i.code)])).toEqual([
      [1, ulid(2), ['project_mismatch']],
      [2, ulid(3), ['privacy_forbidden_attribute']],
      [3, ulid(4), ['status_required']],
    ]);
    expect(JSON.stringify(body)).not.toContain('secret plan');
    expect(await count('events')).toBe(2);
  });

  it('echoes the producer’s own event_id spelling in tenant-rule rejections (review m9)', async () => {
    const { token } = await setup();
    const lower = ulid(7).toLowerCase();
    const res = await handler()(
      post(token, { events: [event(7, { event_id: lower, project_ref: 'not-this-project' })] }),
    );
    const body = (await res.json()) as { rejected: Array<{ event_id: string }> };
    expect(body.rejected[0]!.event_id).toBe(lower);
  });

  it('never stores an event in another tenant’s project, even with its slug', async () => {
    const mine = await setup('L0', 'Mine');
    await setup('L0', 'Theirs'); // same slug "web-app" in another workspace
    const res = await handler()(post(mine.token, { events: [event(1)] }));
    expect(await res.json()).toMatchObject({ accepted: 1 });
    const owners = await client.query<{ workspace_id: string }>('select workspace_id from events');
    expect(owners.rows).toEqual([{ workspace_id: mine.ws.id }]);
  });

  it('enforces the project privacy class as a ceiling', async () => {
    const { token } = await setup('L0');
    const l1 = event(1, {
      privacy_class: 'L1',
      attributes: { repo_hash: `sha256:${'a'.repeat(64)}` },
    });
    const res = await handler()(post(token, { events: [l1] }));
    expect(await res.json()).toMatchObject({
      accepted: 0,
      rejected: [{ index: 0, issues: [{ code: 'privacy_class_not_allowed' }] }],
    });
    const ok = await setup('L1', 'L1 team');
    const res2 = await handler()(post(ok.token, { events: [l1] }));
    expect(await res2.json()).toMatchObject({ accepted: 1, rejected: [] });
  });

  it('rejects an L2 iv that is not exactly 12 bytes (16 base64url characters, ADR-0018)', async () => {
    const { token } = await setup('L2');
    const l2 = (n: number, iv: string) =>
      event(n, {
        privacy_class: 'L2',
        encrypted: { alg: 'A256GCM', kid: 'ABCDEFGH', iv, ciphertext: 'c2VjcmV0LWNvbnRlbnQ' },
      });
    // 15 characters, 12 bytes, and the 16-byte form the schema accepted before S5f.
    const events = [l2(1, 'A'.repeat(15)), l2(2, 'A'.repeat(16)), l2(3, 'A'.repeat(22))];
    const res = await handler()(post(token, { events }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: 1,
      rejected: [
        { index: 0, issues: [{ code: 'schema', path: 'encrypted.iv' }] },
        { index: 2, issues: [{ code: 'schema', path: 'encrypted.iv' }] },
      ],
    });
    const stored = await client.query<{ sequence: number }>('select sequence from events');
    expect(stored.rows).toEqual([{ sequence: 2 }]);
  });

  it('rejects clock skew beyond 5 minutes', async () => {
    const { token } = await setup();
    const res = await handler()(
      post(token, { events: [event(1, { occurred_at: '2026-10-23T10:06:00Z' })] }),
    );
    expect(await res.json()).toMatchObject({
      accepted: 0,
      rejected: [{ index: 0, issues: [{ code: 'clock_skew' }] }],
    });
  });
});

describe('malformed and oversized requests', () => {
  it('answers 400 for bad JSON, an empty body and a bad batch shape', async () => {
    const { token } = await setup();
    const h = handler();
    expect((await h(post(token, '{not json'))).status).toBe(400);
    expect((await h(post(token, ''))).status).toBe(400);
    expect((await h(post(token, { events: [] }))).status).toBe(400);
    expect((await h(post(token, { events: [event(1)], extra: 1 }))).status).toBe(400);
    expect(await count('events')).toBe(0);
  });

  // S5a review L3: ~240 KB of nesting is under the 256 KB limit and parses, but walking it
  // overflowed the stack and came back as a retryable 503. It is a malformed request.
  it('answers 400 malformed, not 503, for deeply nested JSON under the size limit', async () => {
    const { token } = await setup();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = handler();
    const deep = `{"events":[${'['.repeat(120_000)}${']'.repeat(120_000)}]}`;
    expect(new TextEncoder().encode(deep).length).toBeLessThan(256 * 1024);
    for (const body of [deep, gzipSync(deep)]) {
      const res = await h(
        post(token, body, body instanceof Uint8Array ? { 'content-encoding': 'gzip' } : {}),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('retry-after')).toBeNull();
      const json = (await res.json()) as { error: string; issues: Array<{ code: string }> };
      expect(json.error).toBe('malformed');
      expect(json.issues[0]!.code).toBe('schema');
    }
    // Deep objects too, and just past the depth limit.
    const objects = `{"events":[${'{"a":'.repeat(40)}1${'}'.repeat(40)}]}`;
    expect((await h(post(token, objects))).status).toBe(400);
    expect(quiet).not.toHaveBeenCalled();
    expect(await count('events')).toBe(0);
  });

  it('counts only structural brackets, so bracket characters in strings are fine', async () => {
    const { token } = await setup();
    // Escaped quotes and backslashes must not end the string early in the scan.
    const value = `"[\\${'[{'.repeat(50)}\\"`;
    const brackets = event(1, { attributes: { platform_version: value } });
    const res = await handler()(post(token, { events: [brackets] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
  });

  it('answers 415 for another media type or an unknown encoding (H4)', async () => {
    const { token } = await setup();
    const h = handler();
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json-seq' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-encoding': 'br' },
    ]) {
      const res = await h(post(token, { events: [event(1)] }, headers));
      expect(res.status).toBe(415);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: 'unsupported_media_type',
        message: expect.any(String),
      });
    }
    expect(await count('events')).toBe(0);
  });

  it('accepts application/json with parameters, in any case', async () => {
    const { token } = await setup();
    const res = await handler()(
      post(token, { events: [event(1)] }, { 'content-type': 'Application/JSON; charset=utf-8' }),
    );
    expect(res.status).toBe(202);
  });

  it('maps a too_large validation result (e.g. > 100 events) to 413', async () => {
    const { token } = await setup();
    const issues = [{ code: 'too_large' as const, path: 'events', message: 'At most 100.' }];
    vi.mocked(validateBatch).mockReturnValueOnce({ ok: false, issues });
    const res = await handler()(post(token, { events: [event(1)] }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', issues });
    expect(await count('events')).toBe(0);
  });

  it('answers 413 for more than 256 KB, also when it arrives gzip-compressed', async () => {
    const { token } = await setup();
    const big = JSON.stringify({ events: [event(1)], pad: 'x'.repeat(300 * 1024) });
    expect((await handler()(post(token, big))).status).toBe(413);
    const res = await handler()(
      post(token, new Uint8Array(gzipSync(big)), { 'content-encoding': 'gzip' }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After once a token exceeds its batches per minute', async () => {
    const { token } = await setup();
    const at = new Date('2026-10-23T10:00:45Z');
    const hitRateWindow = fakeRateWindow(new Date('2026-10-23T10:01:00Z'));
    const h = handler({ now: () => at, rateLimitPerMinute: 2, hitRateWindow });
    expect((await h(post(token, { events: [event(1)] }))).status).toBe(202);
    expect((await h(post(token, { events: [event(2)] }))).status).toBe(202);
    const res = await h(post(token, { events: [event(3)] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('15');
    expect(await count('events')).toBe(2);
    // The window is the store's (DB clock); the handler passes only the token id.
    expect(hitRateWindow.mock.calls.every((c) => c.length === 1)).toBe(true);
    // A new window (fresh count) lets the token in again.
    const next = handler({ now: () => new Date('2026-10-23T10:01:00Z'), rateLimitPerMinute: 2 });
    expect((await next(post(token, { events: [event(3)] }))).status).toBe(202);
  });

  it('never answers Retry-After below 1 s when the DB clock is ahead of this instance', async () => {
    const { token } = await setup();
    const h = handler({
      now: () => new Date('2026-10-23T10:01:02Z'),
      rateLimitPerMinute: 0,
      hitRateWindow: fakeRateWindow(new Date('2026-10-23T10:01:00Z')),
    });
    const res = await h(post(token, { events: [event(1)] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
  });

  it('checks the rate limit before the media type', async () => {
    const { token } = await setup();
    const res = await handler({ rateLimitPerMinute: 0 })(
      post(token, 'x', { 'content-type': 'text/plain' }),
    );
    expect(res.status).toBe(429);
  });
});

describe('onStored hook (ADR-0014 budget alerts)', () => {
  const usage = (n: number, extra: Record<string, unknown> = {}) =>
    event(n, { type: 'usage.reported', usage_delta: { cost_usd: 0.25 }, ...extra });
  type Hook = NonNullable<IngestDeps['onStored']>;

  it('is called once, after the insert, with the token scope and the usage report count', async () => {
    const { ws, p, token } = await setup();
    const seen: number[] = [];
    const onStored = vi.fn<Hook>(() => {
      void count('events').then((n) => seen.push(n));
    });
    const res = await handler({ onStored })(
      post(token, { events: [usage(1), event(2), usage(3)] }),
    );
    expect(res.status).toBe(202);
    expect(onStored).toHaveBeenCalledOnce();
    expect(onStored).toHaveBeenCalledWith(
      { workspaceId: ws.id, projectId: p.id },
      { usageReports: 2 },
    );
    await vi.waitFor(() => expect(seen).toEqual([3]));
  });

  it('is called again for a duplicate-only retry (the consumer is idempotent)', async () => {
    const { token } = await setup();
    const onStored = vi.fn<Hook>();
    const batch = { events: [usage(1)] };
    await handler({ onStored })(post(token, batch));
    const res = await handler({ onStored })(post(token, batch));
    expect(await res.json()).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    expect(onStored).toHaveBeenCalledTimes(2);
  });

  it('is not called for batches without usage, rejected-only usage, or auth and rate-limit failures', async () => {
    const { token } = await setup();
    const onStored = vi.fn<Hook>();
    await handler({ onStored })(post(token, { events: [event(1), event(2)] }));
    const rejected = await handler({ onStored })(
      post(token, { events: [usage(3, { project_ref: 'someone-elses-project' })] }),
    );
    expect(await rejected.json()).toMatchObject({ accepted: 0, duplicates: 0 });
    expect((await handler({ onStored })(post('nope', { events: [usage(4)] }))).status).toBe(401);
    const limited = handler({ onStored, rateLimitPerMinute: 0 });
    expect((await limited(post(token, { events: [usage(5)] }))).status).toBe(429);
    expect(onStored).not.toHaveBeenCalled();
  });

  it('is not called when the signal write fails (503); the retry triggers it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = await setup();
    const onStored = vi.fn<Hook>();
    const touchSignal = vi
      .fn<IngestDeps['touchSignal']>()
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValue(undefined);
    const batch = { events: [usage(1)] };
    expect((await handler({ onStored, touchSignal })(post(token, batch))).status).toBe(503);
    expect(onStored).not.toHaveBeenCalled();
    expect((await handler({ onStored, touchSignal })(post(token, batch))).status).toBe(202);
    expect(onStored).toHaveBeenCalledOnce();
  });

  it('never changes the 202 status or body when the hook throws or rejects', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = await setup();
    const baseline = await handler()(post(token, { events: [usage(1), usage(2)] }));
    const expected = { status: baseline.status, body: await baseline.json() };
    expect(expected).toEqual({
      status: 202,
      body: { accepted: 2, duplicates: 0, rejected: [] },
    });

    const throwing = vi.fn<Hook>(() => {
      throw new Error('postgresql://user:hunter2@host/db');
    });
    const rejecting = vi.fn(async () => {
      throw new TypeError('boom');
    }) as unknown as Hook;
    for (const [n, onStored] of [
      [3, throwing],
      [5, rejecting],
    ] as const) {
      const res = await handler({ onStored })(post(token, { events: [usage(n), usage(n + 1)] }));
      expect({ status: res.status, body: await res.json() }).toEqual(expected);
    }
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    const logged = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual([
      { level: 'error', module: 'JD-M05', msg: 'ingest onStored hook failed', error: 'Error' },
      { level: 'error', module: 'JD-M05', msg: 'ingest onStored hook failed', error: 'TypeError' },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });
});

describe('failures', () => {
  it('answers 503 without driver details when the database fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createIngestHandler({
      ...createIngestDeps(db),
      verifyToken: async () => {
        throw new Error('connect ECONNREFUSED postgresql://user:hunter2@host/db');
      },
    })(post(`jd_it_${'A'.repeat(43)}`, { events: [event(1)] }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });
});
