import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  estimateGeminiCostUsd,
  findGeminiPrice,
  GEMINI_PRICES,
  geminiUsageDelta,
} from '../src/index.ts';

const OCT_2026 = new Date('2026-10-29T12:00:00Z');
const LAST_INTRO_MS = new Date('2026-12-31T23:59:59.999Z');
const FIRST_LATER_MS = new Date('2027-01-01T00:00:00.000Z');

describe('geminiUsageDelta — input − cache rule (ADR-0016 §3, spec §14 2026-10-29)', () => {
  it('subtracts cached tokens from input and keeps the other counters as is', () => {
    expect(
      geminiUsageDelta(
        { input_tokens: 1000, cache_read_tokens: 300, output_tokens: 200, reasoning_tokens: 50 },
        'unpriced-model',
        OCT_2026,
      ),
    ).toEqual({
      input_tokens: 700,
      cache_read_tokens: 300,
      output_tokens: 200,
      reasoning_tokens: 50,
      estimated: false,
    });
  });

  it('clamps input at 0 when the cache delta is larger', () => {
    expect(
      geminiUsageDelta({ input_tokens: 100, cache_read_tokens: 300 }, 'unpriced-model', OCT_2026),
    ).toEqual({ input_tokens: 0, cache_read_tokens: 300, estimated: false });
  });

  it('keeps zeros, leaves absent counters absent and copies no other key', () => {
    expect(geminiUsageDelta({ input_tokens: 500 }, 'unpriced-model', OCT_2026)).toEqual({
      input_tokens: 500,
      estimated: false,
    });
    expect(geminiUsageDelta({ cache_read_tokens: 40 }, 'unpriced-model', OCT_2026)).toEqual({
      cache_read_tokens: 40,
      estimated: false,
    });
    expect(
      geminiUsageDelta(
        { input_tokens: 0, output_tokens: 0, cache_write_tokens: 9 },
        'unpriced-model',
        OCT_2026,
      ),
    ).toEqual({ input_tokens: 0, output_tokens: 0, estimated: false });
  });
});

describe('geminiUsageDelta — estimated cost from the dated table', () => {
  it('gemini-2.5-pro: $1.25 in / $0.125 cached / $10 out, reasoning billed as output', () => {
    // (700 × 1.25 + 300 × 0.125 + (200 + 50) × 10) / 1e6 = 3412.5 / 1e6
    expect(
      geminiUsageDelta(
        { input_tokens: 1000, cache_read_tokens: 300, output_tokens: 200, reasoning_tokens: 50 },
        'gemini-2.5-pro',
        OCT_2026,
      ),
    ).toEqual({
      input_tokens: 700,
      cache_read_tokens: 300,
      output_tokens: 200,
      reasoning_tokens: 50,
      cost_usd: 0.0034125,
      estimated: true,
    });
  });

  it('gemini-3.5-flash: $1.50 in / $0.15 cached / $9 out', () => {
    // (1.5M × 1.5 + 0.5M × 0.15 + 0.1M × 9) / 1e6 = 2.25 + 0.075 + 0.9
    const usage = geminiUsageDelta(
      { input_tokens: 2_000_000, cache_read_tokens: 500_000, output_tokens: 100_000 },
      'gemini-3.5-flash',
      OCT_2026,
    );
    expect(usage).toMatchObject({ input_tokens: 1_500_000, cost_usd: 3.225, estimated: true });
  });

  it('gemini-3.8-flash: introductory price through 2026-12-31, later price from 2027-01-01', () => {
    const delta = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(geminiUsageDelta(delta, 'gemini-3.8-flash', OCT_2026).cost_usd).toBe(4.5);
    expect(geminiUsageDelta(delta, 'gemini-3.8-flash', LAST_INTRO_MS).cost_usd).toBe(4.5);
    expect(geminiUsageDelta(delta, 'gemini-3.8-flash', FIRST_LATER_MS).cost_usd).toBe(9);
    expect(findGeminiPrice('gemini-3.8-flash', LAST_INTRO_MS)).toMatchObject({
      inputPerM: 0.75,
      cachedInputPerM: 0.075,
      outputPerM: 3.75,
      validUntil: '2027-01-01',
    });
    expect(findGeminiPrice('gemini-3.8-flash', FIRST_LATER_MS)).toMatchObject({
      inputPerM: 1.5,
      cachedInputPerM: 0.15,
      outputPerM: 7.5,
      validFrom: '2027-01-01',
    });
  });

  it('unknown models get tokens only: no cost_usd and estimated false', () => {
    for (const model of [
      'gemini-9-ultra',
      'Gemini-2.5-Pro',
      'gemini-2.5-pro-preview-05-06',
      'models/gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3.1-pro',
      '',
    ]) {
      const usage = geminiUsageDelta({ input_tokens: 10, output_tokens: 5 }, model, OCT_2026);
      expect(usage, model).toEqual({ input_tokens: 10, output_tokens: 5, estimated: false });
      expect(usage).not.toHaveProperty('cost_usd');
    }
  });

  it('an invalid date has no price', () => {
    expect(estimateGeminiCostUsd('gemini-2.5-pro', { input_tokens: 1 }, new Date('x'))).toBeNull();
  });

  it('rounds to 1e-9 USD without float noise', () => {
    // 1 × 0.30 + 1 × 2.50 = 2.8 per 1M → 0.0000028
    expect(
      estimateGeminiCostUsd('gemini-2.5-flash', { input_tokens: 1, output_tokens: 1 }, OCT_2026),
    ).toBe(0.0000028);
    expect(estimateGeminiCostUsd('gemini-2.5-flash-lite', { cache_read_tokens: 3 }, OCT_2026)).toBe(
      0.00000003,
    );
    expect(estimateGeminiCostUsd('gemini-2.5-pro', {}, OCT_2026)).toBe(0);
  });

  it('produces a usage_delta that a JGR v0.1 usage.reported event accepts', () => {
    const usage = geminiUsageDelta(
      { input_tokens: 1200, cache_read_tokens: 200, output_tokens: 30, reasoning_tokens: 12 },
      'gemini-3.1-pro-preview',
      OCT_2026,
    );
    for (const usage_delta of [
      { ...usage, model: 'gemini-3.1-pro-preview' },
      { ...geminiUsageDelta({ input_tokens: 5 }, 'unknown', OCT_2026), model: 'unknown' },
    ]) {
      const event = {
        jgr: '0.1',
        event_id: '01JBZ4XQ800000000000000002',
        producer_id: 'prod_test',
        project_ref: 'web-app',
        thread_ref: 'gm_0123456789abcdef0123456789abcdef',
        sequence: 0,
        type: 'usage.reported',
        occurred_at: '2026-10-29T12:00:00Z',
        usage_delta,
        attributes: { platform: 'gemini-cli', collector_version: '0.2.0' },
      };
      expect(validateEvent(event, new Date('2026-10-29T12:01:00Z'))).toMatchObject({ ok: true });
    }
  });
});

describe('GEMINI_PRICES — table shape', () => {
  it('covers the models Gemini CLI uses', () => {
    for (const model of [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
    ]) {
      expect(findGeminiPrice(model, OCT_2026), model).not.toBeNull();
      expect(findGeminiPrice(model, FIRST_LATER_MS), model).not.toBeNull();
    }
  });

  it('has lower-case ids, positive prices, cached < input, and no overlapping windows', () => {
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    for (const row of GEMINI_PRICES.models) {
      expect(row.model).toMatch(/^gemini-\d+(?:\.\d+)?(?:-[a-z]+)+$/);
      expect(row.inputPerM).toBeGreaterThan(0);
      expect(row.outputPerM).toBeGreaterThan(row.inputPerM);
      expect(row.cachedInputPerM).toBeGreaterThan(0);
      expect(row.cachedInputPerM).toBeLessThan(row.inputPerM);
      if (row.validFrom !== undefined) expect(row.validFrom).toMatch(DATE);
      if (row.validUntil !== undefined) expect(row.validUntil).toMatch(DATE);
    }
    const byModel = new Map<string, Array<(typeof GEMINI_PRICES.models)[number]>>();
    for (const row of GEMINI_PRICES.models) {
      byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
    }
    for (const [model, rows] of byModel) {
      if (rows.length === 1) {
        expect(rows[0]?.validFrom, model).toBeUndefined();
        expect(rows[0]?.validUntil, model).toBeUndefined();
        continue;
      }
      // Two rows: an introductory window that ends exactly where the later price starts.
      expect(rows, model).toHaveLength(2);
      const [intro, later] = rows;
      expect(intro?.validFrom).toBeUndefined();
      expect(later?.validUntil).toBeUndefined();
      expect(intro?.validUntil).toBe(later?.validFrom);
    }
  });
});
