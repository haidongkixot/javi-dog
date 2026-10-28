import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { BudgetAlertJob, BudgetStatus } from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- composed schema type lives in JD-M06
export type BudgetDb = PgDatabase<PgQueryResultHKT, any>;

export const createBudgetRepository = (db: BudgetDb) => ({
  /** The project's budget status; the project must belong to the workspace (else null). */
  async status(
    workspaceId: string,
    projectId: string,
    opts: { now?: Date } = {},
  ): Promise<BudgetStatus | null> {
    void db;
    void workspaceId;
    void projectId;
    void opts;
    throw new Error('not implemented (S4c B1)');
  },

  /** Status for every project of the workspace that has a budget (projects list). */
  async statuses(workspaceId: string, opts: { now?: Date } = {}): Promise<BudgetStatus[]> {
    void workspaceId;
    void opts;
    throw new Error('not implemented (S4c B1)');
  },

  /** Sets (or replaces) the monthly limit. Throws RangeError outside 0 < x ≤ 1 000 000. */
  async setBudget(
    workspaceId: string,
    projectId: string,
    limitUsd: number,
    userId: string,
  ): Promise<void> {
    void workspaceId;
    void projectId;
    void limitUsd;
    void userId;
    throw new Error('not implemented (S4c B1)');
  },

  async clearBudget(workspaceId: string, projectId: string): Promise<void> {
    void workspaceId;
    void projectId;
    throw new Error('not implemented (S4c B1)');
  },

  /**
   * After ingest: if the project has a budget and a threshold is newly crossed (or a failed /
   * stale pending alert can be retried), claims it exactly once and returns the job to send;
   * marks lower thresholds `covered`. Returns null when there is nothing to send.
   */
  async claimAlert(
    scope: { workspaceId: string; projectId: string },
    opts: { now?: Date } = {},
  ): Promise<BudgetAlertJob | null> {
    void scope;
    void opts;
    throw new Error('not implemented (S4c B1)');
  },

  async markAlert(alertId: string, outcome: 'sent' | 'failed'): Promise<void> {
    void alertId;
    void outcome;
    throw new Error('not implemented (S4c B1)');
  },
});

export type BudgetRepository = ReturnType<typeof createBudgetRepository>;
