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

describe('JD-C02 Codex contract (ADR-0016 S5c)', async () => {
  const codex = await import('../src/index.ts');
  it('registers the allowlisted Codex hook events and prices only API-key auth', () => {
    expect(codex.CODEX_HOOK_EVENTS).toContain('PermissionRequest');
    expect(codex.CODEX_THREAD_PREFIX).toBe('cx');
    expect(codex.CODEX_PRICED_AUTH_MODES).toEqual(['ApiKey']);
  });

  it('has no event-id key material of its own: JD-C01 codex-usage.ts is the single id formula (S5c review L6)', () => {
    expect(codex).not.toHaveProperty('codexEventIdInput');
  });
});
