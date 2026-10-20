import { describe, expect, it } from 'vitest';
import { renderTokensCss } from '../src/css.ts';
import { palette, themes } from '../src/tokens.ts';

describe('brand palette', () => {
  it('matches the Concept 0.1 brand kit exactly (BRAND_GUIDE §3)', () => {
    expect(palette).toEqual({
      packNight: '#252347',
      signalViolet: '#6E62F6',
      goodSignalMint: '#A0EBC2',
      alertCoral: '#FF907E',
      focusYellow: '#FFE18C',
      clearSky: '#91DEF3',
    });
  });
});

describe('themes', () => {
  it('ships light only for the MVP (decision D2)', () => {
    expect(Object.keys(themes)).toEqual(['light']);
  });

  it('every theme defines the same semantic roles', () => {
    const roles = Object.values(themes).map((t) => Object.keys(t).sort().join(','));
    expect(new Set(roles).size).toBe(1);
  });
});

describe('renderTokensCss', () => {
  const css = renderTokensCss();

  it('exposes semantic roles as --jd-* custom properties', () => {
    expect(css).toContain('--jd-text: #252347;');
    expect(css).toContain('--jd-status-ok-text: #227D58;');
    expect(css).toContain('--jd-radius-card: 18px;');
  });

  it('scopes the light theme to :root and [data-theme="light"]', () => {
    expect(css).toContain(":root,\n[data-theme='light'] {");
  });
});
