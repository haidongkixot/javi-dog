import { describe, expect, it } from 'vitest';
import { ANALYTICS_DEFAULT_DAYS, ANALYTICS_MAX_DAYS } from '../src/index.ts';

describe('JD-M08 contract constants (ADR-0013)', () => {
  it('defaults to 14 UTC days and never exceeds the 30-day raw-event retention', () => {
    expect(ANALYTICS_DEFAULT_DAYS).toBe(14);
    expect(ANALYTICS_MAX_DAYS).toBe(30);
  });
});
