import type { BudgetThreshold } from './budget.ts';

export interface BudgetStatus {
  projectId: string;
  /** null when the project has no budget. */
  limitUsd: number | null;
  /** UTC month, e.g. "2026-10". */
  month: string;
  /** Month-to-date estimated spend (sum of producer-reported cost_usd). */
  spendUsd: number;
  /** spend / limit × 100, or null without a budget. */
  percentUsed: number | null;
  /** Linear projection, null before 24 h of the month have elapsed. */
  forecastUsd: number | null;
  reports: number;
  estimatedReports: number;
  /** Thresholds already alerted (sent or covered) this month. */
  alerted: BudgetThreshold[];
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
