'use client';

import { useActionState, useState } from 'react';
import { issueTokenAction, type IssueTokenState } from '@/app/projects/actions';

export function IssueTokenForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<IssueTokenState, FormData>(
    issueTokenAction.bind(null, projectId),
    {},
  );
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3 px-5 pt-4 pb-5">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="token-name" className="text-xs font-bold text-ink">
            Token name
          </label>
          <input
            id="token-name"
            name="name"
            maxLength={80}
            placeholder="e.g. laptop"
            className="w-56 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary disabled:opacity-60"
        >
          {pending ? 'Issuing…' : 'Issue token'}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      {state.token ? (
        <div role="status" className="rounded-control border border-line bg-surface-subtle p-3">
          <p className="text-xs font-bold text-ink">
            Copy this token now — it won’t be shown again.
          </p>
          <code className="mt-2 block font-mono text-xs break-all text-ink">{state.token}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(state.token!);
              setCopied(true);
            }}
            className="mt-2 rounded-control border border-line px-3 py-1.5 text-xs font-bold text-ink"
          >
            {copied ? 'Copied' : 'Copy token'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
