import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateEvent } from '../src/index.ts';

// Shared conformance vectors (docs/jgr/conformance/vectors). Any JGR implementation —
// collectors, SDKs, the ingest gateway — must produce the same verdicts.
const dir = fileURLToPath(new URL('../../../docs/jgr/conformance/vectors/', import.meta.url));

type Vector = {
  description: string;
  receivedAt: string;
  event: unknown;
  expect: { ok: true } | { codes: string[] };
};

const vectors = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, JSON.parse(readFileSync(dir + f, 'utf8')) as Vector] as const);

describe('JGR v0.1 conformance vectors', () => {
  it('has both valid and invalid vectors', () => {
    expect(vectors.some(([f]) => f.startsWith('valid-'))).toBe(true);
    expect(vectors.some(([f]) => f.startsWith('invalid-'))).toBe(true);
  });

  it.each(vectors)('%s', (file, v) => {
    const result = validateEvent(v.event, new Date(v.receivedAt));
    if ('ok' in v.expect) {
      expect(result, `${file}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      expect(file.startsWith('valid-')).toBe(true);
    } else {
      expect(result.ok, file).toBe(false);
      const codes = result.ok ? [] : [...new Set(result.issues.map((i) => i.code))].sort();
      expect(codes).toEqual([...v.expect.codes].sort());
      expect(file.startsWith('invalid-')).toBe(true);
    }
  });
});
