'use client';

import type { DashboardSnapshot } from '@javis-dog/realtime';
import { useEffect, useState } from 'react';

/** ADR-0012: re-fetch every 10 s while the tab is visible. */
export const POLL_INTERVAL_MS = 10_000;
/** A refresh that has not settled after this long counts as failed (and is aborted). */
export const REQUEST_TIMEOUT_MS = 8_000;
/** Ages are re-rendered at least this often, even when no new data arrives. */
export const AGE_TICK_MS = 5_000;
export const SNAPSHOT_URL = '/api/dashboard/snapshot';

export interface DashboardSnapshotState {
  /** The newest snapshot received; kept when a refresh fails. */
  snapshot: DashboardSnapshot | null;
  /**
   * "Now" on the snapshot's (database) clock: `generatedAt` plus the client time elapsed since
   * the snapshot arrived. Equals `generatedAt` until mounted, so server and client HTML match.
   */
  now: string | null;
  /** Set while refreshes fail; `since` is when the first failure in a row happened. */
  error: { since: Date } | null;
  /** The API answered 401: the session ended. Polling stops. */
  signedOut: boolean;
}

interface State {
  snapshot: DashboardSnapshot | null;
  /** Client `Date.now()` when `snapshot` arrived. */
  receivedAt: number;
  /** Client `Date.now()` of the last age re-render. */
  clock: number;
  error: { since: Date } | null;
  signedOut: boolean;
  /** The last `initial` prop seen, to adopt a newer one (router.refresh). */
  initial: DashboardSnapshot | null;
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

const snapshotNow = (s: State): string | null => {
  if (!s.snapshot) return null;
  const elapsed = Math.max(0, s.clock - s.receivedAt);
  return new Date(Date.parse(s.snapshot.generatedAt) + elapsed).toISOString();
};

/**
 * Polls the workspace snapshot. Paused while the document is hidden; refreshes immediately
 * when it becomes visible again. A failed refresh (network error, any non-200 answer, or no
 * answer within 8 s) keeps the last snapshot and reports `error` so the page can say the data
 * is not current; the next poll is always scheduled. With `initial === null` (the first server
 * read failed) it fetches right away. A newer `initial` (e.g. after `router.refresh()`) is
 * adopted; an older one is ignored.
 */
export function useDashboardSnapshot(initial: DashboardSnapshot | null): DashboardSnapshotState {
  // `receivedAt === clock` at first: `now` is `generatedAt` on the server and on hydration.
  const [state, setState] = useState<State>(() => {
    const at = Date.now();
    return {
      snapshot: initial,
      receivedAt: at,
      clock: at,
      error: initial ? null : { since: new Date() },
      signedOut: false,
      initial,
    };
  });

  // A new server snapshot (router.refresh): adopt it when it is newer than what is shown.
  // Its receipt time is the last tick, so ages err on the old side by at most AGE_TICK_MS.
  if (initial !== state.initial) {
    const newer =
      initial !== null &&
      (state.snapshot === null || state.snapshot.generatedAt < initial.generatedAt);
    setState(
      newer
        ? { ...state, initial, snapshot: initial, receivedAt: state.clock, error: null }
        : { ...state, initial },
    );
  }

  useEffect(() => {
    let disposed = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const tick = () => setState((s) => ({ ...s, clock: Date.now() }));
    const ticker = setInterval(tick, AGE_TICK_MS);

    const visible = () => document.visibilityState === 'visible';
    const fail = () =>
      setState((s) => ({ ...s, error: s.error ?? { since: new Date() }, signedOut: false }));
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && !stopped && visible()) timer = setTimeout(refresh, POLL_INTERVAL_MS);
    };

    async function refresh() {
      clearTimeout(timer);
      clearTimeout(deadline);
      if (disposed || stopped || !visible()) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      // False once this request was superseded, timed out or the hook unmounted.
      const isCurrent = () => !disposed && controller === current && !current.signal.aborted;
      // Our own timer instead of AbortSignal.timeout/any: works wherever AbortController does,
      // and fails the request even if `fetch` ignores the abort.
      deadline = setTimeout(() => {
        if (!isCurrent()) return;
        current.abort();
        fail();
        schedule();
      }, REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(SNAPSHOT_URL, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: current.signal,
        });
        if (!isCurrent()) return;
        if (res.status === 401) {
          clearTimeout(deadline);
          stopped = true;
          setState((s) => ({ ...s, error: null, signedOut: true }));
          return;
        }
        const body: unknown = res.ok ? await res.json() : null;
        if (!isCurrent()) return;
        if (res.status === 200 && isSnapshot(body)) {
          const at = Date.now();
          setState((s) => ({
            ...s,
            snapshot: body,
            receivedAt: at,
            clock: at,
            error: null,
            signedOut: false,
          }));
        } else {
          fail();
        }
      } catch {
        if (!isCurrent()) return;
        fail();
      }
      clearTimeout(deadline);
      schedule();
    }

    const onVisibility = () => {
      if (visible()) {
        tick();
        void refresh();
      } else clearTimeout(timer);
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (initial) schedule();
    else void refresh();

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      clearInterval(ticker);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Polling starts once; a later `initial` is adopted during render without restarting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    snapshot: state.snapshot,
    now: snapshotNow(state),
    error: state.error,
    signedOut: state.signedOut,
  };
}
