import type { Metadata } from 'next';
import { Card, CardHead, PageHead, RuleList } from '@javis-dog/ui/components';
import { AgentsView } from '@/components/dashboard/agents-view';
import { AgentsDashboard } from '@/components/dashboard/dashboards';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { dashboardDeps, loadDashboard } from '@/lib/dashboard';

export const metadata: Metadata = { title: 'Live agents' };
export const dynamic = 'force-dynamic';

const inspectorFields = [
  {
    n: '01',
    title: 'Heartbeat and freshness',
    body: 'Last heartbeat time and sequence number; the thread turns stale when heartbeats stop.',
  },
  {
    n: '02',
    title: 'Tool and task events',
    body: 'What the agent started and finished — names only; payloads are omitted by default.',
  },
  {
    n: '03',
    title: 'Token deltas',
    body: 'Input and output tokens per event, labelled estimated when the tool cannot report exact counts.',
  },
  {
    n: '04',
    title: 'Retries and delivery',
    body: 'Retry policy, backoff and idempotency keys, so duplicates never inflate your numbers.',
  },
] as const;

const inspector = (
  <Card labelledBy="inspector-title">
    <CardHead
      id="inspector-title"
      title="Thread inspector"
      subtitle="What each thread will show — JGR v0.1 draft"
    />
    <RuleList items={inspectorFields} />
  </Card>
);

// Live agents — "Why is this thread stuck?" First snapshot on the server, then a 10 s refresh
// in the browser (ADR-0012).
export default async function AgentsPage() {
  const load = await loadDashboard(dashboardDeps);
  return (
    <>
      <PageHead
        eyebrow="Live operations"
        title="Know what your agents are doing."
        description="Monitor active coding threads, catch stuck work and understand resource consumption at a glance."
      />
      {load.kind === 'not_configured' ? (
        <AgentsView snapshot={null} inspector={inspector} />
      ) : load.kind === 'signed_out' ? (
        <SignInPrompt what="your threads" />
      ) : (
        <AgentsDashboard
          initial={load.kind === 'ready' ? load.snapshot : null}
          inspector={inspector}
        />
      )}
    </>
  );
}
