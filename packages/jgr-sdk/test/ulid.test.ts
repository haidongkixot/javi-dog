import { JgrEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import { createUlid } from '../src/index.ts';

describe('createUlid', () => {
  it('encodes the timestamp in the first 10 Crockford chars (spec example)', () => {
    const ulid = createUlid(() => new Uint8Array(16));
    expect(ulid(1469918176385).slice(0, 10)).toBe('01ARYZ6S41');
  });

  it('is monotonic within one millisecond and across a clock step backwards', () => {
    const ulid = createUlid(() => new Uint8Array(16));
    const a = ulid(1_000);
    const b = ulid(1_000);
    const c = ulid(999);
    expect(a < b && b < c).toBe(true);
    expect(c.slice(0, 10)).toBe(a.slice(0, 10));
    expect(b.slice(-2)).toBe('01');
  });

  it('throws instead of wrapping when the random part is exhausted (ULID spec)', () => {
    const ulid = createUlid(() => new Uint8Array(16).fill(31));
    ulid(1_000);
    expect(() => ulid(1_000)).toThrow(RangeError);
  });

  it('produces ids JD-M01 accepts and that sort by time', () => {
    const ulid = createUlid();
    const ids = [ulid(Date.UTC(2026, 9, 23)), ulid(Date.UTC(2026, 9, 24))];
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) {
      expect(JgrEvent.shape.event_id.safeParse(id).success).toBe(true);
    }
  });

  it('rejects timestamps outside 48 bits', () => {
    const ulid = createUlid();
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});
