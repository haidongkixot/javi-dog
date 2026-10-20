// WCAG 2.1 contrast utilities with a minimal same-hue adjustment helper.
// Dependency-free; runs on Node 18+ or in a browser. Copy into your design-token package.
//
// CLI:
//   node contrast.mjs ratio  '#7D7D97' '#FFFFFF'
//   node contrast.mjs adjust '#7D7D97' '#FFFFFF' '#F6F7FB'   (target 4.6 by default)
//   TARGET=7 node contrast.mjs adjust '#555555' '#FFFFFF'

/** Parse `#RRGGBB` into [r, g, b] (0–255). Reject shorthand and names so mistakes fail loudly. */
export const parseHex = (hex) => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB color, got "${hex}"`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const toHex = (rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.1 relative luminance. */
export const relativeLuminance = (hex) => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG 2.1 contrast ratio, symmetric, in [1, 21]. */
export const contrastRatio = (a, b) => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AAA_NORMAL_TEXT = 7;

const rgbToHsl = ([r, g, b]) => {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h / 6, s, l];
};

const hslToRgb = ([h, s, l]) => {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
};

/**
 * Smallest same-hue lightness change that makes `fg` reach `target` against every
 * background in `bgs`. Hue and saturation are kept; only HSL lightness moves, darker on
 * light backgrounds and lighter on dark ones. Returns `fg` unchanged if it already passes,
 * or `null` if no lightness in [0, 1] reaches the target (pick a different color instead).
 */
export const adjustToContrast = (fg, bgs, target = 4.6, step = 0.005) => {
  const passes = (c) => bgs.every((bg) => contrastRatio(c, bg) >= target);
  if (passes(fg)) return fg;
  const [h, s, l0] = rgbToHsl(parseHex(fg));
  const darkerBgCount = bgs.filter((bg) => relativeLuminance(bg) < relativeLuminance(fg)).length;
  const direction = darkerBgCount > bgs.length / 2 ? 1 : -1;
  for (let l = l0 + direction * step; l >= 0 && l <= 1; l += direction * step) {
    const candidate = toHex(hslToRgb([h, s, l]));
    if (passes(candidate)) return candidate;
  }
  return null;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [cmd, fg, ...bgs] = process.argv.slice(2);
  if (cmd === 'ratio' && fg && bgs[0]) {
    console.log(contrastRatio(fg, bgs[0]).toFixed(2));
  } else if (cmd === 'adjust' && fg && bgs.length) {
    const target = Number(process.env.TARGET ?? 4.6);
    const out = adjustToContrast(fg, bgs, target);
    const ratios = out ? bgs.map((bg) => contrastRatio(out, bg).toFixed(2)).join(' / ') : '—';
    console.log(`${fg} -> ${out ?? 'no same-hue solution'} (${ratios})`);
  } else {
    console.error('Usage: contrast.mjs ratio <fg> <bg> | contrast.mjs adjust <fg> <bg> [bg...]');
    process.exit(2);
  }
}
