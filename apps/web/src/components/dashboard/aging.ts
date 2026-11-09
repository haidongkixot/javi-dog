import {
  githubNoResult,
  type Counter,
  type DashboardSnapshot,
  type GithubCounts,
  type ThreadState,
} from '@javis-dog/realtime';

const newest = (values: string[]) =>
  values.reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

/**
 * GitHub CI counts at `now` (ADR-0019 Changes "S5h"): a started run that crosses 6 h since its
 * last delivery between the read and `now` moves from `ciRunning` to `ciNoResult`, with the
 * reader's rule (`githubNoResult`). Everything else is the reader's value, unchanged.
 */
function githubAt(s: DashboardSnapshot, now: string): GithubCounts {
  const started = s.threads.filter(
    (t) =>
      t.source === 'github' &&
      t.githubKind === 'ci' &&
      t.freshness !== 'ended' &&
      t.lastType === 'task.started',
  );
  const crossed = started.filter(
    (t) => !githubNoResult(t, s.generatedAt) && githubNoResult(t, now),
  );
  if (crossed.length === 0) return s.github;
  const running = started.filter((t) => !githubNoResult(t, now));
  const previous = s.github.ciNoResult.lastSignalAt;
  return {
    ...s.github,
    ciRunning: {
      value: Math.max(0, s.github.ciRunning.value - crossed.length),
      lastSignalAt: newest(running.map((t) => t.lastSignalAt)),
    },
    ciNoResult: {
      value: s.github.ciNoResult.value + crossed.length,
      lastSignalAt: newest([
        ...(previous ? [previous] : []),
        ...crossed.map((t) => t.lastSignalAt),
      ]),
    },
  };
}

/**
 * The snapshot as it reads at `now` on its own clock (product rule 2). Ages are measured
 * against `now`, a fresh thread whose last signal is older than the freshness window turns
 * stale, and every value derived from fresh threads (project freshness, fresh-thread counts,
 * active projects, agents working) is re-derived with the reader's rules, and so are the GitHub
 * CI runs that reach "No result received" in the meantime. `generatedAt` is
 * replaced by `now`; the original snapshot keeps the time of the last good read.
 */
export function atClientTime(s: DashboardSnapshot, now: string): DashboardSnapshot {
  if (now <= s.generatedAt) return s;
  const nowMs = Date.parse(now);
  const expired = (t: ThreadState) => nowMs - Date.parse(t.lastSignalAt) > s.freshnessWindowMs;
  const threads = s.threads.map((t) =>
    t.freshness === 'fresh' && expired(t) ? { ...t, freshness: 'stale' as const } : t,
  );
  const fresh = threads.filter((t) => t.freshness === 'fresh');
  // GitHub threads carry no status; the source check states the reader's rule (ADR-0019).
  const working = fresh.filter((t) => t.source !== 'github' && t.status === 'working');
  const counter = (value: number, group: ThreadState[]): Counter => ({
    value,
    lastSignalAt: newest(group.map((t) => t.lastSignalAt)),
  });
  return {
    ...s,
    generatedAt: now,
    overview: {
      ...s.overview,
      activeProjects: counter(new Set(fresh.map((t) => t.projectId)).size, fresh),
      agentsWorking: counter(working.length, working),
    },
    github: githubAt(s, now),
    threads,
    projects: s.projects.map((p) => {
      const ownFresh = fresh.filter((t) => t.projectId === p.id).length;
      return {
        ...p,
        freshness: p.freshness === 'fresh' && ownFresh === 0 ? 'stale' : p.freshness,
        freshThreads: ownFresh,
      };
    }),
  };
}
