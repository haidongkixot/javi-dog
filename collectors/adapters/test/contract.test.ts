import { describe, expect, it } from 'vitest';
import { GEMINI_HOOK_EVENTS, GEMINI_PRICES, GEMINI_TOKEN_METRIC } from '../src/index.ts';

describe('JD-C02 contract (ADR-0016)', () => {
  it('registers the allowlisted Gemini hook events', () => {
    expect(GEMINI_HOOK_EVENTS).toEqual([
      'SessionStart',
      'SessionEnd',
      'BeforeAgent',
      'AfterAgent',
      'BeforeTool',
      'AfterTool',
      'Notification',
    ]);
    expect(GEMINI_TOKEN_METRIC).toBe('gemini_cli.token.usage');
  });

  it('dates and sources the price table', () => {
    expect(GEMINI_PRICES.source).toMatch(/^https:\/\/cloud\.google\.com\//);
    expect(GEMINI_PRICES.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
