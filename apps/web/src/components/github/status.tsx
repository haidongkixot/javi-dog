import type { StatusTone } from '@javis-dog/ui';
import { StatusPill } from '@javis-dog/ui/components';
import { UtcStamp } from '@/components/analytics/utc-stamp';
// Type only: lib/github reads env and the database on the server.
import type { GithubStatus } from '@/lib/github';

// Honest GitHub labels (ADR-0019 §8, design review D0 H1, M4, review M-2). "Connected" appears
// only with the time of the last verified delivery, from the last 7 days, for an unsuspended
// installation the viewer's workspace claimed; older evidence reads "No verified delivery since".
// The copy never says "live" or "secure" (CLAUDE.md §3).

export const OWNER_ONLY_TEXT = 'GitHub is available only to this deployment’s owner.';

export const githubStatusLabel = (
  status: GithubStatus,
): { label: string; tone: StatusTone; detail: string } => {
  switch (status.kind) {
    case 'not_set_up':
      return {
        label: 'GitHub: not set up',
        tone: 'info',
        detail:
          'This deployment has no GitHub App webhook secret yet, so nothing from GitHub can be verified.',
      };
    case 'owner_only':
      return {
        label: 'Owner only',
        tone: 'info',
        detail: `${OWNER_ONLY_TEXT} The app is private to the GitHub account that created it.`,
      };
    case 'waiting':
      return {
        label: 'Waiting for the first delivery',
        tone: 'warn',
        detail: status.claimed
          ? 'The installation is claimed. Nothing verified has arrived from GitHub yet: a pull request or CI run on a linked repository sends the first one.'
          : 'Install the app on your GitHub account, then claim the installation here.',
      };
    case 'suspended':
      return {
        label: 'Suspended on GitHub',
        tone: 'warn',
        detail:
          'The claimed installation is suspended on GitHub, so its deliveries are ignored until it is unsuspended.',
      };
    case 'connected':
      return {
        label: 'Connected',
        tone: 'ok',
        detail: 'Last verified delivery from GitHub',
      };
    case 'stale':
      return {
        // The pill adds the UTC time of the last verified delivery.
        label: 'No verified delivery since',
        tone: 'warn',
        detail:
          'Nothing verified for over 7 days. Check that the webhook secret matches the app’s, and look at Recent Deliveries on GitHub.',
      };
    case 'unavailable':
      return {
        label: 'Status unavailable',
        tone: 'warn',
        detail: 'Reading the GitHub status failed. Reload the page to try again.',
      };
  }
};

/** Pill plus one line of detail; "Connected" and the stale label carry the delivery time. */
export function GithubStatusLine({ status }: { status: GithubStatus }) {
  const { label, tone, detail } = githubStatusLabel(status);
  return (
    <div>
      <StatusPill tone={tone}>
        {label}
        {status.kind === 'stale' ? (
          <>
            {' '}
            <UtcStamp at={status.at.toISOString()} />
          </>
        ) : null}
      </StatusPill>
      <p className="mt-1 text-[11px] text-muted">
        {detail}
        {status.kind === 'connected' ? (
          <>
            : <UtcStamp at={status.at.toISOString()} />
          </>
        ) : null}
      </p>
    </div>
  );
}
