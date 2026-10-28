import { describe, expect, it } from 'vitest';
import { FRESHNESS_WINDOW_MS, threadFreshness } from '../src/index.ts';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const before = (ms: number) => new Date(NOW.getTime() - ms);

describe('threadFreshness (ADR-0012, JGR §5)', () => {
  it('uses the JGR default window of 3 × 60 s', () => {
    expect(FRESHNESS_WINDOW_MS).toBe(180_000);
  });

  it.each([
    ['heartbeat', 0, 'fresh'],
    ['heartbeat', 179_999, 'fresh'],
    ['heartbeat', 180_000, 'fresh'],
    ['heartbeat', 180_001, 'stale'],
    ['task.completed', 3_600_000, 'stale'],
    ['session.ended', 0, 'ended'],
    ['session.ended', 179_999, 'ended'],
    ['session.ended', 180_001, 'ended'],
    ['session.ended', 3_600_000, 'ended'],
  ] as const)('%s received %i ms ago → %s', (type, ageMs, expected) => {
    expect(threadFreshness(type, before(ageMs), NOW)).toBe(expected);
  });

  it('honours a custom window, inclusive at its edge', () => {
    expect(threadFreshness('heartbeat', before(10_000), NOW, 10_000)).toBe('fresh');
    expect(threadFreshness('heartbeat', before(10_001), NOW, 10_000)).toBe('stale');
  });

  it('treats only the exact type session.ended as ended', () => {
    expect(threadFreshness('session.started', before(1), NOW)).toBe('fresh');
    expect(threadFreshness('x.vendor.session.ended', before(1), NOW)).toBe('fresh');
  });
});
