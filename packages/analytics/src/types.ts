// JD-M08 analytics contract (ADR-0013). Days are UTC calendar dates (YYYY-MM-DD); times are ISO.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of producer-reported `cost_usd` — an estimate (ADR-0011, ADR-0013). */
  estimatedCostUsd: number;
  /** Number of `usage.reported` events counted. */
  reports: number;
}

export interface UsageDay extends UsageTotals {
  date: string;
  tasksCompleted: number;
  tasksFailed: number;
}

export interface UsageAnalytics {
  generatedAt: string;
  /** Inclusive UTC date range, oldest first; `days.length === range length`. */
  from: string;
  to: string;
  days: UsageDay[];
  /** Sorted by input + output tokens, descending; `model` is null when reports carried none. */
  byModel: Array<UsageTotals & { model: string | null }>;
  /**
   * Workspace projects with usage in the range, same sort. With `projectId`, at most that project —
   * and only if it has usage in the range (an empty list otherwise, never a zero row).
   */
  byProject: Array<UsageTotals & { projectId: string; slug: string; name: string }>;
  totals: UsageTotals & { tasksCompleted: number; tasksFailed: number };
  /** Newest `usage.reported` received in the range, or null. */
  lastReportAt: string | null;
}
