import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, DB_TIMEOUT_MS, HEALTH_ENV_NAMES } from '@/lib/health';

vi.mock('@javis-dog/event-store', () => ({
  createDb: () => ({}),
  pingDb: async () => ({ latencyMs: 12, migrationsApplied: 1 }),
}));

const SECRET = 'postgresql://user:hunter2@ep-secret-host.neon.tech/db';
const fullEnv = Object.fromEntries(HEALTH_ENV_NAMES.map((n) => [n, `value-of-${n}`]));
const ok = async () => ({ latencyMs: 12, migrationsApplied: 1 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('checkHealth', () => {
  it('reports every env var as a boolean and never echoes a value', async () => {
    const { body } = await checkHealth({ env: { ...fullEnv, DATABASE_URL: SECRET }, ping: ok });
    expect(Object.keys(body.env)).toEqual([...HEALTH_ENV_NAMES]);
    expect(Object.values(body.env).every((v) => v === true)).toBe(true);
    const json = JSON.stringify(body);
    expect(json).not.toContain('hunter2');
    for (const name of HEALTH_ENV_NAMES) expect(json).not.toContain(`value-of-${name}`);
  });

  it('treats blank values as missing', async () => {
    const { body } = await checkHealth({ env: { EMAIL_FROM: '  ' }, ping: ok });
    expect(body.env.EMAIL_FROM).toBe(false);
  });

  it('returns 200 with latency and migration count when the DB answers', async () => {
    const r = await checkHealth({
      env: { DATABASE_URL: SECRET, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567' },
      ping: ok,
      now: () => new Date('2026-10-22T10:00:00Z'),
    });
    expect(r.httpStatus).toBe(200);
    expect(r.body).toMatchObject({
      status: 'ok',
      checkedAt: '2026-10-22T10:00:00.000Z',
      deployment: { env: 'preview', commit: 'abcdef1' },
      db: { status: 'ok', latencyMs: 12, migrationsApplied: 1 },
    });
  });

  it('returns 503 not_configured without DATABASE_URL and never pings', async () => {
    const ping = vi.fn(ok);
    const r = await checkHealth({ env: {}, ping });
    expect(r.httpStatus).toBe(503);
    expect(r.body.db.status).toBe('not_configured');
    expect(r.body.deployment).toEqual({ env: 'local', commit: null });
    expect(ping).not.toHaveBeenCalled();
  });

  it('returns 503 error without leaking the driver message', async () => {
    const r = await checkHealth({
      env: { DATABASE_URL: SECRET },
      ping: async () => {
        throw new Error(`connect failed for ${SECRET}`);
      },
    });
    expect(r.httpStatus).toBe(503);
    expect(r.body).toMatchObject({ status: 'degraded', db: { status: 'error', latencyMs: null } });
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
  });

  it(`gives up on a hung DB after ${DB_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    const pending = checkHealth({
      env: { DATABASE_URL: SECRET },
      ping: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    expect((await pending).body.db.status).toBe('error');
  });
});

describe('GET /api/health', () => {
  it('is dynamic, uncached JSON', async () => {
    vi.stubEnv('DATABASE_URL', SECRET);
    const route = await import('@/app/api/health/route');
    const res = await route.GET();
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).db.status).toBe('ok');
  });
});
