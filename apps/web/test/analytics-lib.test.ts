import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { UsageAnalytics } from '@javis-dog/analytics';
import { afterEach, describe, expect, it, vi } from 'vitest';

// lib/analytics with injected fakes (TEST_PLAN §S4b): states, workspace from the viewer only,
// projectId pass-through, errors logged by name only.
vi.mock('@/lib/viewer', () => ({ getViewer: async () => null }));
vi.mock('@/lib/auth', () => ({ getDb: () => null }));

const { loadUsage, USAGE_DAYS } = await import('@/lib/analytics');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USAGE = { generatedAt: '2026-10-28T10:00:00.000Z' } as UsageAnalytics;

const fakes = (over: { db?: unknown; viewer?: unknown; usage?: () => Promise<unknown> } = {}) => {
  const usage = vi.fn(over.usage ?? (async () => USAGE));
  const getViewer = vi.fn(async () =>
    'viewer' in over ? (over.viewer as { workspaceId: string } | null) : { workspaceId: WS },
  );
  const reader = vi.fn(() => ({ usage }) as never);
  const deps = { getDb: () => ('db' in over ? over.db : { db: true }), getViewer, reader };
  return { deps, usage, getViewer, reader };
};

afterEach(() => vi.restoreAllMocks());

describe('loadUsage', () => {
  it('is "not configured" without a database and never looks up the session', async () => {
    const f = fakes({ db: null });
    expect(await loadUsage(f.deps)).toEqual({ kind: 'not_configured' });
    expect(f.getViewer).not.toHaveBeenCalled();
    expect(f.reader).not.toHaveBeenCalled();
  });

  it('is "signed out" without a viewer and never reads', async () => {
    const f = fakes({ viewer: null });
    expect(await loadUsage(f.deps)).toEqual({ kind: 'signed_out' });
    expect(f.usage).not.toHaveBeenCalled();
  });

  it('reads the viewer’s workspace for the last 14 days', async () => {
    const f = fakes();
    expect(await loadUsage(f.deps)).toEqual({ kind: 'ready', usage: USAGE });
    expect(USAGE_DAYS).toBe(14);
    expect(f.usage).toHaveBeenCalledExactlyOnceWith(WS, { days: 14 });
  });

  it('passes a project id through unchanged, inside the viewer’s workspace', async () => {
    const f = fakes();
    await loadUsage(f.deps, { projectId: PROJECT });
    expect(f.usage).toHaveBeenCalledExactlyOnceWith(WS, { days: 14, projectId: PROJECT });
  });

  it('ignores any workspace field in its input: the workspace comes from the viewer only', async () => {
    const f = fakes();
    await loadUsage(f.deps, { projectId: PROJECT, workspaceId: OTHER_WS } as never);
    expect(f.usage).toHaveBeenCalledExactlyOnceWith(WS, { days: 14, projectId: PROJECT });
  });

  it('is "unavailable" when the read fails and logs the error name only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakes({
      usage: async () => {
        throw new TypeError('connect postgres://user:secret@db.example/prod');
      },
    });
    expect(await loadUsage(f.deps)).toEqual({ kind: 'unavailable' });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ module: 'JD-APP', error: 'TypeError' });
    expect(line).not.toContain('secret');
    expect(line).not.toContain('postgres://');
  });

  it('is "unavailable" when the session lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakes();
    f.getViewer.mockRejectedValueOnce(new Error('db down'));
    expect(await loadUsage(f.deps)).toEqual({ kind: 'unavailable' });
    expect(f.usage).not.toHaveBeenCalled();
  });

  it('reads no request input (no headers, cookies, search params or request objects)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/lib/analytics.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(src).not.toMatch(/next\/headers|cookies\(|searchParams|Request\b|\breq\b/);
  });
});
