// Pure budget arithmetic (ADR-0014). All money values are estimated USD.

export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];
/** No forecast before this much of the month has elapsed. */
export const FORECAST_MIN_ELAPSED_MS = 24 * 60 * 60 * 1000;
export const MAX_MONTHLY_LIMIT_USD = 1_000_000;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** First instant of `now`'s UTC month and the month's length in ms. */
export const utcMonth = (now: Date): { start: Date; end: Date; key: string; lengthMs: number } => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = Date.UTC(year, month, 1);
  // Date.UTC rolls month 12 over into January of the next year.
  const end = Date.UTC(year, month + 1, 1);
  return {
    start: new Date(start),
    end: new Date(end),
    key: `${year}-${pad2(month + 1)}`,
    lengthMs: end - start,
  };
};

/** Linear end-of-month projection, or null when < 24 h of the month have elapsed. */
export const forecastSpend = (spendUsd: number, now: Date): number | null => {
  const { start, lengthMs } = utcMonth(now);
  const elapsedMs = now.getTime() - start.getTime();
  if (elapsedMs < FORECAST_MIN_ELAPSED_MS) return null;
  return Math.round(((spendUsd * lengthMs) / elapsedMs) * 100) / 100;
};

/**
 * Exact integer micro-dollars. Spend arrives rounded to 6 decimals (repository) and limits carry
 * 2, so the comparison below is exact integer arithmetic, not float division (no 79.999… edges).
 */
const toMicros = (usd: number) => BigInt(Math.round(usd * 1_000_000));

const exactMicros = (spendUsd: number, limitUsd: number) => {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    throw new RangeError('limitUsd must be a positive finite number.');
  }
  if (!Number.isFinite(spendUsd)) throw new RangeError('spendUsd must be a finite number.');
  return { spend: toMicros(spendUsd), limit: toMicros(limitUsd) };
};

/** Highest threshold reached by `spend / limit` (in percent), or null below 80 %. */
export const crossedThreshold = (spendUsd: number, limitUsd: number): BudgetThreshold | null => {
  const { spend, limit } = exactMicros(spendUsd, limitUsd);
  if (spend >= limit) return 100;
  if (spend * 100n >= limit * 80n) return 80;
  return null;
};

/**
 * `spend / limit × 100`, exact (micro-dollars) and floored to 0.01 — never rounded up, so it
 * agrees with `crossedThreshold`: ≥ 80 exactly when 80 % is reached, ≥ 100 exactly at 100 %.
 */
export const percentOfLimit = (spendUsd: number, limitUsd: number): number => {
  const { spend, limit } = exactMicros(spendUsd, limitUsd);
  // Hundredths of a percent: spend × 100 × 100 / limit, floored (BigInt division truncates).
  const scaled = spend * 10_000n;
  let hundredths = scaled / limit;
  if (scaled % limit !== 0n && scaled < 0n) hundredths -= 1n;
  return Number(hundredths) / 100;
};
