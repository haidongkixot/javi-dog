import { Card, CardHead } from '@javis-dog/ui/components';
// Type only: lib/github reads env and the database on the server.
import type { GithubOverview } from '@/lib/github';
import { GithubStatusLine, OWNER_ONLY_TEXT } from './status';

// Setup and status for /integrations/github (ADR-0019 §7, §8; design review D0 H1, L2). The
// install link appears only for the deployment's owner (`overview.installUrl`), because a private
// GitHub App can be installed only on the account that created it.

export const SELECT_REPOSITORIES_TEXT =
  'On GitHub, choose “Only select repositories” and pick just the ones you want here. Javi’s Dog learns the names of the repositories you select.';

export function GithubSetupCard({
  overview,
  backFromGithub,
}: {
  overview: GithubOverview;
  /** GitHub sent the browser back here after an install. A hint only: nothing is claimed. */
  backFromGithub: boolean;
}) {
  const { status, installUrl, isAppOwner } = overview;
  return (
    <Card labelledBy="github-setup-title">
      <CardHead
        id="github-setup-title"
        title="Status and setup"
        subtitle="Nothing from GitHub counts until a signed delivery is verified"
      />
      <div className="px-5 pt-4 text-xs">
        <GithubStatusLine status={status} />
      </div>
      <div className="grid gap-3 px-5 pt-4 pb-5 text-xs leading-relaxed text-ink">
        {status.kind === 'not_set_up' ? (
          <p>
            The deployment’s owner creates the GitHub App with the local helper and adds its webhook
            secret to this deployment. Until then, Javi’s Dog accepts nothing from GitHub.
          </p>
        ) : installUrl ? (
          <>
            <p>{SELECT_REPOSITORIES_TEXT}</p>
            <p>
              <a
                href={installUrl}
                rel="noopener noreferrer"
                className="inline-block rounded-control bg-primary px-4 py-2.5 font-bold text-on-primary"
              >
                Install the app on GitHub
              </a>
            </p>
          </>
        ) : isAppOwner ? (
          <p>The install link needs the app’s public slug on this deployment.</p>
        ) : (
          <p>{OWNER_ONLY_TEXT}</p>
        )}
        {backFromGithub && status.kind !== 'not_set_up' ? (
          <p role="status" className="text-muted">
            Back from GitHub. If your installation is not listed below yet, reload in a minute:
            Javi’s Dog waits for GitHub’s signed notice before it can be claimed.
          </p>
        ) : null}
        <p className="text-muted">
          The app reads pull requests, checks and Actions runs, never your code. Javi’s Dog keeps
          outcomes, state changes and timings; never titles, commit messages, branch names or
          logins.
        </p>
      </div>
    </Card>
  );
}
