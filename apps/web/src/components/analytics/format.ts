// Deterministic formatting for usage analytics (fixed locale, UTC), so server and client render
// the same text. Days are UTC calendar dates (YYYY-MM-DD, ADR-0013).

const numberFmt = new Intl.NumberFormat('en');
const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const usdFmt = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const fullDayFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

const utcDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export const formatTokens = (n: number) => numberFmt.format(n);

/** Axis ticks and the peak label: 0 / 1K / 2.5K / 1.2M. */
export const compactTokens = (n: number) => compactFmt.format(n);

/**
 * "$12.34"; a positive amount under one cent reads "< $0.01" instead of a misleading "$0.00".
 * Callers always place it next to an "estimated" label (ADR-0013).
 */
export const formatUsd = (n: number) =>
  n > 0 && n < 0.005 ? `< ${usdFmt.format(0.01)}` : usdFmt.format(n);

/** "28 Oct" */
export const shortDay = (day: string) => dayFmt.format(utcDate(day));
/** "28 Oct 2026" */
export const fullDay = (day: string) => fullDayFmt.format(utcDate(day));
/** "28" — x-axis day of month */
export const dayOfMonth = (day: string) => String(utcDate(day).getUTCDate());
/** "Oct" */
export const monthOf = (day: string) => monthFmt.format(utcDate(day));

/** "15 Oct – 28 Oct 2026" for an inclusive UTC range. */
export const rangeLabel = (from: string, to: string) =>
  from === to ? fullDay(to) : `${shortDay(from)} – ${fullDay(to)}`;

/**
 * A clean axis maximum and its ticks (0 excluded): steps of 1, 2, 2.5 or 5 × 10^k, about four
 * gridlines. Tokens are whole numbers, so a step is never below 1. `max` must be > 0.
 */
export const niceTicks = (max: number, target = 4): { top: number; ticks: number[] } => {
  const raw = Math.max(max / target, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => Number.isInteger(s) && s >= raw) ??
    10 * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = step; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top, ticks };
};
