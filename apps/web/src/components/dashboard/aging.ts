import type { Counter, DashboardSnapshot, ThreadState } from '@javis-dog/realtime';

const newest = (values: string[]) =>
  values.reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

/**
 * The snapshot as it reads at `now` on its own clock (product rule 2). Ages are measured
 * against `now`, a fresh thread whose last signal is older than the freshness window turns
 * stale, and every value derived from fresh threads (project freshness, fresh-thread counts,
 * active projects, agents working) is re-derived with the reader's rules. `generatedAt` is
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
  const working = fresh.filter((t) => t.status === 'working');
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
