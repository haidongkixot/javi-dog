'use client';

import { useActionState } from 'react';
import { clearBudgetAction, setBudgetAction, type BudgetActionState } from '@/app/projects/actions';

// Owners/admins only: the page renders this form for them, and the server actions check the
// role again (a member posting the action directly is refused and nothing is written).

const buttonPrimary =
  'rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary disabled:opacity-60';
const buttonSecondary =
  'rounded-control border border-line px-4 py-2.5 text-xs font-bold text-danger disabled:opacity-60';

function ErrorText({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  ) : null;
}

/** Set (or change) the monthly limit; with a current limit, also remove it. */
export function BudgetForm({
  projectId,
  limitUsd,
}: {
  projectId: string;
  /** The current limit, or null when the project has no budget. */
  limitUsd: number | null;
}) {
  const [state, action, pending] = useActionState<BudgetActionState, FormData>(setBudgetAction, {});
  const [cleared, clearAction, clearing] = useActionState<BudgetActionState, FormData>(
    clearBudgetAction,
    {},
  );
  const e = state.errors ?? {};
  const hasBudget = limitUsd !== null;
  const describedBy = ['budget-limit-hint', e.limitUsd ? 'budget-limit-error' : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="grid gap-3 px-5 pt-4 pb-5">
      <form action={action} className="flex flex-wrap items-end gap-3" noValidate>
        <input type="hidden" name="projectId" value={projectId} />
        <div>
          <label htmlFor="budget-limit" className="text-xs font-bold text-ink">
            {hasBudget ? 'New monthly limit (USD)' : 'Monthly limit (USD)'}
          </label>
          <input
            id="budget-limit"
            name="limitUsd"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            required
            defaultValue={hasBudget ? limitUsd.toFixed(2) : ''}
            placeholder="e.g. 25"
            className="block w-40 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink tabular-nums placeholder:text-muted"
            aria-invalid={Boolean(e.limitUsd)}
            aria-describedby={describedBy}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? 'Saving…' : hasBudget ? 'Save limit' : 'Set budget'}
        </button>
      </form>
      <p id="budget-limit-hint" className="text-xs text-muted">
        US dollars per UTC calendar month, up to 2 decimals, at most 1,000,000.
      </p>
      <ErrorText id="budget-limit-error" message={e.limitUsd} />
      <ErrorText id="budget-form-error" message={e.form} />
      {state.saved ? (
        <p role="status" className="text-xs text-ok">
          Budget saved.
        </p>
      ) : null}
      {hasBudget ? (
        <form action={clearAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="projectId" value={projectId} />
          <button type="submit" disabled={clearing} className={buttonSecondary}>
            {clearing ? 'Removing…' : 'Remove budget'}
          </button>
          <span className="text-xs text-muted">Alerts stop until a new limit is set.</span>
          <ErrorText id="budget-clear-error" message={cleared.errors?.form} />
        </form>
      ) : null}
    </div>
  );
}
