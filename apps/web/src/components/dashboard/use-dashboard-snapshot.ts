'use client';

import type { DashboardSnapshot } from '@javis-dog/realtime';
import { useEffect, useState } from 'react';

/** ADR-0012: re-fetch every 10 s while the tab is visible. */
export const POLL_INTERVAL_MS = 10_000;
export const SNAPSHOT_URL = '/api/dashboard/snapshot';

export interface DashboardSnapshotState {
  /** The newest snapshot received; kept when a refresh fails. */
  snapshot: DashboardSnapshot | null;
  /** Set while refreshes fail; `since` is when the first failure in a row happened. */
  error: { since: Date } | null;
  /** The API answered 401: the session ended. Polling stops. */
  signedOut: boolean;
}

const isSnapshot = (value: unknown): value is DashboardSnapshot => {
  const v = value as Partial<DashboardSnapshot> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.generatedAt === 'string' &&
    typeof v.overview === 'object' &&
    Array.isArray(v.threads) &&
    Array.isArray(v.activity) &&
    Array.isArray(v.projects)
  );
};

/**
 * Polls the workspace snapshot. Paused while the document is hidden; refreshes immediately
 * when it becomes visible again. A failed refresh (network error or any non-200 answer) keeps
 * the last snapshot and reports `error` so the page can say the data is not current.
 * With `initial === null` (the first server read failed) it fetches right away.
 */
export function useDashboardSnapshot(initial: DashboardSnapshot | null): DashboardSnapshotState {
  const [state, setState] = useState<DashboardSnapshotState>(() => ({
    snapshot: initial,
    error: initial ? null : { since: new Date() },
    signedOut: false,
  }));

  useEffect(() => {
    let disposed = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const visible = () => document.visibilityState === 'visible';
    const fail = () =>
      setState((s) => ({ ...s, error: s.error ?? { since: new Date() }, signedOut: false }));
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && !stopped && visible()) timer = setTimeout(refresh, POLL_INTERVAL_MS);
    };

    async function refresh() {
      clearTimeout(timer);
      if (disposed || stopped || !visible()) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const res = await fetch(SNAPSHOT_URL, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: current.signal,
        });
        if (disposed || current.signal.aborted) return;
        if (res.status === 401) {
          stopped = true;
          setState((s) => ({ ...s, error: null, signedOut: true }));
          return;
        }
        const body: unknown = res.ok ? await res.json() : null;
        if (disposed || current.signal.aborted) return;
        if (res.status === 200 && isSnapshot(body)) {
          setState({ snapshot: body, error: null, signedOut: false });
        } else {
          fail();
        }
      } catch {
        if (disposed || current.signal.aborted) return;
        fail();
      }
      schedule();
    }

    const onVisibility = () => {
      if (visible()) void refresh();
      else clearTimeout(timer);
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (initial) schedule();
    else void refresh();

    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `initial` only seeds the first render; later server renders do not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
