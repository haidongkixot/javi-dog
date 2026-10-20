import { describe, expect, it } from 'vitest';
import { JGR_LIMITS, validateBatch, validateEvent, type JgrEventInput } from '../src/index.ts';

const now = new Date('2026-10-20T19:00:00Z');
const event = (overrides: Partial<JgrEventInput> = {}, index = 1): JgrEventInput => ({
  jgr: '0.1',
  event_id: `01JBZ4XQ8000000000000000${String(index).padStart(2, '0')}`,
  producer_id: 'prod_test',
  project_ref: 'proj',
  thread_ref: 'sess_1',
  sequence: index,
  type: 'heartbeat',
  status: 'working',
  occurred_at: '2026-10-20T18:59:00Z',
  ...overrides,
});

describe('validateEvent', () => {
  it('defaults privacy_class to L0 and usage estimated to false', () => {
    const r = validateEvent(
      event({ type: 'usage.reported', usage_delta: { input_tokens: 10 } }),
      now,
    );
    expect(r.ok && r.event.privacy_class).toBe('L0');
    expect(r.ok && r.event.usage_delta?.estimated).toBe(false);
  });

  it('rejects an oversize event before parsing', () => {
    const big = event({ attributes: { model: 'x'.repeat(100) } });
    const padded = { ...big, thread_ref: 's'.repeat(JGR_LIMITS.maxEventBytes) };
    const r = validateEvent(padded, now);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]?.code).toBe('too_large');
  });

  it('rejects an empty usage_delta', () => {
    const r = validateEvent(event({ type: 'usage.reported', usage_delta: { model: 'm' } }), now);
    expect(r.ok).toBe(false);
  });

  it('accepts timestamps slightly in the future (clock skew tolerance)', () => {
    expect(validateEvent(event({ occurred_at: '2026-10-20T19:04:00Z' }), now).ok).toBe(true);
  });
});

describe('validateBatch', () => {
  it('accepts valid events and reports rejected ones by index (partial acceptance)', () => {
    const r = validateBatch(
      { events: [event({}, 1), event({ status: undefined }, 2), event({}, 3)] },
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toEqual([
      expect.objectContaining({ index: 1, event_id: '01JBZ4XQ800000000000000002' }),
    ]);
  });

  it('rejects empty and oversize batches as a whole', () => {
    expect(validateBatch({ events: [] }, now).ok).toBe(false);
    const many = Array.from({ length: JGR_LIMITS.maxBatchEvents + 1 }, (_, i) => event({}, i));
    expect(validateBatch({ events: many }, now).ok).toBe(false);
  });
});
