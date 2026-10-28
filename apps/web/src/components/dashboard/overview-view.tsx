import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Counter, DashboardSnapshot, ThreadState } from '@javis-dog/realtime';
import { Card, CardHead, EmptyState, Icon, MetricCard, PageHead } from '@javis-dog/ui/components';
import { attentionHeadline, byAttention, formatNumber, windowLabel } from './format';
import { FreshnessLabel, SignalTime, ThreadRef, ThreadStatusPill } from './signal';

const linkClass = 'text-xs font-bold text-accent hover:underline';

const DEFAULT_DESCRIPTION =
  'A command center for your coding agents, projects and resource usage. Connect a coding tool and this page fills with verified, timestamped signals.';

const counterFreshness = (at: string, s: DashboardSnapshot) =>
  Date.parse(s.generatedAt) - Date.parse(at) <= s.freshnessWindowMs ? 'fresh' : 'stale';

function CounterMeta({
  counter,
  snapshot,
  none,
}: {
  counter: Counter;
  snapshot: DashboardSnapshot;
  none: string;
}) {
  if (!counter.lastSignalAt) return <>{none}</>;
  return (
    <FreshnessLabel
      freshness={counterFreshness(counter.lastSignalAt, snapshot)}
      at={counter.lastSignalAt}
      now={snapshot.generatedAt}
    />
  );
}

function headline(s: DashboardSnapshot | null) {
  if (!s || s.threads.length === 0)
    return {
      title: 'Your pack is waiting for its first signal.',
      description: DEFAULT_DESCRIPTION,
    };
  const attention = s.threads.filter((t) => t.attention).length;
  const description =
    'Every value shows when its last signal arrived. Threads turn stale after ' +
    `${windowLabel(s.freshnessWindowMs)} without a signal.`;
  if (attention > 0) return { title: attentionHeadline(attention), description };
  if (s.threads.some((t) => t.freshness === 'fresh'))
    return { title: 'Your pack is in motion.', description };
  return { title: 'Your pack is quiet right now.', description };
}

function Metrics({ snapshot: s }: { snapshot: DashboardSnapshot | null }) {
  const o = s?.overview;
  // Before any thread has signalled, a count would claim a measurement that never happened.
  const show = (c: Counter | undefined) =>
    s && c && (s.threads.length > 0 || c.lastSignalAt) ? formatNumber(c.value) : null;
  const tokens = o?.tokensLastHour;
  const freshWindow = s ? windowLabel(s.freshnessWindowMs) : '';
  return (
    <section aria-label="Key metrics" className="grid grid-cols-4 gap-4 max-[1150px]:grid-cols-2">
      <MetricCard
        label="Active projects"
        value={show(o?.activeProjects)}
        meta={
          s && o ? (
            <CounterMeta
              counter={o.activeProjects}
              snapshot={s}
              none={`No project sent a signal in the last ${freshWindow}`}
            />
          ) : null
        }
        icon={<Icon name="git" />}
        iconClassName="bg-accent-soft text-protocol"
      />
      <MetricCard
        label="Agents working"
        value={show(o?.agentsWorking)}
        meta={
          s && o ? (
            <CounterMeta
              counter={o.agentsWorking}
              snapshot={s}
              none={`No thread reported working in the last ${freshWindow}`}
            />
          ) : null
        }
        icon={<Icon name="bolt" />}
        iconClassName="bg-ok-bg text-ok"
      />
      <MetricCard
        label="Token burn rate"
        // Zero reports is "unknown", not "zero tokens": never show a bare 0 (ADR-0012).
        value={s && tokens ? (tokens.reports > 0 ? formatNumber(tokens.value) : '—') : null}
        {...(tokens && tokens.reports > 0 && { unit: 'tokens/h' })}
        meta={
          s && tokens ? (
            tokens.reports > 0 && tokens.lastSignalAt ? (
              <span className="flex flex-col gap-1">
                <span>
                  From {formatNumber(tokens.reports)} usage{' '}
                  {tokens.reports === 1 ? 'report' : 'reports'} in the last hour
                </span>
                <CounterMeta counter={tokens} snapshot={s} none="" />
              </span>
            ) : (
              'No usage reports yet'
            )
          ) : null
        }
        icon={<Icon name="trend" />}
        iconClassName="bg-warn-bg text-warn"
      />
      <MetricCard
        label="Tasks completed"
        value={show(o?.tasksCompleted24h)}
        meta={
          s && o ? (
            o.tasksCompleted24h.lastSignalAt ? (
              <span className="text-muted">
                In {s.windowHours} h · last{' '}
                <SignalTime at={o.tasksCompleted24h.lastSignalAt} now={s.generatedAt} />
              </span>
            ) : (
              `None in the last ${s.windowHours} h`
            )
          ) : null
        }
        icon={<Icon name="check" />}
        iconClassName="bg-info-bg text-info"
      />
    </section>
  );
}

function Activity({ snapshot: s }: { snapshot: DashboardSnapshot }) {
  if (s.activity.length === 0)
    return (
      <EmptyState title="No signals received">
        Heartbeats, completed tasks and attention requests appear here, each with its source and
        time.
      </EmptyState>
    );
  return (
    <ol aria-label="Recent signals" className="px-5 pt-2 pb-4">
      {s.activity.map((a, i) => (
        <li
          key={`${a.at}-${a.threadRef}-${a.type}-${i}`}
          className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-0"
        >
          <div className="min-w-0">
            <p className="truncate font-mono text-xs font-bold text-ink">
              {a.type}
              {a.toolName ? <span className="font-normal text-muted"> · {a.toolName}</span> : null}
            </p>
            <p className="mt-1 truncate text-xs text-muted">
              {a.projectSlug} · <ThreadRef value={a.threadRef} />
            </p>
          </div>
          <div className="flex flex-none flex-col items-end gap-1 text-xs text-muted">
            {a.status ? <ThreadStatusPill status={a.status} /> : null}
            <SignalTime at={a.at} now={s.generatedAt} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function ProjectHealthList({ snapshot: s }: { snapshot: DashboardSnapshot }) {
  if (s.projects.length === 0)
    return (
      <EmptyState
        title="No projects yet"
        action={
          <Link href="/projects" className={linkClass}>
            Go to Projects
          </Link>
        }
      >
        Create a project and issue an ingest token to start receiving signals.
      </EmptyState>
    );
  const projects = [...s.projects].sort((a, b) => b.attentionThreads - a.attentionThreads);
  return (
    <ul className="px-5 pt-2 pb-4">
      {projects.map((p) => (
        <li
          key={p.id}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2.5 last:border-0"
        >
          <div className="min-w-0">
            <Link href={`/projects/${p.id}`} className="text-xs font-bold text-ink underline">
              {p.name}
            </Link>
            <p className="mt-1 text-xs">
              <FreshnessLabel freshness={p.freshness} at={p.lastSignalAt} now={s.generatedAt} />
            </p>
          </div>
          <div className="flex flex-none items-center gap-2 text-xs text-muted tabular-nums">
            {p.attentionThreads > 0 ? <ThreadStatusPill status="waiting" /> : null}
            <span>
              {p.freshThreads} fresh {p.freshThreads === 1 ? 'thread' : 'threads'}
              {p.attentionThreads > 0 ? ` · ${p.attentionThreads} need you` : ''}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SquadMember({ t, now }: { t: ThreadState; now: string }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 border-b border-line py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-xs font-bold text-ink">{t.projectName}</p>
        <p className="mt-1 truncate text-xs text-muted">
          <ThreadRef value={t.threadRef} /> · {t.agents} {t.agents === 1 ? 'agent' : 'agents'}
        </p>
      </div>
      <div className="flex flex-none flex-col items-end gap-1 text-xs">
        <ThreadStatusPill status={t.status} />
        <FreshnessLabel freshness={t.freshness} at={t.lastSignalAt} now={now} />
      </div>
    </li>
  );
}

function Squad({ snapshot: s }: { snapshot: DashboardSnapshot }) {
  if (s.threads.length === 0)
    return (
      <EmptyState
        title="No agents connected"
        action={
          <Link href="/integrations" className={linkClass}>
            See supported integrations
          </Link>
        }
      >
        Agents appear when a coding tool sends its first heartbeat.
      </EmptyState>
    );
  // Fresh threads plus any thread waiting for you, even if it went quiet (ADR-0012).
  const squad = s.threads.filter((t) => t.freshness === 'fresh' || t.attention).sort(byAttention);
  if (squad.length === 0)
    return (
      <EmptyState
        title="No fresh threads"
        action={
          <Link href="/agents" className={linkClass}>
            See all threads
          </Link>
        }
      >
        No thread sent a signal in the last {windowLabel(s.freshnessWindowMs)}. Stale and ended
        threads stay listed under Live agents.
      </EmptyState>
    );
  return (
    <ul aria-label="Fresh threads" className="px-5 pt-2 pb-4">
      {squad.map((t) => (
        <SquadMember key={`${t.projectId}-${t.threadRef}`} t={t} now={s.generatedAt} />
      ))}
    </ul>
  );
}

/**
 * Overview — "What is happening now?" With `snapshot === null` (no database) it renders the
 * honest empty page: every value stays empty until a verified JGR signal exists.
 */
export function OverviewView({
  snapshot: s,
  notice,
}: {
  snapshot: DashboardSnapshot | null;
  notice?: ReactNode;
}) {
  const head = headline(s);
  return (
    <>
      <PageHead eyebrow="Pack overview" title={head.title} description={head.description} />
      {notice}
      <Metrics snapshot={s} />

      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="usage-title">
          <CardHead
            id="usage-title"
            title="Token consumption"
            subtitle="Input, output and failed/retry tokens per day"
          />
          {s ? (
            <EmptyState title="Charts arrive with usage analytics">
              Daily token charts are not built yet. Until then, the token burn card above sums the
              usage reports of the last hour. Javi&apos;s Dog never estimates usage without
              labelling it as an estimate.
            </EmptyState>
          ) : (
            <EmptyState title="No usage data yet">
              Token deltas appear here once a connected thread reports them. Javi&apos;s Dog never
              estimates usage without labelling it as an estimate.
            </EmptyState>
          )}
        </Card>
        <Card labelledBy="activity-title">
          <CardHead
            id="activity-title"
            title="Live activity"
            subtitle={
              !s
                ? 'Recent signals from connected threads'
                : s.activity.length > 0
                  ? `The ${s.activity.length} most recent signals of the last ${s.windowHours} h`
                  : `Signals of the last ${s.windowHours} h`
            }
          />
          {s ? (
            <Activity snapshot={s} />
          ) : (
            <EmptyState title="No signals received">
              Heartbeats, completed tasks and attention requests will stream in here, each with its
              source and time.
            </EmptyState>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(260px,1fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="health-title">
          <CardHead
            id="health-title"
            title="Project health"
            subtitle="Last signal and fresh threads per project"
          />
          {s ? (
            <ProjectHealthList snapshot={s} />
          ) : (
            <EmptyState
              title="No projects yet"
              action={
                <Link href="/projects" className={linkClass}>
                  Go to Projects
                </Link>
              }
            >
              Projects and their health appear once this deployment is connected to its database.
            </EmptyState>
          )}
        </Card>
        <Card labelledBy="squad-title">
          <CardHead
            id="squad-title"
            title="Agent squad"
            subtitle="Threads waiting for you first, then fresh threads"
          />
          {s ? (
            <Squad snapshot={s} />
          ) : (
            <EmptyState
              title="No agents connected"
              action={
                <Link href="/integrations" className={linkClass}>
                  See supported integrations
                </Link>
              }
            >
              Agents appear when a coding tool sends its first heartbeat.
            </EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
