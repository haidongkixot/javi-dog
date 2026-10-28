import type { DashboardSnapshot } from '@javis-dog/realtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';

const snapshot: DashboardSnapshot = {
  generatedAt: '2026-10-28T10:00:00.000Z',
  freshnessWindowMs: 180_000,
  windowHours: 24,
  overview: {
    activeProjects: { value: 0, lastSignalAt: null },
    agentsWorking: { value: 0, lastSignalAt: null },
    tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
    tasksCompleted24h: { value: 0, lastSignalAt: null },
  },
  threads: [],
  activity: [],
  projects: [],
};

// Module wiring used by the real route: session, database handle and the JD-M07 reader.
const state = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
const readSnapshot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/viewer', () => ({ getViewer: async () => state.viewer }));
vi.mock('@/lib/auth', () => ({ getDb: () => state.db }));
vi.mock('@javis-dog/realtime', () => ({
  createDashboardReader: (db: unknown) => ({
    snapshot: (workspaceId: string) => readSnapshot(db, workspaceId),
  }),
}));

const { dashboardSnapshotResponse, loadDashboard } = await import('@/lib/dashboard');
const route = await import('@/app/api/dashboard/snapshot/route');

const deps = (over: Partial<Parameters<typeof dashboardSnapshotResponse>[0]> = {}) => ({
  getViewer: vi.fn(async () => ({ workspaceId: WS })),
  getDb: () => ({ db: true }),
  reader: () => ({ snapshot: vi.fn(async () => snapshot) }),
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  state.viewer = null;
  state.db = null;
});

describe('dashboardSnapshotResponse (ADR-0012)', () => {
  it('answers 401 unauthorized when signed out, without reading', async () => {
    const snap = vi.fn();
    const res = await dashboardSnapshotResponse(
      deps({ getViewer: async () => null, reader: () => ({ snapshot: snap }) }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(snap).not.toHaveBeenCalled();
  });

  it('answers 503 not_configured without a database and never looks up the session', async () => {
    const d = deps({ getDb: () => null });
    const res = await dashboardSnapshotResponse(d);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(d.getViewer).not.toHaveBeenCalled();
  });

  it('answers 200 with the snapshot of the viewer’s workspace', async () => {
    const snap = vi.fn(async () => snapshot);
    const db = { db: true };
    const reader = vi.fn(() => ({ snapshot: snap }));
    const res = await dashboardSnapshotResponse(deps({ getDb: () => db, reader }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(snapshot);
    expect(reader).toHaveBeenCalledWith(db);
    expect(snap).toHaveBeenCalledWith(WS);
  });

  it('answers 503 unavailable when the read fails and logs the error name only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await dashboardSnapshotResponse(
      deps({
        reader: () => ({
          snapshot: async () => {
            throw new Error('connect ECONNREFUSED postgres://user:hunter2@host');
          },
        }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });

  it('loadDashboard reports each state for the server pages', async () => {
    expect(await loadDashboard(deps({ getDb: () => null }))).toEqual({ kind: 'not_configured' });
    expect(await loadDashboard(deps({ getViewer: async () => null }))).toEqual({
      kind: 'signed_out',
    });
    expect(await loadDashboard(deps())).toEqual({ kind: 'ready', snapshot });
  });
});

describe('GET /api/dashboard/snapshot', () => {
  it('is dynamic and Node.js only', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });

  it('takes the workspace from the session and ignores ?workspace= and similar input', async () => {
    state.db = { db: 'shared' };
    state.viewer = { workspaceId: WS, user: { id: 'u' } };
    readSnapshot.mockResolvedValue(snapshot);
    const GET = route.GET as unknown as (request: Request) => Promise<Response>;
    const res = await GET(
      new Request(
        `https://jd.example/api/dashboard/snapshot?workspace=${OTHER_WS}&workspaceId=${OTHER_WS}`,
        { headers: { 'x-workspace-id': OTHER_WS } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledWith({ db: 'shared' }, WS);
    expect(JSON.stringify(readSnapshot.mock.calls)).not.toContain(OTHER_WS);
  });

  it('answers 401 for a signed-out request even with a workspace parameter', async () => {
    state.db = { db: 'shared' };
    const GET = route.GET as unknown as (request: Request) => Promise<Response>;
    const res = await GET(new Request(`https://jd.example/api/dashboard/snapshot?workspace=${WS}`));
    expect(res.status).toBe(401);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('answers 503 without a database', async () => {
    const res = await route.GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
  });
});
