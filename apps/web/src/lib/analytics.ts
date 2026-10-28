import {
  ANALYTICS_DEFAULT_DAYS,
  createAnalyticsReader,
  type UsageAnalytics,
} from '@javis-dog/analytics';
import type { Db } from '@javis-dog/event-store';
import { getDb } from './auth';
import { getViewer } from './viewer';

/** Days shown by every usage block (ADR-0013): the last 14 UTC days including today. */
export const USAGE_DAYS = ANALYTICS_DEFAULT_DAYS;

/** The part of the JD-M08 reader the web app uses. */
export interface UsageReader {
  usage: (
    workspaceId: string,
    opts: { days?: number; projectId?: string },
  ) => Promise<UsageAnalytics>;
}

/**
 * Injectable dependencies, mirroring `DashboardDeps` (lib/dashboard.ts). The workspace comes
 * from `getViewer` (session + membership) only; nothing here reads request input.
 */
export interface AnalyticsDeps<D> {
  getViewer: () => Promise<{ workspaceId: string } | null>;
  getDb: () => D | null;
  reader: (db: D) => UsageReader;
}

/** Production wiring: session + membership, the shared database handle and the JD-M08 reader. */
export const analyticsDeps: AnalyticsDeps<Db> = {
  getViewer,
  getDb: () => getDb(),
  reader: (db) => createAnalyticsReader(db),
};

export type UsageLoad =
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; usage: UsageAnalytics }
  | { kind: 'unavailable' };

const logFailure = (error: unknown) =>
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg: 'usage analytics failed',
      // The name only: driver messages can echo hosts or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );

/**
 * Workspace-scoped usage of the last 14 UTC days for the signed-in viewer (ADR-0013).
 * `projectId` narrows to one project; callers pass it only from a project they already loaded
 * scoped to the viewer's workspace (the reader also filters inside the workspace). Without a
 * database "not configured" is decided first and the session is never looked up.
 */
export const loadUsage = async <D>(
  deps: AnalyticsDeps<D>,
  { projectId }: { projectId?: string } = {},
): Promise<UsageLoad> => {
  const db = deps.getDb();
  if (!db) return { kind: 'not_configured' };
  try {
    // The session lookup reads the database too: its failure is "unavailable", not a crash.
    const viewer = await deps.getViewer();
    if (!viewer) return { kind: 'signed_out' };
    const usage = await deps
      .reader(db)
      .usage(
        viewer.workspaceId,
        projectId === undefined ? { days: USAGE_DAYS } : { days: USAGE_DAYS, projectId },
      );
    return { kind: 'ready', usage };
  } catch (error) {
    logFailure(error);
    return { kind: 'unavailable' };
  }
};
