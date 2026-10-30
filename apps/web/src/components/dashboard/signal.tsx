import type {
  DashboardSnapshot,
  ProjectFreshness,
  StatusReason,
  StatusSource,
  ThreadStatus,
} from '@javis-dog/realtime';
import { StatusPill } from '@javis-dog/ui/components';
import {
  absoluteTime,
  age,
  agentStatusText,
  clockTime,
  shortRef,
  statusLabel,
  statusTone,
} from './format';

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

/** "Last confirmed 10:15:03 UTC": the time of the last signal, when it cannot be re-checked. */
function LastConfirmed({ at }: { at: string }) {
  return (
    <span>
      Last confirmed{' '}
      <time dateTime={at} title={absoluteTime(at)} className="tabular-nums">
        {clockTime(at)}
      </time>
    </span>
  );
}

/**
 * Freshness in words (product rule 2): "Updated 12 s ago", a "Stale" pill with
 * "No signal for 6 min", or an "Ended" pill. Never "live". While refreshes fail
 * (`notCurrent`), a fresh value reads "Not current" with its last confirmed time instead.
 */
export function FreshnessLabel({
  freshness,
  at,
  now,
  notCurrent = false,
}: {
  freshness: ProjectFreshness;
  at: string | null;
  now: string;
  notCurrent?: boolean;
}) {
  if (freshness === 'never' || !at) return <span className="text-muted">No signal yet</span>;
  if (freshness === 'fresh' && notCurrent)
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-muted">
        <StatusPill tone="warn">Not current</StatusPill>
        <LastConfirmed at={at} />
      </span>
    );
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
export function FreshnessPill({
  freshness,
  notCurrent = false,
}: {
  freshness: ProjectFreshness;
  notCurrent?: boolean;
}) {
  if (freshness === 'fresh' && notCurrent) return <StatusPill tone="warn">Not current</StatusPill>;
  if (freshness === 'fresh') return <StatusPill tone="ok">Fresh</StatusPill>;
  if (freshness === 'stale') return <StatusPill tone="warn">Stale</StatusPill>;
  if (freshness === 'ended') return <StatusPill tone="info">Ended</StatusPill>;
  return <span className="text-xs text-muted">No signal yet</span>;
}

/**
 * Opaque thread ref, shortened; the full ref is in the title. Screen readers get the first
 * 8 characters only — a long hash read aloud is noise.
 */
export function ThreadRef({ value }: { value: string }) {
  const short = shortRef(value);
  const spoken = value.slice(0, 8);
  return (
    <span className="font-mono" title={value}>
      <span aria-hidden={short !== spoken}>{short}</span>
      {short !== spoken ? <span className="sr-only">{spoken}</span> : null}
    </span>
  );
}

/**
 * A thread's status. Pass `needsAttention` for thread state: a thread that was waiting and then
 * ended no longer waits for anyone, so it reads "Ended" instead of "Waiting for you".
 *
 * Pass `source` and `reason` from the snapshot. The agent's own report says so in words
 * (ADR-0017 §6): "Blocked · missing credentials · reported by agent". The words are the pill's
 * only text, so screen readers hear the same thing sighted users read, never colour alone.
 */
export function ThreadStatusPill({
  status,
  needsAttention,
  source,
  reason = null,
}: {
  status: ThreadStatus | null;
  needsAttention?: boolean;
  source?: StatusSource;
  reason?: StatusReason | null;
}) {
  if (!status) return <span className="text-xs text-muted">No status sent</span>;
  if (status === 'waiting' && needsAttention === false)
    return <StatusPill tone="info">Ended</StatusPill>;
  if (source === 'agent')
    return (
      <StatusPill tone={statusTone[status]}>
        {/* Long reasons wrap instead of pushing the row wider than a phone screen. */}
        <span className="whitespace-normal">{agentStatusText(status, reason)}</span>
      </StatusPill>
    );
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
              . Trying again every 10&nbsp;s while this tab is visible.
            </span>
          ) : (
            <span>
              Could not load signals. Trying again every 10&nbsp;s while this tab is visible.
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}
