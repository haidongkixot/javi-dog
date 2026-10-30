import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  FRESHNESS_WINDOW_MS,
  SNAPSHOT_WINDOW_HOURS,
  STATUS_REASONS,
} from '../src/index.ts';

// Contract constants fixed by JGR §5 and ADR-0012.
describe('JD-M07 contract constants', () => {
  it('derives stale after 3 × a 60 s heartbeat interval (JGR §5)', () => {
    expect(FRESHNESS_WINDOW_MS).toBe(3 * 60_000);
  });

  it('covers 24 h and shows the 25 newest activity items (ADR-0012)', () => {
    expect(SNAPSHOT_WINDOW_HOURS).toBe(24);
    expect(ACTIVITY_LIMIT).toBe(25);
  });

  it('freezes the ten self-report reasons of ADR-0017 §2', () => {
    expect(Object.isFrozen(STATUS_REASONS)).toBe(true);
    expect([...STATUS_REASONS]).toEqual([
      'needs_input',
      'needs_approval',
      'missing_credentials',
      'missing_access',
      'tests_failing',
      'ci_failing',
      'rate_limited',
      'dependency_down',
      'conflicting_requirements',
      'other',
    ]);
  });
});
