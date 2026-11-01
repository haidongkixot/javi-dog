'use client';

import { useActionState } from 'react';
import { linkRepositoryAction, type GithubActionState } from '@/app/integrations/github/actions';

// Link a repository of a claimed installation to this project (ADR-0019 §4). For an L1 or L2
// project the form warns that Javi's Dog will then know the repository's name, and asks for an
// explicit confirmation. The checkbox is only a convenience: the server action refuses an L1/L2
// link without `confirmRepoName=yes` whatever the browser sends.

export const repoNameWarning = (privacyClass: 'L1' | 'L2') =>
  `This project uses ${privacyClass}, which keeps repository names away from Javi’s Dog. Linking stores the name of the repository you pick (owner/repo) with this project, so Javi’s Dog will know it. Agent events keep their ${privacyClass} protection.`;

export function LinkRepositoryForm({
  projectId,
  privacyClass,
  repositories,
}: {
  projectId: string;
  privacyClass: 'L0' | 'L1' | 'L2';
  repositories: ReadonlyArray<{ repoId: number; fullName: string }>;
}) {
  const [state, action, pending] = useActionState<GithubActionState, FormData>(
    linkRepositoryAction,
    {},
  );
  const hidden = privacyClass !== 'L0';
  return (
    <form action={action} className="grid gap-3 px-5 pt-4 pb-5">
      <input type="hidden" name="projectId" value={projectId} />
      <div>
        <label htmlFor="github-link-repo" className="text-xs font-bold text-ink">
          Repository
        </label>
        <select
          id="github-link-repo"
          name="repoId"
          required
          className="mt-1 block w-full max-w-md rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          {repositories.map((r) => (
            <option key={r.repoId} value={String(r.repoId)}>
              {r.fullName}
            </option>
          ))}
        </select>
      </div>
      {hidden ? (
        <div className="rounded-control border border-line bg-warn-bg px-3 py-2.5 text-xs text-ink">
          <p id="github-link-warning">{repoNameWarning(privacyClass)}</p>
          <label className="mt-2 flex items-start gap-2 font-bold">
            <input
              type="checkbox"
              name="confirmRepoName"
              value="yes"
              required
              aria-describedby="github-link-warning"
            />
            <span>I understand that Javi’s Dog will know this repository’s name.</span>
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary disabled:opacity-60"
        >
          {pending ? 'Linking…' : 'Link repository'}
        </button>
        <span className="text-xs text-muted">One project per repository.</span>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p role="status" className="text-xs text-ok">
          {state.done}
        </p>
      ) : null}
    </form>
  );
}
