import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio, parseHex } from '../src/contrast.ts';
import { textPairs, themes, type ThemeName } from '../src/tokens.ts';

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Measured in BRAND_GUIDE §3: Pack Night on white.
    expect(contrastRatio('#252347', '#FFFFFF')).toBeCloseTo(14.89, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#6E62F6', '#FFFFFF')).toBe(contrastRatio('#FFFFFF', '#6E62F6'));
  });

  it('rejects malformed colors', () => {
    expect(() => parseHex('#FFF')).toThrow();
    expect(() => parseHex('red')).toThrow();
  });
});

describe.each(Object.keys(themes) as ThemeName[])('theme "%s"', (theme) => {
  it.each(textPairs(theme))('%s meets WCAG AA', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});
