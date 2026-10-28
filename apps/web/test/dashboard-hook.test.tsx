// @vitest-environment jsdom
import type { DashboardSnapshot } from '@javis-dog/realtime';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  SNAPSHOT_URL,
  useDashboardSnapshot,
} from '@/components/dashboard/use-dashboard-snapshot';

const snap = (generatedAt: string): DashboardSnapshot => ({
  generatedAt,
  freshnessWindowMs: 180_000,
  windowHours: 24,
  overview: {
    activeProjects: { value: 0, lastSignalAt: null },
    agentsWorking: { value: 0, lastSignalAt: null },
    tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
    tasksCompleted24h: { value: 0, lastSignalAt: null },
  },
  threads: [],
  activity: [],
  projects: [],
});

const FIRST = snap('2026-10-28T10:00:00.000Z');
const SECOND = snap('2026-10-28T10:00:10.000Z');

const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body });
const status = (code: number) => ({
  status: code,
  ok: false,
  json: async () => ({ error: 'x' }),
});

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const fetchMock = vi.fn();
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T10:00:05.000Z'));
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok(SECOND));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useDashboardSnapshot (ADR-0012 polling)', () => {
  it('starts from the server snapshot and fetches every 10 s while visible', async () => {
    const { result } = renderHook(() => useDashboardSnapshot(FIRST));
    expect(result.current).toEqual({ snapshot: FIRST, error: null, signedOut: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await tick(POLL_INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(SNAPSHOT_URL);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    expect(result.current.snapshot).toEqual(SECOND);

    await tick(POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('pauses while hidden and refreshes immediately on becoming visible', async () => {
    renderHook(() => useDashboardSnapshot(FIRST));
    await tick(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await tick(POLL_INTERVAL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back on the 10 s cadence from the visible refresh, not a burst.
    await tick(POLL_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not poll when the page starts hidden', async () => {
    visibility = 'hidden';
    renderHook(() => useDashboardSnapshot(FIRST));
    await tick(POLL_INTERVAL_MS * 5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 500 answer', () => Promise.resolve(status(500))],
    ['a 503 answer', () => Promise.resolve(status(503))],
    ['a malformed body', () => Promise.resolve(ok({ nope: true }))],
  ])('keeps the last snapshot and reports an error after %s', async (_name, fail) => {
    fetchMock.mockImplementation(fail);
    const { result } = renderHook(() => useDashboardSnapshot(FIRST));
    await tick(POLL_INTERVAL_MS);
    expect(result.current.snapshot).toEqual(FIRST);
    expect(result.current.error?.since).toBeInstanceOf(Date);
    expect(result.current.signedOut).toBe(false);
    const since = result.current.error!.since;

    // Still failing: the first failure time is kept; polling continues.
    await tick(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error?.since).toBe(since);

    // Recovers: the error clears and the new snapshot shows.
    fetchMock.mockResolvedValue(ok(SECOND));
    await tick(POLL_INTERVAL_MS);
    expect(result.current).toEqual({ snapshot: SECOND, error: null, signedOut: false });
  });

  it('reports a signed-out state on 401 and stops polling', async () => {
    fetchMock.mockResolvedValue(status(401));
    const { result } = renderHook(() => useDashboardSnapshot(FIRST));
    await tick(POLL_INTERVAL_MS);
    expect(result.current.signedOut).toBe(true);
    expect(result.current.error).toBeNull();
    await tick(POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches right away when the server could not provide a first snapshot', async () => {
    const { result } = renderHook(() => useDashboardSnapshot(null));
    expect(result.current.error).not.toBeNull();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ snapshot: SECOND, error: null, signedOut: false });
  });

  it('stops polling after unmount', async () => {
    const { unmount } = renderHook(() => useDashboardSnapshot(FIRST));
    unmount();
    await tick(POLL_INTERVAL_MS * 3);
    act(() => setVisibility('visible'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
