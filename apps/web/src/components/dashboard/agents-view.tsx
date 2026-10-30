import type { ReactNode } from 'react';
import type { DashboardSnapshot, ThreadState } from '@javis-dog/realtime';
import { Card, CardHead, EmptyState, Icon, MetricCard } from '@javis-dog/ui/components';
import { ThreadIdentityLabel } from '@/components/privacy/thread-identity';
import { byAttention, formatNumber, windowLabel } from './format';
import { FreshnessLabel, FreshnessPill, SignalTime, ThreadRef, ThreadStatusPill } from './signal';

const columns = [
  'Project',
  'Thread',
  'Status',
  'Freshness',
  'Agents',
  'Tasks',
  'Tokens',
  'Last signal',
] as const;

const th =
  'border-y border-line bg-surface-subtle px-4 py-2.5 text-[11px] font-bold tracking-wide text-muted uppercase';

/** Newest thread of a group, for the card's last-signal line. */
const newest = (threads: ThreadState[]) =>
  threads.reduce<ThreadState | null>(
    (a, t) => (!a || t.lastSignalAt > a.lastSignalAt ? t : a),
    null,
  );

function GroupMeta({
  group,
  now,
  none,
  notCurrent,
}: {
  group: ThreadState[];
  now: string;
  none: string;
  notCurrent: boolean;
}) {
  const t = newest(group);
  if (!t) return <>{none}</>;
  return (
    <FreshnessLabel freshness={t.freshness} at={t.lastSignalAt} now={now} notCurrent={notCurrent} />
  );
}

function Metrics({
  snapshot: s,
  notCurrent,
}: {
  snapshot: DashboardSnapshot | null;
  notCurrent: boolean;
}) {
  const threads = s?.threads ?? [];
  const show = (n: number) => (s && threads.length > 0 ? formatNumber(n) : null);
  const fresh = threads.filter((t) => t.freshness === 'fresh');
  const attention = threads.filter((t) => t.needsAttention);
  const stale = threads.filter((t) => t.freshness === 'stale');
  const ended = threads.filter((t) => t.freshness === 'ended');
  const meta = (group: ThreadState[], none: string) =>
    s && threads.length > 0 ? (
      <GroupMeta group={group} now={s.generatedAt} none={none} notCurrent={notCurrent} />
    ) : null;
  const freshWindow = s ? windowLabel(s.freshnessWindowMs) : '';
  return (
    <section
      aria-label="Thread metrics"
      className="grid grid-cols-4 gap-4 max-[1150px]:grid-cols-2"
    >
      <MetricCard
        label="Need your attention"
        value={show(attention.length)}
        meta={meta(attention, 'No thread needs you')}
        icon={<Icon name="alert" />}
        iconClassName="bg-danger-bg text-danger"
      />
      <MetricCard
        label="Fresh threads"
        value={show(fresh.length)}
        meta={meta(fresh, `No signal in the last ${freshWindow}`)}
        icon={<Icon name="bolt" />}
        iconClassName="bg-ok-bg text-ok"
      />
      <MetricCard
        label="Stale threads"
        value={show(stale.length)}
        meta={meta(stale, `Every open thread signalled in the last ${freshWindow}`)}
        icon={<Icon name="clock" />}
        iconClassName="bg-warn-bg text-warn"
      />
      <MetricCard
        label={s ? `Ended in ${s.windowHours} h` : 'Ended threads'}
        value={show(ended.length)}
        meta={meta(ended, 'No session ended')}
        icon={<Icon name="check" />}
        iconClassName="bg-info-bg text-info"
      />
    </section>
  );
}

function Tokens({ t }: { t: ThreadState }) {
  const total = t.inputTokens + t.outputTokens;
  // Usage arrives only for attributed sessions (ADR-0011): no report is not zero usage.
  if (total === 0) return <span className="text-muted">No usage reports</span>;
  return (
    <span
      className="tabular-nums"
      title={`${formatNumber(t.inputTokens)} input · ${formatNumber(t.outputTokens)} output`}
    >
      {formatNumber(total)}
      <span className="sr-only">
        {' '}
        tokens ({formatNumber(t.inputTokens)} input, {formatNumber(t.outputTokens)} output)
      </span>
    </span>
  );
}

function ThreadTable({
  snapshot: s,
  notCurrent,
}: {
  snapshot: DashboardSnapshot;
  notCurrent: boolean;
}) {
  const threads = [...s.threads].sort(byAttention);
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-left whitespace-nowrap">
        <caption className="sr-only">
          Threads with a signal in the last {s.windowHours} h, threads that need you first
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className={th}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {threads.map((t) => (
            <tr key={`${t.projectId}-${t.threadRef}`} className="border-b border-line text-xs">
              <th scope="row" className="px-4 py-3 text-left font-bold text-ink">
                {t.projectName}
              </th>
              <td className="px-4 py-3 text-muted">
                <ThreadRef value={t.threadRef} />
                <ThreadIdentityLabel
                  projectId={t.projectId}
                  projectSlug={t.projectSlug}
                  threadRef={t.threadRef}
                  identity={t.identity}
                  className="mt-1 block max-w-64 truncate text-xs text-muted"
                />
              </td>
              <td className="px-4 py-3">
                <ThreadStatusPill
                  status={t.status}
                  needsAttention={t.needsAttention}
                  source={t.statusSource}
                  reason={t.statusReason}
                />
              </td>
              <td className="px-4 py-3">
                <FreshnessPill freshness={t.freshness} notCurrent={notCurrent} />
              </td>
              <td className={t.agents === 0 ? 'px-4 py-3 text-muted' : 'px-4 py-3 tabular-nums'}>
                {t.agents === 0 ? 'Not reported' : formatNumber(t.agents)}
              </td>
              <td className="px-4 py-3 tabular-nums">{formatNumber(t.tasksCompleted)}</td>
              <td className="px-4 py-3">
                <Tokens t={t} />
              </td>
              <td className="px-4 py-3 text-muted">
                <SignalTime at={t.lastSignalAt} now={s.generatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Live agents body (metrics + thread monitor). `snapshot === null` keeps the empty page. */
export function AgentsView({
  snapshot: s,
  notice,
  inspector,
  notCurrent = false,
}: {
  snapshot: DashboardSnapshot | null;
  notice?: ReactNode;
  inspector: ReactNode;
  /** Refreshes are failing: nothing may read as fresh. */
  notCurrent?: boolean;
}) {
  return (
    <>
      {notice}
      <Metrics snapshot={s} notCurrent={notCurrent} />
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="threads-title">
          <CardHead
            id="threads-title"
            title="Thread monitor"
            subtitle={
              s
                ? `Threads of the last ${s.windowHours} h; stale after ${windowLabel(s.freshnessWindowMs)} without a signal`
                : 'Every thread with its status, freshness and last signal'
            }
          />
          {s && s.threads.length > 0 ? (
            <ThreadTable snapshot={s} notCurrent={notCurrent} />
          ) : (
            <EmptyState title="No threads connected">
              Threads from Claude Code, Codex and Gemini CLI appear here once their collector is set
              up.
            </EmptyState>
          )}
        </Card>
        {inspector}
      </div>
    </>
  );
}
