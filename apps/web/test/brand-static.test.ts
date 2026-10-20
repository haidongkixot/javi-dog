import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Brand rule: components use semantic token utilities, never raw hex (ADR-0003).
const roots = ['../src', '../../../packages/ui/src/components'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|css)$/.test(name) && !name.endsWith('.svg') ? [full] : [];
  });

describe('no raw hex colors in UI code', () => {
  it.each(roots.flatMap(files))('%s', (file) => {
    const text = readFileSync(file, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []).toEqual([]);
  });
});
