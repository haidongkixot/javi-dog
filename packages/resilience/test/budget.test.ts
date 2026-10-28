import { describe, expect, it } from 'vitest';
import { crossedThreshold, forecastSpend, percentOfLimit, utcMonth } from '../src/index.ts';

const DAY = 86_400_000;

describe('utcMonth (ADR-0014: UTC calendar month)', () => {
  it.each([
    ['2026-10-15T12:00:00Z', '2026-10', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 31],
    [
      '2026-11-30T23:59:59.999Z',
      '2026-11',
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
      30,
    ],
    [
      '2026-12-31T23:59:59.999Z',
      '2026-12',
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      31,
    ],
    ['2027-02-14T00:00:00Z', '2027-02', '2027-02-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z', 28],
    ['2028-02-29T08:00:00Z', '2028-02', '2028-02-01T00:00:00.000Z', '2028-03-01T00:00:00.000Z', 29],
    ['2026-01-01T00:00:00Z', '2026-01', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 31],
  ])('%s → %s', (now, key, start, end, days) => {
    const m = utcMonth(new Date(now));
    expect(m.key).toBe(key);
    expect(m.start.toISOString()).toBe(start);
    expect(m.end.toISOString()).toBe(end);
    expect(m.lengthMs).toBe(days * DAY);
  });

  it('uses UTC, not the local offset, at the month boundary', () => {
    // 23:30 on Oct 31 in UTC-5 is already November in UTC.
    expect(utcMonth(new Date('2026-10-31T23:30:00-05:00')).key).toBe('2026-11');
    expect(utcMonth(new Date('2026-11-01T00:30:00+05:00')).key).toBe('2026-10');
  });
});

describe('forecastSpend (linear, ≥ 24 h elapsed)', () => {
  it('is null before 24 h of the month have elapsed', () => {
    expect(forecastSpend(10, new Date('2026-10-01T00:00:00Z'))).toBeNull();
    expect(forecastSpend(10, new Date('2026-10-01T23:59:59.999Z'))).toBeNull();
  });

  it('projects spend × month length ÷ elapsed from exactly 24 h on', () => {
    // 1 of 31 days elapsed.
    expect(forecastSpend(10, new Date('2026-10-02T00:00:00Z'))).toBe(310);
    // Half of a 30-day month.
    expect(forecastSpend(12.5, new Date('2026-11-16T00:00:00Z'))).toBe(25);
    // Leap February: 14.5 of 29 days.
    expect(forecastSpend(7, new Date('2028-02-15T12:00:00Z'))).toBe(14);
  });

  it('rounds to 2 decimals', () => {
    // 1 × 31 / 3 = 10.3333…
    expect(forecastSpend(1, new Date('2026-10-04T00:00:00Z'))).toBe(10.33);
    // 2 × 31 / 3 = 20.6666…
    expect(forecastSpend(2, new Date('2026-10-04T00:00:00Z'))).toBe(20.67);
    expect(forecastSpend(0, new Date('2026-10-20T00:00:00Z'))).toBe(0);
  });
});

describe('crossedThreshold (80 % / 100 %)', () => {
  it.each([
    [79.99, 100, null],
    [80, 100, 80],
    [99.99, 100, 80],
    [100, 100, 100],
    [250, 100, 100],
    [0, 100, null],
    // Float traps: 0.8 × 0.29 and 0.1 + 0.2 must still compare exactly.
    [0.232, 0.29, 80],
    [0.231999, 0.29, null],
    [0.1 + 0.2, 0.3, 100],
    [0.29, 0.29, 100],
    [799_999.99, 1_000_000, null],
    [800_000, 1_000_000, 80],
    [999_999.999999, 1_000_000, 80],
    [1_000_000, 1_000_000, 100],
  ])('spend %s of limit %s → %s', (spend, limit, expected) => {
    expect(crossedThreshold(spend, limit)).toBe(expected);
  });

  it('refuses a limit ≤ 0 or non-finite, and a non-finite spend', () => {
    expect(() => crossedThreshold(10, 0)).toThrow(RangeError);
    expect(() => crossedThreshold(10, -5)).toThrow(RangeError);
    expect(() => crossedThreshold(10, Number.NaN)).toThrow(RangeError);
    expect(() => crossedThreshold(10, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => crossedThreshold(Number.NaN, 10)).toThrow(RangeError);
  });
});

describe('percentOfLimit (exact, floored to 0.01, never rounded up)', () => {
  it.each([
    [79.99, 100, 79.99],
    [79.999999, 100, 79.99],
    [99.99, 100, 99.99],
    [99.999999, 100, 99.99],
    [100, 100, 100],
    [6.2, 10, 62],
    [8.12, 10, 81.2],
    [0, 100, 0],
    [12.4, 10, 124],
    // 1 / 3 = 33.333… → 33.33; 2 / 3 = 66.666… → 66.66 (floored, not 66.67).
    [1, 3, 33.33],
    [2, 3, 66.66],
    // Float traps compare exactly, like crossedThreshold.
    [0.232, 0.29, 80],
    [0.1 + 0.2, 0.3, 100],
    [999_999.999999, 1_000_000, 99.99],
  ])('spend %s of limit %s → %s %%', (spend, limit, expected) => {
    expect(percentOfLimit(spend, limit)).toBe(expected);
  });

  it('agrees with crossedThreshold at both thresholds', () => {
    for (const [spend, limit] of [
      [79.999999, 100],
      [80, 100],
      [99.999999, 100],
      [100, 100],
      [0.231999, 0.29],
      [0.232, 0.29],
    ] as const) {
      const pct = percentOfLimit(spend, limit);
      const t = crossedThreshold(spend, limit);
      expect(pct >= 100).toBe(t === 100);
      expect(pct >= 80).toBe(t !== null);
    }
  });

  it('refuses a limit ≤ 0 or non-finite, and a non-finite spend', () => {
    expect(() => percentOfLimit(10, 0)).toThrow(RangeError);
    expect(() => percentOfLimit(Number.NaN, 10)).toThrow(RangeError);
  });
});
