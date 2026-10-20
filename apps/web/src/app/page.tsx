import Link from 'next/link';
import { Card, CardHead, EmptyState, Icon, MetricCard, PageHead } from '@javis-dog/ui/components';

// Overview — "What is happening now?" Every value stays empty until a verified JGR signal
// exists (product rules 2 and 4). No sample numbers are rendered.
export default function OverviewPage() {
  return (
    <>
      <PageHead
        eyebrow="Pack overview"
        title="Your pack is waiting for its first signal."
        description="A command center for your coding agents, projects and resource usage. Connect a coding tool and this page fills with verified, timestamped signals."
      />

      <section aria-label="Key metrics" className="grid grid-cols-4 gap-4 max-[1150px]:grid-cols-2">
        <MetricCard
          label="Active projects"
          value={null}
          icon={<Icon name="git" />}
          iconClassName="bg-accent-soft text-protocol"
        />
        <MetricCard
          label="Agents running"
          value={null}
          icon={<Icon name="bolt" />}
          iconClassName="bg-ok-bg text-ok"
        />
        <MetricCard
          label="Token burn rate"
          value={null}
          icon={<Icon name="trend" />}
          iconClassName="bg-warn-bg text-warn"
        />
        <MetricCard
          label="Tasks completed"
          value={null}
          icon={<Icon name="check" />}
          iconClassName="bg-info-bg text-info"
        />
      </section>

      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="usage-title">
          <CardHead
            id="usage-title"
            title="Token consumption"
            subtitle="Input, output and failed/retry tokens per day"
          />
          <EmptyState title="No usage data yet">
            Token deltas appear here once a connected thread reports them. Javi&apos;s Dog never
            estimates usage without labelling it as an estimate.
          </EmptyState>
        </Card>
        <Card labelledBy="activity-title">
          <CardHead
            id="activity-title"
            title="Live activity"
            subtitle="Recent signals from connected threads"
          />
          <EmptyState title="No signals received">
            Heartbeats, completed tasks and attention requests will stream in here, each with its
            source and time.
          </EmptyState>
        </Card>
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(260px,1fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="health-title">
          <CardHead
            id="health-title"
            title="Project health"
            subtitle="Work in progress across your pack"
          />
          <EmptyState
            title="No projects yet"
            action={
              <Link href="/projects" className="text-xs font-bold text-accent hover:underline">
                Go to Projects
              </Link>
            }
          >
            Project registration opens with sign-in in Sprint 2.
          </EmptyState>
        </Card>
        <Card labelledBy="squad-title">
          <CardHead id="squad-title" title="Agent squad" subtitle="Who is doing what right now" />
          <EmptyState
            title="No agents connected"
            action={
              <Link href="/integrations" className="text-xs font-bold text-accent hover:underline">
                See supported integrations
              </Link>
            }
          >
            Agents appear when a coding tool sends its first heartbeat.
          </EmptyState>
        </Card>
      </div>
    </>
  );
}
