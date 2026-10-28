import { StatusPill } from '@javis-dog/ui/components';
// Type only: lib/budgets wires the server-side repository.
import type { BudgetsLoad } from '@/lib/budgets';
import { percentOfLimit, thresholdBadge } from './format';

// The "Budget" column of the Projects list (ADR-0014). Plain data, so the server page can pass
// it through the client projects table.

export type BudgetCellData =
  | { kind: 'none' }
  | { kind: 'set'; limitUsd: number; percentUsed: number }
  | { kind: 'not_loaded' };

/** The cell for one project from the workspace's budget statuses. */
export const toBudgetCell = (load: BudgetsLoad, projectId: string): BudgetCellData => {
  if (load.kind !== 'ready') return { kind: 'not_loaded' };
  const s = load.statuses.find((b) => b.projectId === projectId);
  return s && s.limitUsd !== null && s.percentUsed !== null
    ? { kind: 'set', limitUsd: s.limitUsd, percentUsed: s.percentUsed }
    : { kind: 'none' };
};

/** "62 % of $10.00 estimated" with a text badge at 80 % / 100 %, or "No budget". */
export function BudgetCell({ budget }: { budget: BudgetCellData | undefined }) {
  if (!budget) return <>—</>;
  if (budget.kind === 'not_loaded') return <>Not loaded</>;
  if (budget.kind === 'none') return <>No budget</>;
  const badge = thresholdBadge(budget.percentUsed);
  return (
    <span className="inline-flex items-center gap-2">
      {badge ? <StatusPill tone={badge.tone}>{badge.label}</StatusPill> : null}
      <span className="tabular-nums">
        {percentOfLimit(budget.percentUsed, budget.limitUsd)}{' '}
        <span className="text-muted">estimated</span>
      </span>
    </span>
  );
}
