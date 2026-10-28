import { describe, expect, it } from 'vitest';
import { BUDGET_THRESHOLDS, FORECAST_MIN_ELAPSED_MS, MAX_MONTHLY_LIMIT_USD } from '../src/index.ts';

describe('JD-M12 contract constants (ADR-0014)', () => {
  it('alerts at 80 % and 100 %, forecasts after 24 h, caps limits at 1 000 000 USD', () => {
    expect(BUDGET_THRESHOLDS).toEqual([80, 100]);
    expect(FORECAST_MIN_ELAPSED_MS).toBe(86_400_000);
    expect(MAX_MONTHLY_LIMIT_USD).toBe(1_000_000);
  });
});
