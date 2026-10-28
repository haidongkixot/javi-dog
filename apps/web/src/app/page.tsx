import { PageHead } from '@javis-dog/ui/components';
import { OverviewDashboard } from '@/components/dashboard/dashboards';
import { OverviewView } from '@/components/dashboard/overview-view';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { analyticsDeps, loadUsage } from '@/lib/analytics';
import { dashboardDeps, loadDashboard } from '@/lib/dashboard';

export const dynamic = 'force-dynamic';

// Overview — "What is happening now?" The first snapshot is read on the server; the client
// refreshes it every 10 s (ADR-0012). The 14-day usage is read alongside, once per visit
// (ADR-0013: daily aggregates need no polling). Without a database every value stays empty: no
// sample numbers are ever rendered (product rules 2 and 4).
export default async function OverviewPage() {
  // One session lookup shared by both reads; each still decides "not configured" first.
  let viewer: ReturnType<typeof dashboardDeps.getViewer> | undefined;
  const getViewer = () => (viewer ??= dashboardDeps.getViewer());
  const [load, usage] = await Promise.all([
    loadDashboard({ ...dashboardDeps, getViewer }),
    loadUsage({ ...analyticsDeps, getViewer }),
  ]);
  if (load.kind === 'not_configured') return <OverviewView snapshot={null} />;
  if (load.kind === 'signed_out')
    return (
      <>
        <PageHead
          eyebrow="Pack overview"
          title="Your pack is waiting for you."
          description="A command center for your coding agents, projects and resource usage. Every value shows when its last signal arrived."
        />
        <SignInPrompt what="your pack’s signals" />
      </>
    );
  return <OverviewDashboard initial={load.kind === 'ready' ? load.snapshot : null} usage={usage} />;
}
