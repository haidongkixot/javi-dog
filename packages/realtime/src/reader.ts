import type { AnyDb } from '@javis-dog/event-store';
import type { DashboardSnapshot, Freshness } from './types.ts';

/** JGR §5 default: 3 × a 60 s heartbeat interval. */
export const FRESHNESS_WINDOW_MS = 180_000;
/** Events considered by the dashboard. */
export const SNAPSHOT_WINDOW_HOURS = 24;
export const ACTIVITY_LIMIT = 25;

/** `ended` after `session.ended`; else fresh within the window (inclusive), else stale. */
export const threadFreshness = (
  lastType: string,
  lastSignalAt: Date,
  now: Date,
  windowMs = FRESHNESS_WINDOW_MS,
): Freshness => {
  void lastType;
  void lastSignalAt;
  void now;
  void windowMs;
  throw new Error('not implemented (S4a R1)');
};

export const createDashboardReader = (db: AnyDb) => ({
  /** Workspace-scoped snapshot; `now` pins the clock for tests (default: database `now()`). */
  async snapshot(workspaceId: string, opts: { now?: Date } = {}): Promise<DashboardSnapshot> {
    void db;
    void workspaceId;
    void opts;
    throw new Error('not implemented (S4a R1)');
  },
});

export type DashboardReader = ReturnType<typeof createDashboardReader>;
