// Deterministic budget wording (ADR-0014): fixed locale and UTC, so server and client render the
// same text. Every money value is an estimate and is always placed next to the word "estimated".

import type { BudgetThreshold } from '@javis-dog/resilience';
import type { StatusTone } from '@javis-dog/ui';
import { formatUsd } from '@/components/analytics/format';

export { formatUsd };

const numberFmt = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });
const monthYearFmt = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000Z`);

/** "October" for the UTC month key "2026-10". */
export const monthName = (month: string) => monthFmt.format(monthStart(month));
/** "October 2026" for the UTC month key "2026-10". */
export const monthLabel = (month: string) => monthYearFmt.format(monthStart(month));

/**
 * "81 %". Floored to a whole percent (JD-M12 already floors to 0.01, never rounding up), so a
 * value just under a threshold (79.99 %) never reads as the threshold while its badge is absent.
 */
export const percentText = (percentUsed: number) =>
  `${numberFmt.format(Math.floor(percentUsed))} %`;

/** "81 % of $10.00" — callers add "(estimated)" or an "estimated" label next to it. */
export const percentOfLimit = (percentUsed: number, limitUsd: number) =>
  `${percentText(percentUsed)} of ${formatUsd(limitUsd)}`;

/**
 * The non-colour threshold signal (ADR-0014): a text badge from JD-M12's `thresholdReached`
 * (exact micro-dollars, the same rule as the alerts) — never from the displayed percent.
 */
export const thresholdBadge = (
  threshold: BudgetThreshold | null,
): { tone: StatusTone; label: string } | null => {
  if (threshold === 100) return { tone: 'danger', label: 'Budget reached' };
  if (threshold === 80) return { tone: 'warn', label: '80 % reached' };
  return null;
};
