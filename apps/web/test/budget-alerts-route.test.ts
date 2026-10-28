import type { IngestDeps } from '@javis-dog/ingest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetIngestForTests } from '@/lib/ingest';

const { captured, claimAlert, after } = vi.hoisted(() => ({
  captured: {} as { deps?: IngestDeps | undefined },
  claimAlert: vi.fn(async () => null),
  after: vi.fn(),
}));

vi.mock('next/server', () => ({ after }));
vi.mock('@javis-dog/event-store', () => ({ createDb: () => ({}) }));
vi.mock('@javis-dog/resilience', () => ({
  createBudgetRepository: () => ({ claimAlert, markAlert: vi.fn() }),
}));
vi.mock('@javis-dog/ingest', () => ({
  createIngestDeps: () => ({}),
  createIngestHandler: (deps: IngestDeps) => {
    captured.deps = deps;
    return async () => Response.json({ accepted: 1 }, { status: 202 });
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  resetIngestForTests();
  captured.deps = undefined;
  claimAlert.mockClear();
  after.mockClear();
});

const request = () =>
  new Request('https://javisdog.test/api/v1/events', { method: 'POST', body: '{}' });
const scope = { workspaceId: 'ws_1', projectId: 'p_1' };

describe('POST /api/v1/events budget alert wiring (ADR-0014)', () => {
  it('schedules the alert with after() instead of running it in the response', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@host/db');
    vi.stubEnv('RESEND_API_KEY', 're_x');
    vi.stubEnv('EMAIL_FROM', 'a <a@example.com>');
    vi.stubEnv('BETTER_AUTH_URL', 'https://app.example');
    const { POST } = await import('@/app/api/v1/events/route');
    expect((await POST(request())).status).toBe(202);

    captured.deps?.onStored?.(scope, { usageReports: 1 });
    expect(after).toHaveBeenCalledOnce();
    expect(claimAlert).not.toHaveBeenCalled();

    const task = after.mock.calls[0]![0] as () => Promise<unknown>;
    expect(await task()).toBe('none');
    expect(claimAlert).toHaveBeenCalledWith(scope);
  });

  it('wires no hook (and claims nothing) while email is not configured', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@host/db');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
    vi.stubEnv('BETTER_AUTH_URL', '');
    const { POST } = await import('@/app/api/v1/events/route');
    expect((await POST(request())).status).toBe(202);
    expect(captured.deps).toBeDefined();
    expect(captured.deps?.onStored).toBeUndefined();
  });
});
