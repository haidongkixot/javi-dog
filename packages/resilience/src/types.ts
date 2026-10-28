import type { BudgetThreshold } from './budget.ts';

export interface BudgetStatus {
  projectId: string;
  /** null when the project has no budget. */
  limitUsd: number | null;
  /** UTC month, e.g. "2026-10". */
  month: string;
  /** Month-to-date estimated spend (sum of producer-reported cost_usd). */
  spendUsd: number;
  /**
   * spend / limit × 100, exact and floored to 0.01 (never rounded up), or null without a
   * budget. Display may floor further; threshold signals use `thresholdReached`.
   */
  percentUsed: number | null;
  /** Highest threshold reached by exact micro-dollars (`crossedThreshold`), null below 80 % or without a budget. */
  thresholdReached: BudgetThreshold | null;
  /** Linear projection, null before 24 h of the month have elapsed. */
  forecastUsd: number | null;
  reports: number;
  estimatedReports: number;
  /**
   * Thresholds whose owners were emailed this month: 100 when its row is `sent`; 80 when its
   * row is `sent`, or `covered` and the 100 row is `sent`. Never a pending or failed email.
   */
  alerted: BudgetThreshold[];
  /** Thresholds claimed and not yet reported sent or failed this month (`pending`). */
  pendingAlerts: BudgetThreshold[];
  /** Thresholds whose email failed this month (`failed`, including exhausted attempts). */
  failedAlerts: BudgetThreshold[];
  /** The `failedAlerts` that used all attempts (5) and are never retried. */
  exhaustedAlerts: BudgetThreshold[];
  generatedAt: string;
}

export interface BudgetAlertJob {
  alertId: string;
  projectId: string;
  workspaceId: string;
  projectName: string;
  projectSlug: string;
  threshold: BudgetThreshold;
  status: BudgetStatus;
  /** Verified emails of the workspace owners. Never logged. */
  recipients: string[];
}
