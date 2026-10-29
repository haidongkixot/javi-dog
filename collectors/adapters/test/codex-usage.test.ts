import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  CODEX_PRICED_AUTH_MODES,
  codexCostDelta,
  codexThreadRef,
  codexUsageDelta,
  parseCodexLogs,
  type CodexCostRecord,
  type CodexTokenRecord,
} from '../src/index.ts';

const CONV = '019a3c5e-7f3a-7c11-9d2e-codex-root';

const token = (overrides: Partial<CodexTokenRecord> = {}): CodexTokenRecord => ({
  conversationId: CONV,
  model: 'gpt-5.5-codex',
  authMode: 'ApiKey',
  timestamp: '2026-10-29T19:29:00.123Z',
  input: 1000,
  cached: 400,
  cacheWrite: 100,
  output: 250,
  ...overrides,
});

const cost = (overrides: Partial<CodexCostRecord> = {}): CodexCostRecord => ({
  conversationId: CONV,
  turnId: 'turn-7',
  authMode: 'ApiKey',
  costUsd: 0.0125,
  ...overrides,
});

/** A full usage.reported envelope, as JD-C01 would build it, for schema validation. */
const envelope = (usageDelta: object) => ({
  jgr: '0.1',
  event_id: '01JBZ4XQ800000000000000001',
  producer_id: 'prod_test',
  project_ref: 'web-app',
  thread_ref: codexThreadRef(CONV, 'test-salt'),
  sequence: 0,
  type: 'usage.reported',
  occurred_at: '2026-10-29T00:00:00Z',
  usage_delta: usageDelta,
  attributes: { platform: 'codex-cli', collector_version: '0.3.0-test' },
});
const valid = (usageDelta: object) =>
  validateEvent(envelope(usageDelta), new Date('2026-10-29T00:01:00Z'));

describe('codexUsageDelta — cache-aware input (ADR-0016 Changes H3)', () => {
  it('input_tokens = input − cached − cache_write; cache counters and output as given', () => {
    const delta = codexUsageDelta(token());
    expect(delta).toEqual({
      input_tokens: 500,
      cache_read_tokens: 400,
      cache_write_tokens: 100,
      output_tokens: 250,
      model: 'gpt-5.5-codex',
      estimated: false,
    });
    expect(valid(delta)).toMatchObject({ ok: true });
  });

  it("matches Codex's official example: input 100 = cached 40 + cache write 60 → 0", () => {
    expect(codexUsageDelta(token({ input: 100, cached: 40, cacheWrite: 60 }))).toMatchObject({
      input_tokens: 0,
      cache_read_tokens: 40,
      cache_write_tokens: 60,
    });
  });

  it('clamps input_tokens at 0 when cached + cache_write exceed input', () => {
    const delta = codexUsageDelta(token({ input: 10, cached: 40, cacheWrite: 60 }));
    expect(delta.input_tokens).toBe(0);
    expect(valid(delta)).toMatchObject({ ok: true });
  });

  it('keeps zero counters (dropping empty records is the caller’s job)', () => {
    const delta = codexUsageDelta(token({ input: 0, cached: 0, cacheWrite: 0, output: 0 }));
    expect(delta).toMatchObject({
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
    });
    expect(valid(delta)).toMatchObject({ ok: true });
  });

  it('never carries auth mode, ids, timestamp, reasoning or a cost', () => {
    const delta = codexUsageDelta(token({ authMode: 'Chatgpt' }));
    expect(Object.keys(delta).sort()).toEqual(
      [
        'cache_read_tokens',
        'cache_write_tokens',
        'estimated',
        'input_tokens',
        'model',
        'output_tokens',
      ].sort(),
    );
    expect(JSON.stringify(delta)).not.toContain(CONV);
  });

  it('works end to end from a parsed logs body', () => {
    const body = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                    { key: 'event.kind', value: { stringValue: 'response.completed' } },
                    { key: 'input_token_count', value: { stringValue: '100' } },
                    { key: 'output_token_count', value: { stringValue: '7' } },
                    { key: 'cached_token_count', value: { intValue: '40' } },
                    { key: 'cache_write_token_count', value: { intValue: 60 } },
                    { key: 'tool_token_count', value: { stringValue: '107' } },
                    { key: 'event.timestamp', value: { stringValue: '2026-10-29T19:29:00.123Z' } },
                    { key: 'conversation.id', value: { stringValue: CONV } },
                    { key: 'model', value: { stringValue: 'gpt-5.5-codex' } },
                    { key: 'user.email', value: { stringValue: 'hai@example.com' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseCodexLogs(body);
    if (!result.ok) throw new Error(result.error);
    expect(result.tokens.map(codexUsageDelta)).toEqual([
      {
        input_tokens: 0,
        cache_read_tokens: 40,
        cache_write_tokens: 60,
        output_tokens: 7,
        model: 'gpt-5.5-codex',
        estimated: false,
      },
    ]);
  });
});

describe('codexCostDelta — cost only for API-key auth (ADR-0016 C5)', () => {
  it('ApiKey → { cost_usd, estimated: false }, valid as a usage.reported delta', () => {
    expect(CODEX_PRICED_AUTH_MODES).toEqual(['ApiKey']);
    const delta = codexCostDelta(cost());
    expect(delta).toEqual({ cost_usd: 0.0125, estimated: false });
    expect(valid(delta!)).toMatchObject({ ok: true });
  });

  it('rounds to 1e-9 USD', () => {
    expect(codexCostDelta(cost({ costUsd: 0.1234567894 }))).toEqual({
      cost_usd: 0.123456789,
      estimated: false,
    });
    expect(codexCostDelta(cost({ costUsd: 0.1234567895 }))?.cost_usd).toBe(0.12345679);
  });

  it('keeps a real zero cost from ApiKey (a parsed "0" is not a missing cost)', () => {
    expect(codexCostDelta(cost({ costUsd: 0 }))).toEqual({ cost_usd: 0, estimated: false });
  });

  it.each([['Chatgpt'], [null], ['apikey'], ['Bedrock'], ['']])(
    'auth mode %j → null (tokens only, no cost, no budget impact)',
    (authMode) => {
      expect(codexCostDelta(cost({ authMode }))).toBeNull();
    },
  );

  it('rejects a non-finite or negative cost even for ApiKey (caller-built records)', () => {
    expect(codexCostDelta(cost({ costUsd: Number.NaN }))).toBeNull();
    expect(codexCostDelta(cost({ costUsd: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(codexCostDelta(cost({ costUsd: -1 }))).toBeNull();
  });
});
