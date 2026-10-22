import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRetentionPurge } from '@/lib/purge';

const purgeEventsBefore = vi.fn(async () => 3);
vi.mock('@javis-dog/event-store', async (original) => ({
  ...(await original<typeof import('@javis-dog/event-store')>()),
  createDb: () => ({}),
  createEventRepository: () => ({ purgeEventsBefore }),
}));

const SECRET = 'cron-secret-value-for-tests-only-0123456789';
const env = { CRON_SECRET: SECRET, DATABASE_URL: 'postgresql://user:hunter2@host/db' };
const NOW = new Date('2026-10-23T20:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
  purgeEventsBefore.mockClear();
});

describe('runRetentionPurge', () => {
  it('deletes events older than 30 days with the right secret', async () => {
    const purge = vi.fn(async () => 7);
    const r = await runRetentionPurge(`Bearer ${SECRET}`, { env, purge, now: () => NOW });
    expect(r).toEqual({
      httpStatus: 200,
      body: { deleted: 7, cutoff: '2026-09-23T20:00:00.000Z' },
    });
    expect(purge).toHaveBeenCalledWith(new Date('2026-09-23T20:00:00Z'), NOW);
  });

  it('answers 401 for a missing, wrong or differently formatted secret and deletes nothing', async () => {
    const purge = vi.fn(async () => 0);
    for (const header of [null, 'Bearer wrong', SECRET, `Bearer ${SECRET} `, `bearer ${SECRET}`]) {
      expect((await runRetentionPurge(header, { env, purge })).httpStatus).toBe(401);
    }
    expect(purge).not.toHaveBeenCalled();
  });

  it('answers 503 not_configured without CRON_SECRET or DATABASE_URL, even for "Bearer "', async () => {
    const purge = vi.fn(async () => 0);
    for (const e of [
      { DATABASE_URL: env.DATABASE_URL },
      { CRON_SECRET: SECRET },
      { ...env, CRON_SECRET: '  ' },
    ]) {
      const r = await runRetentionPurge('Bearer ', { env: e, purge });
      expect(r).toEqual({ httpStatus: 503, body: { error: 'not_configured' } });
    }
    expect(purge).not.toHaveBeenCalled();
  });

  it('answers 503 without driver details when the purge fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runRetentionPurge(`Bearer ${SECRET}`, {
      env,
      purge: async () => {
        throw new Error('connect failed postgresql://user:hunter2@host/db');
      },
    });
    expect(r).toEqual({ httpStatus: 503, body: { error: 'unavailable' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    log.mockRestore();
  });
});

describe('GET /api/cron/purge-events', () => {
  it('is a dynamic Node route that purges with the configured secret', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', env.DATABASE_URL);
    const route = await import('@/app/api/cron/purge-events/route');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    const res = await route.GET(
      new Request('https://javisdog.test/api/cron/purge-events', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ deleted: 3 });
  });

  it('is scheduled once a day in vercel.json', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(config.crons).toEqual([{ path: '/api/cron/purge-events', schedule: '0 20 * * *' }]);
  });
});
