import Link from 'next/link';
import { Card, CardHead, EmptyState, StatusPill } from '@javis-dog/ui/components';
import {
  claimInstallationAction,
  releaseInstallationAction,
} from '@/app/integrations/github/actions';
import { CLAIM_MESSAGES } from '@/app/integrations/github/messages';
import { UtcStamp } from '@/components/analytics/utc-stamp';
// Type only: lib/github reads env and the database on the server.
import type { GithubOverview } from '@/lib/github';
import { GithubActionButton } from './action-button';

// Claims on /integrations/github (ADR-0019 §4, design review D0 M5). Claimable installations are
// the viewer's own (account id from the signed webhook row = the viewer's linked GitHub id); the
// `installation_id` GitHub appends to the setup URL is never used here. Repository names are
// shown only for installations the viewer's workspace claimed.

export const NOT_REVERIFIABLE_TEXT =
  'Your GitHub account is no longer linked to your sign-in, so this claim can’t be re-verified. It stays in place until a workspace owner or admin releases it.';

export const OTHER_ACCOUNT_TEXT =
  'The GitHub account linked to your sign-in doesn’t own this installation, so this claim can’t be re-verified from here. It stays in place until a workspace owner or admin releases it.';

function Claimable({ overview }: { overview: GithubOverview }) {
  if (!overview.canManage)
    return (
      <p className="px-5 pt-4 text-xs text-muted">
        Only workspace owners and admins can claim installations.
      </p>
    );
  if (!overview.githubLinked)
    return <p className="px-5 pt-4 text-xs text-muted">{CLAIM_MESSAGES.no_github_account}</p>;
  if (overview.claimable.length === 0)
    return (
      <p className="px-5 pt-4 text-xs text-muted">
        No unclaimed installation of your GitHub account has reached Javi’s Dog. GitHub sends a
        signed notice right after you install the app; reload in a minute if you just did.
      </p>
    );
  return (
    <ul className="px-5 pt-3">
      {overview.claimable.map((i) => (
        <li
          key={i.installationId}
          className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0"
        >
          <p className="text-xs text-ink">
            Installation <span className="font-mono font-bold">{i.installationId}</span>
            {i.accountType === 'Organization' ? ' · organization' : ' · your personal account'}
          </p>
          {i.accountType === 'Organization' ? (
            <p className="w-full text-xs text-muted">{CLAIM_MESSAGES.organization}</p>
          ) : (
            <GithubActionButton
              action={claimInstallationAction}
              fields={{ installationId: String(i.installationId) }}
              label="Claim for this workspace"
              pendingLabel="Claiming…"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function Claimed({
  overview,
  projectNames,
}: {
  overview: GithubOverview;
  projectNames: ReadonlyMap<string, string>;
}) {
  return (
    <ul className="px-5 pt-3">
      {overview.installations.map((i) => (
        <li key={i.installationId} className="border-b border-line py-3 last:border-0">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs font-bold text-ink">
              Installation <span className="font-mono">{i.installationId}</span>
            </p>
            {i.suspendedAt ? <StatusPill tone="warn">Suspended on GitHub</StatusPill> : null}
          </div>
          <p className="mt-1 text-xs text-muted">
            {i.lastVerifiedDeliveryAt ? (
              <>
                Last verified delivery: <UtcStamp at={i.lastVerifiedDeliveryAt.toISOString()} />
              </>
            ) : (
              'No verified delivery yet.'
            )}
          </p>
          {!i.reverifiable ? (
            <p className="mt-1 text-xs font-bold text-ink">
              {overview.githubLinked ? OTHER_ACCOUNT_TEXT : NOT_REVERIFIABLE_TEXT}
            </p>
          ) : null}
          {i.repositories.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No repositories shared with the app yet.</p>
          ) : (
            <ul className="mt-2 grid gap-1">
              {i.repositories.map((r) => {
                const name = r.projectId ? projectNames.get(r.projectId) : undefined;
                return (
                  <li key={r.repoId} className="text-xs text-ink">
                    <span className="font-mono font-bold">{r.fullName}</span>{' '}
                    {r.projectId ? (
                      <>
                        · linked to{' '}
                        <Link href={`/projects/${r.projectId}`} className="underline">
                          {name ?? 'a project'}
                        </Link>
                      </>
                    ) : (
                      <span className="text-muted">· not linked (link it on a project page)</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {overview.canManage ? (
            <div className="mt-3">
              <GithubActionButton
                action={releaseInstallationAction}
                fields={{ installationId: String(i.installationId) }}
                label="Release claim"
                pendingLabel="Releasing…"
                tone="danger"
                note="Removes its repository links. It can be claimed again later."
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function GithubInstallationsCard({
  overview,
  projectNames,
}: {
  overview: GithubOverview;
  projectNames: ReadonlyMap<string, string>;
}) {
  return (
    <Card labelledBy="github-installations-title">
      <CardHead
        id="github-installations-title"
        title="Installations"
        subtitle="Claim your installation for this workspace, then link its repositories on project pages"
      />
      <h3 className="px-5 pt-4 text-[11px] font-bold tracking-wide text-muted uppercase">
        Claimed by this workspace
      </h3>
      {overview.installations.length === 0 ? (
        <EmptyState title="No claimed installation">
          A claimed installation and its repositories appear here.
        </EmptyState>
      ) : (
        <Claimed overview={overview} projectNames={projectNames} />
      )}
      <h3 className="px-5 pt-4 text-[11px] font-bold tracking-wide text-muted uppercase">
        Ready to claim
      </h3>
      <div className="pb-5">
        <Claimable overview={overview} />
      </div>
    </Card>
  );
}
