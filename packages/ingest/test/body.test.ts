import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readBoundedBody } from '../src/index.ts';

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://example.test/api/v1/events', { method: 'POST', body, headers });

describe('readBoundedBody', () => {
  it('reads plain UTF-8 under the limit', async () => {
    expect(await readBoundedBody(req('{"a":"ü"}'), 100)).toEqual({ ok: true, text: '{"a":"ü"}' });
  });

  it('inflates gzip and applies the limit to the inflated size', async () => {
    const text = JSON.stringify({ events: ['x'.repeat(50)] });
    expect(
      await readBoundedBody(req(gzipSync(text), { 'content-encoding': 'gzip' }), 1000),
    ).toEqual({ ok: true, text });
    expect(await readBoundedBody(req(gzipSync(text), { 'content-encoding': 'gzip' }), 20)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('stops a gzip bomb: 10 MB of zeros compressed to ~10 KB', async () => {
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(20 * 1024);
    expect(await readBoundedBody(req(bomb, { 'content-encoding': 'gzip' }), 256 * 1024)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('rejects plain bodies over the limit', async () => {
    expect(await readBoundedBody(req('x'.repeat(101)), 100)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('rejects corrupt gzip, invalid UTF-8, empty bodies and unknown encodings', async () => {
    const gz = { 'content-encoding': 'gzip' };
    expect((await readBoundedBody(req('not gzip', gz), 100)).ok).toBe(false);
    expect(await readBoundedBody(req(new Uint8Array([0xff, 0xfe])), 100)).toEqual({
      ok: false,
      reason: 'bad_encoding',
    });
    expect(await readBoundedBody(req(null), 100)).toEqual({ ok: false, reason: 'empty' });
    expect(await readBoundedBody(req('x', { 'content-encoding': 'br' }), 100)).toEqual({
      ok: false,
      reason: 'unsupported_encoding',
    });
  });
});
