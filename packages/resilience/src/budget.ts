// Pure budget arithmetic (ADR-0014). All money values are estimated USD.

export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];
/** No forecast before this much of the month has elapsed. */
export const FORECAST_MIN_ELAPSED_MS = 24 * 60 * 60 * 1000;
export const MAX_MONTHLY_LIMIT_USD = 1_000_000;

/** First instant of `now`'s UTC month and the month's length in ms. */
export const utcMonth = (now: Date): { start: Date; end: Date; key: string; lengthMs: number } => {
  void now;
  throw new Error('not implemented (S4c B1)');
};

/** Linear end-of-month projection, or null when < 24 h of the month have elapsed. */
export const forecastSpend = (spendUsd: number, now: Date): number | null => {
  void spendUsd;
  void now;
  throw new Error('not implemented (S4c B1)');
};

/** Highest threshold reached by `spend / limit` (in percent), or null below 80 %. */
export const crossedThreshold = (spendUsd: number, limitUsd: number): BudgetThreshold | null => {
  void spendUsd;
  void limitUsd;
  throw new Error('not implemented (S4c B1)');
};
