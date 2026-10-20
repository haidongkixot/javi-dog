/** WCAG 2.1 relative luminance and contrast ratio for `#RRGGBB` colors. */

const channel = (value: number): number => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export const parseHex = (hex: string): [number, number, number] => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB color, got "${hex}"`);
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

export const relativeLuminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** WCAG 2.1 AA thresholds. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
