import { describe, expect, it } from 'vitest';
import {
  canonicalEventId,
  JGR_LIMITS,
  validateBatch,
  validateEvent,
  type JgrEventInput,
} from '../src/index.ts';

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

describe('S3d hardening (ADR-0008 Changes)', () => {
  it('reports more than 100 events as too_large, not schema', () => {
    const many = Array.from({ length: JGR_LIMITS.maxBatchEvents + 1 }, (_, i) => event({}, i));
    const result = validateBatch({ events: many }, now);
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'too_large', path: 'events' }] });
  });

  it('canonicalizes event ids so letter case cannot defeat dedupe', () => {
    expect(canonicalEventId('01jbz4xq800000000000000001')).toBe('01JBZ4XQ800000000000000001');
    expect(canonicalEventId('0B8F0C2E-6D3A-4C8E-9F1B-2A3C4D5E6F70')).toBe(
      '0b8f0c2e-6d3a-4c8e-9f1b-2a3c4d5e6f70',
    );
    const lower = validateEvent(event({ event_id: '01jbz4xq800000000000000001' }), now);
    expect(lower.ok && lower.event.event_id).toBe('01JBZ4XQ800000000000000001');
  });

  it('accepts only well-formed UUIDs (36 hyphens are not an id)', () => {
    expect(validateEvent(event({ event_id: '-'.repeat(36) }), now).ok).toBe(false);
    expect(validateEvent(event({ event_id: '0b8f0c2e-6d3a-4c8e-9f1b-2a3c4d5e6f70' }), now).ok).toBe(
      true,
    );
  });
});
