import type { GithubKind, StatusReason, ThreadState, ThreadStatus } from '@javis-dog/realtime';
import type { StatusTone } from '@javis-dog/ui';

// Formatting is deterministic (fixed locale, UTC for absolute times, ages measured against the
// snapshot's database clock) so server and client render the same text on hydration.

const absoluteFmt = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const numberFmt = new Intl.NumberFormat('en');

/** "28 Oct 2026, 10:15:03 UTC" */
export const absoluteTime = (iso: string) => `${absoluteFmt.format(new Date(iso))} UTC`;

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** "10:15:03 UTC" — same zone as `absoluteTime`, for notices and "last confirmed" times. */
export const clockTime = (iso: string) => `${clockFmt.format(new Date(iso))} UTC`;

/** "12 s", "4 min", "3 h", "2 d" — the age of `iso` at `now` (both ISO strings). */
export const age = (iso: string, now: string) => {
  const s = Math.max(0, Math.floor((Date.parse(now) - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
};

export const formatNumber = (n: number) => numberFmt.format(n);

/** "3 min" for the freshness window (default 180 000 ms). */
export const windowLabel = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

export const statusLabel: Record<ThreadStatus, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
};

/** A self-report reason in words: `missing_credentials` → "missing credentials". */
/** Abbreviations keep their capitals; every other reason is lower case with spaces. */
export const reasonWords = (reason: StatusReason) =>
  reason === 'ci_failing' ? 'CI failing' : reason.replaceAll('_', ' ');

/**
 * The words of an agent's own report (ADR-0017 §6), e.g.
 * "Blocked · missing credentials · reported by agent"; no reason segment when none was given.
 */
export const agentStatusText = (status: ThreadStatus, reason: StatusReason | null) =>
  [statusLabel[status], reason ? reasonWords(reason) : null, 'reported by agent']
    .filter((part): part is string => part !== null)
    .join(' · ');

// Coral (danger) marks attention per BRAND_GUIDE §3; yellow (warn) is reserved for "Stale".
export const statusTone: Record<ThreadStatus, StatusTone> = {
  working: 'ok',
  waiting: 'danger',
  idle: 'info',
  blocked: 'danger',
  failed: 'danger',
  completed: 'info',
};

/** Opaque refs are long hashes: show a prefix, keep the full value for the title. */
export const shortRef = (ref: string) => (ref.length > 12 ? `${ref.slice(0, 10)}…` : ref);

/** Threads that need you first (never ended ones), then the most recent signal first. */
export const byAttention = (a: ThreadState, b: ThreadState) =>
  Number(b.needsAttention) - Number(a.needsAttention) ||
  b.lastSignalAt.localeCompare(a.lastSignalAt);

/** "2 agents", or "Agents not reported" when no event of the thread carried an `agent_ref`. */
export const agentCount = (n: number) =>
  n === 0 ? 'Agents not reported' : `${numberFmt.format(n)} ${n === 1 ? 'agent' : 'agents'}`;

/** "One thread needs your attention." / "3 threads need your attention." */
export const attentionHeadline = (n: number) =>
  n === 1 ? 'One thread needs your attention.' : `${n} threads need your attention.`;

/**
 * A thread the GitHub bridge wrote (ADR-0019 decision 6). The reader decides this from the
 * reserved `gh-app_` producer prefix only; anything else is an agent thread.
 */
export const isGithubThread = (t: Pick<ThreadState, 'source'>) => t.source === 'github';

/** Agent threads only: GitHub threads are never presented as agents. */
export const agentThreads = (threads: ThreadState[]) => threads.filter((t) => !isGithubThread(t));

/** "GitHub CI" or "GitHub PR": the label a GitHub thread carries wherever it is shown. */
export const githubLabel = (kind: GithubKind | null) =>
  kind === 'pr' ? 'GitHub PR' : kind === 'ci' ? 'GitHub CI' : 'GitHub';

/**
 * A GitHub thread's newest event in words. These are GitHub results, not agent statuses, so
 * they never use the agent status labels; coral (danger) is kept for a failed run.
 */
const GITHUB_OUTCOMES = new Map<string, { text: string; tone: StatusTone }>(
  Object.entries({
    'task.started': { text: 'In progress', tone: 'info' },
    'task.completed': { text: 'Completed', tone: 'ok' },
    'task.failed': { text: 'Failed', tone: 'danger' },
    'x.github.ci.cancelled': { text: 'Cancelled', tone: 'info' },
    'x.github.ci.skipped': { text: 'Skipped', tone: 'info' },
    'x.github.ci.attention': { text: 'Waiting on GitHub', tone: 'info' },
    'x.github.pr.opened': { text: 'Open', tone: 'info' },
    'x.github.pr.updated': { text: 'Updated', tone: 'info' },
    'x.github.pr.ready': { text: 'Ready for review', tone: 'info' },
    'x.github.pr.merged': { text: 'Merged', tone: 'ok' },
    'x.github.pr.closed': { text: 'Closed', tone: 'info' },
  } satisfies Record<string, { text: string; tone: StatusTone }>),
);

/**
 * A started run with no result 6 h after its last delivery (ADR-0019 Changes "S5h"): what is
 * known, never "Failed" and never "In progress".
 */
export const GITHUB_NO_RESULT_TEXT = 'No result received';

/**
 * Words and tone for a GitHub thread's `lastType`; an unknown type is shown as sent. With
 * `noResult` (the reader's `githubNoResult` rule), "No result received" in the info tone.
 */
export const githubOutcome = (
  lastType: string,
  noResult = false,
): { text: string; tone: StatusTone } =>
  noResult
    ? { text: GITHUB_NO_RESULT_TEXT, tone: 'info' }
    : (GITHUB_OUTCOMES.get(lastType) ?? { text: lastType, tone: 'info' });
