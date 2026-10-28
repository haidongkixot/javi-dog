import type { AnyDb } from '@javis-dog/event-store';
import type { UsageAnalytics } from './types.ts';

export const ANALYTICS_DEFAULT_DAYS = 14;
/** Raw events are kept 30 days (ADR-0008); longer ranges would silently undercount. */
export const ANALYTICS_MAX_DAYS = 30;

export const createAnalyticsReader = (db: AnyDb) => ({
  /** Workspace-scoped daily usage for the last `days` UTC days including today (clamped 1–30). */
  async usage(
    workspaceId: string,
    opts: { days?: number; projectId?: string; now?: Date } = {},
  ): Promise<UsageAnalytics> {
    void db;
    void workspaceId;
    void opts;
    throw new Error('not implemented (S4b A1)');
  },
});

export type AnalyticsReader = ReturnType<typeof createAnalyticsReader>;
