import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetIngestForTests } from '@/lib/ingest';

const handled = vi.fn(async () => Response.json({ accepted: 1 }, { status: 202 }));

vi.mock('@javis-dog/event-store', () => ({ createDb: () => ({}) }));
vi.mock('@javis-dog/ingest', () => ({
  createIngestDeps: () => ({}),
  createIngestHandler: () => handled,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  resetIngestForTests();
  handled.mockClear();
});

const request = () =>
  new Request('https://javisdog.test/api/v1/events', { method: 'POST', body: '{}' });

describe('POST /api/v1/events', () => {
  it('is a dynamic Node route', async () => {
    const route = await import('@/app/api/v1/events/route');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('answers 503 not_configured without a database and never calls the handler', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { POST } = await import('@/app/api/v1/events/route');
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
    expect(handled).not.toHaveBeenCalled();
  });

  it('delegates to the JD-M05 handler when a database is configured', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@host/db');
    const { POST } = await import('@/app/api/v1/events/route');
    const res = await POST(request());
    expect(res.status).toBe(202);
    expect(handled).toHaveBeenCalledOnce();
  });
});
