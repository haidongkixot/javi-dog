import type { BudgetStatus } from '@javis-dog/resilience';
import { Card, CardHead, EmptyState, StatusPill } from '@javis-dog/ui/components';
import { estimatedNote, formatTokens } from '@/components/analytics/format';
import { UtcStamp } from '@/components/analytics/utc-stamp';
// Type only: lib/budgets wires the server-side repository.
import type { BudgetLoad } from '@/lib/budgets';
import { BudgetForm } from './budget-form';
import { formatUsd, monthLabel, monthName, percentOfLimit, thresholdBadge } from './format';

// Project budget card (ADR-0014). Server-rendered per visit, no polling: it says when it was
// computed. Every money value sits next to the word "estimated" (cost is producer-reported,
// ADR-0011). The percent bar always carries text, and thresholds add a text badge, so nothing
// depends on colour alone.

export const ALERT_RECIPIENTS_TEXT =
  'Workspace owners get one email at 80 % and at 100 % each month.';

const barTone = (percentUsed: number) =>
  percentUsed >= 100 ? 'bg-danger' : percentUsed >= 80 ? 'bg-warn' : 'bg-ok';

function PercentBar({ percentUsed, limitUsd }: { percentUsed: number; limitUsd: number }) {
  const width = Math.min(Math.max(percentUsed, 0), 100);
  return (
    <div className="px-5 pt-4">
      {/* Decorative: the same information is the visible text below. */}
      <div
        aria-hidden
        className="h-2.5 overflow-hidden rounded-pill border border-line bg-surface-subtle"
      >
        <div className={`h-full ${barTone(percentUsed)}`} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-xs font-bold text-ink tabular-nums">
        {percentOfLimit(percentUsed, limitUsd)} (estimated)
      </p>
    </div>
  );
}

function Forecast({ status: s, limitUsd }: { status: BudgetStatus; limitUsd: number }) {
  if (s.forecastUsd === null)
    return (
      <p className="px-5 pt-3 text-xs text-muted">
        Too early to forecast — check back after the first day of the month.
      </p>
    );
  return (
    <p className="px-5 pt-3 text-xs text-ink tabular-nums">
      Forecast for {monthName(s.month)}: {formatUsd(s.forecastUsd)} (estimated)
      {s.forecastUsd > limitUsd ? ` — above the ${formatUsd(limitUsd)} limit` : ''}
    </p>
  );
}

/** Which alerts went out this month; 100 % covers 80 % when both are crossed together. */
const alertsText = (alerted: readonly number[]) => {
  if (alerted.includes(100))
    return 'Owners were emailed at 100 % this month (this covers the 80 % alert).';
  if (alerted.includes(80)) return 'Owners were emailed at 80 % this month.';
  return 'No budget alerts this month.';
};

function Meta({ status: s }: { status: BudgetStatus }) {
  const note = estimatedNote(s);
  return (
    <>
      {note ? <p className="px-5 pt-3 text-xs text-muted">{note}</p> : null}
      <p className="flex flex-wrap gap-x-1.5 px-5 pt-3 text-xs text-muted">
        <span>
          From {formatTokens(s.reports)} usage {s.reports === 1 ? 'report' : 'reports'} this month
        </span>
        <span aria-hidden>·</span>
        <span>
          Computed <UtcStamp at={s.generatedAt} seconds />
        </span>
      </p>
    </>
  );
}

function BudgetSet({
  status: s,
  limitUsd,
  percentUsed,
  canEdit,
}: {
  status: BudgetStatus;
  limitUsd: number;
  percentUsed: number;
  canEdit: boolean;
}) {
  return (
    <>
      <dl className="px-5 pt-4">
        <dt className="text-xs font-semibold text-muted">
          Estimated spend, {monthLabel(s.month)} (UTC)
        </dt>
        <dd className="mt-1 text-lg leading-tight font-extrabold tracking-tight text-ink tabular-nums">
          {formatUsd(s.spendUsd)}{' '}
          <span className="text-sm font-semibold text-muted">of {formatUsd(limitUsd)}</span>
        </dd>
      </dl>
      <PercentBar percentUsed={percentUsed} limitUsd={limitUsd} />
      <Forecast status={s} limitUsd={limitUsd} />
      <Meta status={s} />
      <div className="mx-5 mt-4 rounded-control border border-line bg-surface-subtle px-3 py-2.5 text-xs">
        <p className="font-bold text-ink">{alertsText(s.alerted)}</p>
        <p className="mt-1 text-muted">{ALERT_RECIPIENTS_TEXT}</p>
      </div>
      {canEdit ? (
        <BudgetForm projectId={s.projectId} limitUsd={limitUsd} />
      ) : (
        <p className="px-5 pt-3 pb-5 text-xs text-muted">
          Only workspace owners and admins can change this budget.
        </p>
      )}
    </>
  );
}

/** Month-to-date spend is known even without a limit; it helps pick one. */
function SpendSoFar({ status: s, className }: { status: BudgetStatus; className: string }) {
  return (
    <p className={`px-5 text-xs text-ink tabular-nums ${className}`}>
      Estimated spend so far in {monthLabel(s.month)} (UTC): {formatUsd(s.spendUsd)}
    </p>
  );
}

function NoBudget({ status: s, canEdit }: { status: BudgetStatus; canEdit: boolean }) {
  if (!canEdit)
    return (
      <>
        <EmptyState title="No budget set">
          Workspace owners and admins can set a monthly limit for this project.
        </EmptyState>
        <SpendSoFar status={s} className="pb-5" />
      </>
    );
  return (
    <>
      <p className="max-w-prose px-5 pt-4 text-xs leading-relaxed text-muted">
        Set a monthly limit in US dollars. Spend is estimated from the cost your agents report and
        counted per UTC calendar month. {ALERT_RECIPIENTS_TEXT}
      </p>
      <SpendSoFar status={s} className="pt-3" />
      <BudgetForm projectId={s.projectId} limitUsd={null} />
    </>
  );
}

/** Body and header of the Project detail budget card. */
export function BudgetCard({ load, canEdit }: { load: BudgetLoad; canEdit: boolean }) {
  const status = load.kind === 'ready' ? load.status : null;
  const limitUsd = status?.limitUsd ?? null;
  const percentUsed = status?.percentUsed ?? null;
  const badge = thresholdBadge(limitUsd === null ? null : percentUsed);
  return (
    <Card labelledBy="budget-title">
      <CardHead
        id="budget-title"
        title="Monthly budget"
        subtitle="Estimated spend against a monthly limit, per UTC calendar month"
        aside={badge ? <StatusPill tone={badge.tone}>{badge.label}</StatusPill> : undefined}
      />
      {load.kind === 'unavailable' ? (
        <EmptyState title="Budget could not be loaded">
          Reading the budget failed. Reload the page to try again.
        </EmptyState>
      ) : load.kind === 'signed_out' ? (
        <EmptyState title="Sign in to see this budget">
          Budgets belong to your workspace, so they need a signed-in session.
        </EmptyState>
      ) : !status ? (
        <EmptyState title="Budgets are not available">
          Budgets need a database, and this deployment has none configured.
        </EmptyState>
      ) : limitUsd === null || percentUsed === null ? (
        <NoBudget status={status} canEdit={canEdit} />
      ) : (
        <BudgetSet
          status={status}
          limitUsd={limitUsd}
          percentUsed={percentUsed}
          canEdit={canEdit}
        />
      )}
    </Card>
  );
}
