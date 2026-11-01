import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHead } from '@javis-dog/ui/components';
import { GithubInstallationsCard } from '@/components/github/installations';
import { GithubSetupCard } from '@/components/github/setup-card';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { loadGithubOverview } from '@/lib/github';
import { getViewer } from '@/lib/viewer';

export const metadata: Metadata = { title: 'GitHub' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

// GitHub App setup (ADR-0019 §4, §7, §8). GitHub's `setup_url` appends `installation_id` and
// `setup_action`: they are a hint that the browser came back from GitHub and nothing more. They
// are never trusted, never shown and never claim anything (design review D0, ADR-0019 §4).
export default async function GithubIntegrationPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params: SearchParams = (await searchParams) ?? {};
  const backFromGithub = params.installation_id !== undefined || params.setup_action !== undefined;
  const viewer = await getViewer();
  const overview = await loadGithubOverview(viewer);
  // Project names for "linked to …", from the viewer's own workspace only.
  const projectNames = new Map<string, string>(
    viewer && overview.installations.length > 0
      ? (await viewer.projects.listProjects(viewer.workspaceId)).map((p) => [p.id, p.name])
      : [],
  );
  return (
    <>
      <PageHead
        eyebrow="JGR & Integrations"
        title="GitHub"
        description="Pull request and CI signals from your own repositories, for coding tools that send Javi’s Dog nothing themselves."
        actions={
          <Link href="/integrations" className="text-xs font-bold text-ink underline">
            All integrations
          </Link>
        }
      />
      <GithubSetupCard overview={overview} backFromGithub={backFromGithub} />
      {viewer ? (
        <GithubInstallationsCard overview={overview} projectNames={projectNames} />
      ) : (
        <SignInPrompt what="your GitHub installations" />
      )}
    </>
  );
}
