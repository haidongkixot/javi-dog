import type { UsageAnalytics } from '@javis-dog/analytics';
import { EmptyState } from '@javis-dog/ui/components';
// Type only: lib/analytics wires the server-side reader and must stay out of client bundles.
import type { UsageLoad } from '@/lib/analytics';
import { estimatedNote, formatTokens, formatUsd, fullDay } from './format';
import { UsageByModel } from './usage-by-model';
import { UsageByProject } from './usage-by-project';
import { UsageChart } from './usage-chart';
import { UtcStamp } from './utc-stamp';

// Usage blocks for Overview and Project detail (ADR-0013). Server-rendered per visit; each block
// says when it was computed. Times are absolute UTC (never a relative age that would freeze on a
// page left open, product rule 2). Tokens are exact unless a report says it is estimated
// (`estimatedReports`); cost is always labelled "estimated".

const periodDays = (u: UsageAnalytics) => u.days.length;

/** "<caption>. <note>" when there is a note. */
const withNote = (caption: string, note: string | null) => (note ? `${caption}. ${note}` : caption);

/** "Computed 10:15:03 UTC" (the date too when not today) from the database clock of the read. */
function Computed({ at }: { at: string }) {
  return (
    <span>
      Computed <UtcStamp at={at} seconds />
    </span>
  );
}

function UsageMeta({ usage: u }: { usage: UsageAnalytics }) {
  return (
    <p className="flex flex-wrap gap-x-1.5 px-5 pb-5 text-xs text-muted">
      {u.lastReportAt ? (
        <>
          <span>
            Last usage report <UtcStamp at={u.lastReportAt} />
          </span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span>
        From {formatTokens(u.totals.reports)} usage {u.totals.reports === 1 ? 'report' : 'reports'}
      </span>
      <span aria-hidden>·</span>
      <Computed at={u.generatedAt} />
    </p>
  );
}

/** Period totals: input and output tokens, estimated cost (and a note on estimated counts). */
function UsageTotals({ usage: u }: { usage: UsageAnalytics }) {
  const note = estimatedNote(u.totals);
  const items = [
    { label: 'Input tokens', value: formatTokens(u.totals.inputTokens) },
    { label: 'Output tokens', value: formatTokens(u.totals.outputTokens) },
    { label: 'Estimated cost', value: formatUsd(u.totals.estimatedCostUsd) },
  ];
  return (
    <>
      <dl className="grid grid-cols-3 gap-4 px-5 pt-4 max-[560px]:grid-cols-1">
        {items.map((i) => (
          <div key={i.label}>
            <dt className="text-xs font-semibold text-muted">{i.label}</dt>
            <dd className="mt-1 text-lg leading-tight font-extrabold tracking-tight text-ink">
              {i.value}
            </dd>
          </div>
        ))}
      </dl>
      {note ? <p className="px-5 pt-2 text-xs text-muted">{note}</p> : null}
    </>
  );
}

const subheadClass = 'px-5 pt-4 pb-2 text-[13px] font-extrabold';

function NoReports({ usage: u }: { usage: UsageAnalytics }) {
  return (
    <div className="pb-5">
      <EmptyState title={`No usage reports in the last ${periodDays(u)} days`}>
        Token counts appear here once a connected thread sends a usage report. Days are UTC.
      </EmptyState>
      <p className="px-5 text-xs text-muted">
        <Computed at={u.generatedAt} />
      </p>
    </div>
  );
}

function Unavailable() {
  return (
    <EmptyState title="Usage could not be loaded">
      Reading the usage reports failed. Reload the page to try again.
    </EmptyState>
  );
}

function NoUsageData() {
  return (
    <EmptyState title="No usage data yet">
      Token counts appear here once a connected thread reports them. Javi&apos;s Dog never shows a
      cost without labelling it as an estimate.
    </EmptyState>
  );
}

/** Body of the Overview "Token consumption" card for the viewer's workspace. */
export function OverviewUsage({ load }: { load: UsageLoad | undefined }) {
  if (load?.kind === 'unavailable') return <Unavailable />;
  if (load?.kind !== 'ready') return <NoUsageData />;
  const u = load.usage;
  if (u.totals.reports === 0) return <NoReports usage={u} />;
  return (
    <>
      <UsageTotals usage={u} />
      <UsageChart days={u.days} id="overview-usage" note={estimatedNote(u.totals)} />
      {/* One project would only repeat the totals. */}
      {u.byProject.length >= 2 ? (
        <>
          <h3 className={subheadClass}>Usage by project (last {periodDays(u)} days)</h3>
          <UsageByProject
            rows={u.byProject}
            caption={`Tokens and estimated cost per project, last ${periodDays(u)} UTC days`}
          />
        </>
      ) : null}
      <UsageMeta usage={u} />
    </>
  );
}

function TaskOutcomes({ usage: u }: { usage: UsageAnalytics }) {
  const { tasksCompleted, tasksFailed } = u.totals;
  if (tasksCompleted + tasksFailed === 0)
    return (
      <p className="px-5 pb-4 text-xs text-muted">
        No completed or failed tasks in the last {periodDays(u)} days.
      </p>
    );
  const active = u.days.filter((d) => d.tasksCompleted + d.tasksFailed > 0);
  return (
    <div className="px-5 pb-4">
      <dl className="grid grid-cols-2 gap-4">
        <div>
          <dt className="text-xs font-semibold text-muted">Tasks completed</dt>
          <dd className="mt-1 text-lg font-extrabold text-ink">{formatTokens(tasksCompleted)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-muted">Tasks failed</dt>
          <dd className="mt-1 text-lg font-extrabold text-ink">{formatTokens(tasksFailed)}</dd>
        </div>
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-bold text-ink underline">
          Show task outcomes per day
        </summary>
        <table className="mt-2 w-full border-collapse text-left text-xs whitespace-nowrap tabular-nums">
          <caption className="pb-2 text-left text-xs text-muted">
            Task outcomes per UTC day (days without outcomes are left out)
          </caption>
          <thead>
            <tr>
              {['Date (UTC)', 'Completed', 'Failed'].map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={`border-y border-line bg-surface-subtle px-3 py-2 text-[11px] font-bold tracking-wide text-muted uppercase ${i > 0 ? 'text-right' : ''}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {active.map((d) => (
              <tr key={d.date} className="border-b border-line">
                <th scope="row" className="px-3 py-2 font-normal text-ink">
                  <time dateTime={d.date}>{fullDay(d.date)}</time>
                </th>
                <td className="px-3 py-2 text-right text-ink">{formatTokens(d.tasksCompleted)}</td>
                <td className="px-3 py-2 text-right text-ink">{formatTokens(d.tasksFailed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Body of the Project detail "Usage (last 14 days)" card, already filtered to the project. */
export function ProjectUsage({ load }: { load: UsageLoad }) {
  if (load.kind === 'unavailable') return <Unavailable />;
  if (load.kind !== 'ready') return <NoUsageData />;
  const u = load.usage;
  return (
    <>
      {u.totals.reports === 0 ? (
        <NoReports usage={u} />
      ) : (
        <>
          <UsageTotals usage={u} />
          <UsageChart days={u.days} id="project-usage" note={estimatedNote(u.totals)} />
          <h3 className={subheadClass}>Usage by model</h3>
          <UsageByModel
            rows={u.byModel}
            caption={withNote(
              `Tokens, estimated cost and usage reports per model, last ${periodDays(u)} UTC days`,
              estimatedNote(u.totals),
            )}
          />
        </>
      )}
      <h3 className={subheadClass}>Task outcomes</h3>
      <TaskOutcomes usage={u} />
      {u.totals.reports > 0 ? <UsageMeta usage={u} /> : null}
    </>
  );
}
