import type { DashboardSnapshot, ProjectFreshness, ThreadStatus } from '@javis-dog/realtime';
import { StatusPill } from '@javis-dog/ui/components';
import { absoluteTime, age, clockTime, shortRef, statusLabel, statusTone } from './format';

/**
 * A signal time: relative text measured against the snapshot clock, the exact UTC time in the
 * title and, for screen readers, in a visually hidden suffix.
 */
export function SignalTime({
  at,
  now,
  suffix = ' ago',
}: {
  at: string;
  now: string;
  suffix?: string;
}) {
  const exact = absoluteTime(at);
  return (
    <time dateTime={at} title={exact} className="tabular-nums">
      {age(at, now)}
      {suffix}
      <span className="sr-only"> ({exact})</span>
    </time>
  );
}

/**
 * Freshness in words (product rule 2): "Updated 12 s ago", a "Stale" pill with
 * "No signal for 6 min", or an "Ended" pill. Never "live".
 */
export function FreshnessLabel({
  freshness,
  at,
  now,
}: {
  freshness: ProjectFreshness;
  at: string | null;
  now: string;
}) {
  if (freshness === 'never' || !at) return <span className="text-muted">No signal yet</span>;
  if (freshness === 'fresh')
    return (
      <span className="text-muted">
        Updated <SignalTime at={at} now={now} />
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-muted">
      {freshness === 'stale' ? (
        <>
          <StatusPill tone="warn">Stale</StatusPill>
          <span>
            No signal for <SignalTime at={at} now={now} suffix="" />
          </span>
        </>
      ) : (
        <>
          <StatusPill tone="info">Ended</StatusPill>
          <span>
            <SignalTime at={at} now={now} />
          </span>
        </>
      )}
    </span>
  );
}

/** Compact freshness for table cells; the time sits in its own "Last signal" column. */
export function FreshnessPill({ freshness }: { freshness: ProjectFreshness }) {
  if (freshness === 'fresh') return <StatusPill tone="ok">Fresh</StatusPill>;
  if (freshness === 'stale') return <StatusPill tone="warn">Stale</StatusPill>;
  if (freshness === 'ended') return <StatusPill tone="info">Ended</StatusPill>;
  return <span className="text-xs text-muted">No signal yet</span>;
}

/** Opaque thread ref, shortened; the full ref is in the title and for screen readers. */
export function ThreadRef({ value }: { value: string }) {
  const short = shortRef(value);
  return (
    <span className="font-mono" title={value}>
      <span aria-hidden={short !== value}>{short}</span>
      {short !== value ? <span className="sr-only">{value}</span> : null}
    </span>
  );
}

export function ThreadStatusPill({ status }: { status: ThreadStatus | null }) {
  if (!status) return <span className="text-xs text-muted">No status sent</span>;
  return <StatusPill tone={statusTone[status]}>{statusLabel[status]}</StatusPill>;
}

/** Shown while refreshes fail: the data on screen is kept but named as not current. */
export function RefreshNotice({
  snapshot,
  error,
}: {
  snapshot: DashboardSnapshot | null;
  error: { since: Date } | null;
}) {
  return (
    <div role="status" aria-live="polite">
      {error ? (
        <p className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-warn-bg px-3 py-2 text-xs text-ink">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {snapshot ? (
            <span>
              Could not refresh — showing data from{' '}
              <time dateTime={snapshot.generatedAt} title={absoluteTime(snapshot.generatedAt)}>
                {clockTime(snapshot.generatedAt)}
              </time>
              . Trying again every 10&nbsp;s.
            </span>
          ) : (
            <span>Could not load signals. Trying again every 10&nbsp;s.</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
