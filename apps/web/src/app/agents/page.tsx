import type { Metadata } from 'next';
import {
  Card,
  CardHead,
  EmptyState,
  Icon,
  MetricCard,
  PageHead,
  RuleList,
} from '@javis-dog/ui/components';

export const metadata: Metadata = { title: 'Live agents' };

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

// Live agents — "Why is this thread stuck?"
export default function AgentsPage() {
  return (
    <>
      <PageHead
        eyebrow="Live operations"
        title="Know what your agents are doing."
        description="Monitor active coding threads, catch stuck work and understand resource consumption at a glance."
      />
      <section
        aria-label="Thread metrics"
        className="grid grid-cols-4 gap-4 max-[1150px]:grid-cols-2"
      >
        <MetricCard
          label="Running threads"
          value={null}
          icon={<Icon name="bolt" />}
          iconClassName="bg-ok-bg text-ok"
        />
        <MetricCard
          label="Avg. first response"
          value={null}
          icon={<Icon name="clock" />}
          iconClassName="bg-info-bg text-info"
        />
        <MetricCard
          label="Retries this hour"
          value={null}
          icon={<Icon name="alert" />}
          iconClassName="bg-danger-bg text-danger"
        />
        <MetricCard
          label="Budget guardrails"
          value={null}
          icon={<Icon name="lock" />}
          iconClassName="bg-accent-soft text-protocol"
        />
      </section>
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="threads-title">
          <CardHead
            id="threads-title"
            title="Thread monitor"
            subtitle="Choose a thread to see its event timeline"
          />
          <EmptyState title="No threads connected">
            Threads from Claude Code, Codex and Gemini CLI appear here once their collector is set
            up.
          </EmptyState>
        </Card>
        <Card labelledBy="inspector-title">
          <CardHead
            id="inspector-title"
            title="Thread inspector"
            subtitle="What each thread will show — JGR v0.1 draft"
          />
          <RuleList items={inspectorFields} />
        </Card>
      </div>
    </>
  );
}
