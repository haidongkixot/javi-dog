import type { Db } from '@javis-dog/event-store';
import { createDashboardReader, type DashboardSnapshot } from '@javis-dog/realtime';
import { getDb } from './auth';
import { getViewer } from './viewer';

/** The part of the JD-M07 reader the web app uses. */
export interface SnapshotReader {
  snapshot: (workspaceId: string) => Promise<DashboardSnapshot>;
}

/**
 * Injectable dependencies (as in `health.ts` and `purge.ts`) so the route and the pages can be
 * tested without a database or a session. `getViewer` resolves the workspace from the session
 * plus membership; nothing here reads request input (ADR-0012).
 */
export interface DashboardDeps<D> {
  getViewer: () => Promise<{ workspaceId: string } | null>;
  getDb: () => D | null;
  reader: (db: D) => SnapshotReader;
}

/** Production wiring: session + membership, the shared database handle and the JD-M07 reader. */
export const dashboardDeps: DashboardDeps<Db> = {
  getViewer,
  getDb: () => getDb(),
  reader: (db) => createDashboardReader(db),
};

export type DashboardLoad =
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; snapshot: DashboardSnapshot }
  | { kind: 'unavailable' };

const logFailure = (error: unknown) =>
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg: 'dashboard snapshot failed',
      // The name only: driver messages can echo hosts or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );

/**
 * One workspace-scoped snapshot for the signed-in viewer. Without a database nobody can be
 * signed in, so "not configured" is decided first and the session is never looked up.
 */
export const loadDashboard = async <D>(deps: DashboardDeps<D>): Promise<DashboardLoad> => {
  const db = deps.getDb();
  if (!db) return { kind: 'not_configured' };
  try {
    // The session lookup reads the database too: its failure is "unavailable", not a crash.
    const viewer = await deps.getViewer();
    if (!viewer) return { kind: 'signed_out' };
    return { kind: 'ready', snapshot: await deps.reader(db).snapshot(viewer.workspaceId) };
  } catch (error) {
    logFailure(error);
    return { kind: 'unavailable' };
  }
};

const noStore = { 'Cache-Control': 'no-store' };

/**
 * `GET /api/dashboard/snapshot` (ADR-0012): 503 `not_configured` without a database,
 * 401 signed out, 503 `unavailable` when the session lookup or the read fails, else 200 with
 * the snapshot.
 * Always `Cache-Control: no-store`. It takes no request input, so a `?workspace=` parameter
 * cannot select another workspace.
 */
export const dashboardSnapshotResponse = async <D>(deps: DashboardDeps<D>): Promise<Response> => {
  const result = await loadDashboard(deps);
  switch (result.kind) {
    case 'not_configured':
      return Response.json({ error: 'not_configured' }, { status: 503, headers: noStore });
    case 'signed_out':
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
    case 'unavailable':
      return Response.json({ error: 'unavailable' }, { status: 503, headers: noStore });
    case 'ready':
      return Response.json(result.snapshot, { status: 200, headers: noStore });
  }
};
