'use client';

import { useActionState } from 'react';
import type { GithubActionState } from '@/app/integrations/github/actions';

// One small form per GitHub action (claim, release, unlink). The page renders it for owners and
// admins only, and every server action checks the role again.

type Action = (prev: GithubActionState, form: FormData) => Promise<GithubActionState>;

const tones = {
  primary: 'rounded-control bg-primary px-3 py-1.5 text-xs font-bold text-on-primary',
  danger: 'rounded-control border border-line px-3 py-1.5 text-xs font-bold text-danger',
} as const;

export function GithubActionButton({
  action,
  fields,
  label,
  pendingLabel,
  tone = 'primary',
  note,
}: {
  action: Action;
  fields: Record<string, string>;
  label: string;
  pendingLabel: string;
  tone?: keyof typeof tones;
  /** A short line next to the button (what the action does). */
  note?: string;
}) {
  const [state, formAction, pending] = useActionState<GithubActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" disabled={pending} className={`${tones[tone]} disabled:opacity-60`}>
        {pending ? pendingLabel : label}
      </button>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
      {state.error ? (
        <p role="alert" className="w-full text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p role="status" className="w-full text-xs text-ok">
          {state.done}
        </p>
      ) : null}
    </form>
  );
}
