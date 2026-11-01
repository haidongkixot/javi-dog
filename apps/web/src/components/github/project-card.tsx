import Link from 'next/link';
import { Card, CardHead } from '@javis-dog/ui/components';
import { unlinkRepositoryAction } from '@/app/integrations/github/actions';
// Type only: lib/github reads env and the database on the server.
import type { GithubOverview } from '@/lib/github';
import { GithubActionButton } from './action-button';
import { LinkRepositoryForm } from './link-form';
import { GithubStatusLine, OWNER_ONLY_TEXT } from './status';

// Project page GitHub card (ADR-0019 §4, design review D0 H1, H3). Repository names come only
// from installations the viewer's workspace claimed (`workspaceInstallations`), so they are shown
// to members of that workspace only. Owners and admins link and unlink; members read.

const setupLink = (
  <Link href="/integrations/github" className="font-bold text-ink underline">
    GitHub setup
  </Link>
);

export function GithubProjectCard({
  overview,
  projectId,
  privacyClass,
}: {
  overview: GithubOverview;
  projectId: string;
  privacyClass: 'L0' | 'L1' | 'L2';
}) {
  const { status, installations, canManage } = overview;
  const repos = installations.flatMap((i) => i.repositories);
  const linked = repos.filter((r) => r.projectId === projectId);
  const available = repos.filter((r) => r.projectId === null);
  return (
    <Card labelledBy="github-title">
      <CardHead
        id="github-title"
        title="GitHub"
        subtitle="Pull request and CI signals for this project from the GitHub App. It has no access to your code."
      />
      <div className="px-5 pt-4 text-xs">
        <GithubStatusLine status={status} />
      </div>
      {status.kind === 'not_set_up' || status.kind === 'unavailable' ? (
        <p className="px-5 pt-3 pb-5 text-xs text-muted">See {setupLink} for what it needs.</p>
      ) : status.kind === 'owner_only' ? (
        <p className="px-5 pt-3 pb-5 text-xs text-muted">{OWNER_ONLY_TEXT}</p>
      ) : installations.length === 0 ? (
        <p className="px-5 pt-3 pb-5 text-xs text-muted">
          This workspace has not claimed a GitHub installation yet. Start on the {setupLink} page.
        </p>
      ) : (
        <>
          {linked.length === 0 ? (
            <p className="px-5 pt-3 text-xs text-muted">No repository is linked to this project.</p>
          ) : (
            <ul className="px-5 pt-3">
              {linked.map((r) => (
                <li
                  key={r.repoId}
                  className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-0"
                >
                  <p className="text-xs text-ink">
                    Linked to <span className="font-mono font-bold">{r.fullName}</span>
                  </p>
                  {canManage ? (
                    <GithubActionButton
                      action={unlinkRepositoryAction}
                      fields={{ repoId: String(r.repoId), projectId }}
                      label="Unlink"
                      pendingLabel="Unlinking…"
                      tone="danger"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {!canManage ? (
            <p className="px-5 pt-3 pb-5 text-xs text-muted">
              Only workspace owners and admins can link or unlink repositories.
            </p>
          ) : available.length > 0 ? (
            <LinkRepositoryForm
              projectId={projectId}
              privacyClass={privacyClass}
              repositories={available}
            />
          ) : (
            <p className="px-5 pt-3 pb-5 text-xs text-muted">
              No unlinked repository is available. Each repository belongs to one project; to add
              one, choose it in the app’s repository access on GitHub.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
