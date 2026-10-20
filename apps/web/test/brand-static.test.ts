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

// Raw colors: #rgb, #rgba, #rrggbb, #rrggbbaa and CSS color functions.
const RAW_COLOR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;

describe('guard self-test: the raw-color pattern can fail', () => {
  it.each(['#7c5cff80', '#ffff', '#fff', '#252347', 'rgb(1, 2, 3)', 'oklch(0.5 0.1 200)'])(
    'catches %s',
    (text) => {
      expect(text.match(RAW_COLOR)).not.toBeNull();
    },
  );

  it.each(['var(--jd-text)', 'bg-ok-bg text-ok', 'href="#main"'])('ignores %s', (text) => {
    expect(text.match(RAW_COLOR)).toBeNull();
  });
});

describe('no raw colors in UI code', () => {
  it.each(roots.flatMap(files))('%s', (file) => {
    const text = readFileSync(file, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(text.match(RAW_COLOR) ?? []).toEqual([]);
  });
});
