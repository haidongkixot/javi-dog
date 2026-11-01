import type { Counter, DashboardSnapshot, GithubKind, ThreadState } from '@javis-dog/realtime';
import { Card, CardHead, Icon, StatusPill } from '@javis-dog/ui/components';
import { formatNumber, githubLabel, githubOutcome, isGithubThread } from './format';
import { FreshnessPill, SignalTime, ThreadRef } from './signal';

// GitHub threads (ADR-0019 decision 6, D0 M1): CI runs, check suites and pull requests from the
// JD-M10 bridge. They are labelled with their source wherever they appear, never with an agent
// name or avatar, and they are shown apart from the agent squad and the agent counts.

const NO_HEARTBEAT =
  'GitHub sends no heartbeat: an open run or pull request reads stale between deliveries.';

/** "GitHub CI" / "GitHub PR" as text with the git glyph; the words carry the meaning. */
export function GithubSourceLabel({ kind }: { kind: GithubKind | null }) {
  return (
    <span className="inline-flex items-center gap-1 font-sans font-bold text-ink">
      <Icon name="git" className="size-3.5 flex-none text-muted" />
      {githubLabel(kind)}
    </span>
  );
}

/** The newest GitHub result of a thread in words ("Failed", "Merged"…), never an agent status. */
export function GithubOutcomePill({ lastType }: { lastType: string }) {
  const { text, tone } = githubOutcome(lastType);
  return <StatusPill tone={tone}>{text}</StatusPill>;
}

function CountRow({
  label,
  counter,
  snapshot: s,
  none,
}: {
  label: string;
  counter: Counter;
  snapshot: DashboardSnapshot;
  none: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="text-xs font-bold text-ink">{label}</p>
        <p className="mt-1 text-xs text-muted">
          {counter.lastSignalAt ? (
            <>
              Last delivery <SignalTime at={counter.lastSignalAt} now={s.generatedAt} />
            </>
          ) : (
            none
          )}
        </p>
      </div>
      <p className="text-xl font-extrabold tracking-tight tabular-nums">
        {formatNumber(counter.value)}
      </p>
    </li>
  );
}

/**
 * Overview card with the snapshot's GitHub counts. Rendered only when a GitHub thread is in the
 * window, so a deployment without the GitHub App shows nothing that implies one.
 */
export function GithubCountsCard({ snapshot: s }: { snapshot: DashboardSnapshot }) {
  if (!s.threads.some(isGithubThread)) return null;
  const g = s.github;
  return (
    <Card labelledBy="github-counts-title">
      <CardHead
        id="github-counts-title"
        title="GitHub CI and pull requests"
        subtitle={`From GitHub deliveries in the last ${s.windowHours} h, counted apart from your agents`}
      />
      <ul aria-label="GitHub counts" className="px-5 pt-2 pb-2">
        <CountRow
          label="CI runs in progress"
          counter={g.ciRunning}
          snapshot={s}
          none="No run in progress"
        />
        <CountRow
          label="CI runs failed"
          counter={g.ciFailed24h}
          snapshot={s}
          none={`No failed run in ${s.windowHours} h`}
        />
        <CountRow label="Open pull requests" counter={g.prsOpen} snapshot={s} none="None open" />
      </ul>
      <p className="px-5 pb-5 text-xs text-muted">{NO_HEARTBEAT}</p>
    </Card>
  );
}

const th =
  'border-y border-line bg-surface-subtle px-4 py-2.5 text-[11px] font-bold tracking-wide text-muted uppercase';

const columns = ['Source', 'Project', 'Reference', 'Result', 'Freshness', 'Last signal'] as const;

/** Live agents page: GitHub threads in their own table, newest first, never in the monitor. */
export function GithubThreadsCard({
  snapshot: s,
  notCurrent = false,
}: {
  snapshot: DashboardSnapshot;
  notCurrent?: boolean;
}) {
  const threads: ThreadState[] = s.threads
    .filter(isGithubThread)
    .sort((a, b) => b.lastSignalAt.localeCompare(a.lastSignalAt));
  if (threads.length === 0) return null;
  return (
    <Card labelledBy="github-threads-title">
      <CardHead
        id="github-threads-title"
        title="GitHub CI and pull requests"
        subtitle={`Runs, check suites and pull requests of the last ${s.windowHours} h. ${NO_HEARTBEAT}`}
      />
      <div className="mt-4 overflow-x-auto">
        <table
          aria-label="GitHub threads"
          className="w-full border-collapse text-left whitespace-nowrap"
        >
          <caption className="sr-only">
            GitHub runs and pull requests with a delivery in the last {s.windowHours} h, newest
            first
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
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <GithubSourceLabel kind={t.githubKind} />
                </th>
                <td className="px-4 py-3 font-bold text-ink">{t.projectName}</td>
                <td className="px-4 py-3 text-muted">
                  <ThreadRef value={t.threadRef} />
                </td>
                <td className="px-4 py-3">
                  <GithubOutcomePill lastType={t.lastType} />
                </td>
                <td className="px-4 py-3">
                  <FreshnessPill freshness={t.freshness} notCurrent={notCurrent} />
                </td>
                <td className="px-4 py-3 text-muted">
                  <SignalTime at={t.lastSignalAt} now={s.generatedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
