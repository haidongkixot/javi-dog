import Link from 'next/link';
import { loadGithubOverview, type GithubStatus } from '@/lib/github';
import { getViewer } from '@/lib/viewer';
import { GithubStatusLine } from './status';

// The GitHub row's status on /integrations (ADR-0019 §8, D0 M4): an async server component,
// streamed inside a Suspense boundary so the rest of the page does not wait for the database.

const readStatus = async (): Promise<GithubStatus> => {
  try {
    return (await loadGithubOverview(await getViewer())).status;
  } catch {
    // getViewer failed (session or membership read); loadGithubOverview logs its own failures.
    return { kind: 'unavailable' };
  }
};

export async function GithubDirectoryStatus() {
  const status = await readStatus();
  return (
    <div className="text-right">
      <GithubStatusLine status={status} />
      <Link
        href="/integrations/github"
        className="mt-1 inline-block text-[11px] font-bold underline"
      >
        GitHub setup
      </Link>
    </div>
  );
}
