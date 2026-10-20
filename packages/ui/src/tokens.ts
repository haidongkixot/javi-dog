/**
 * JD-M13 design tokens — single source of truth for the Javi's Dog brand (ADR-0003).
 *
 * Brand hues are exact copies of the Concept 0.1 brand kit (docs/brand/BRAND_GUIDE.md).
 * Text tokens marked "AA" are the smallest same-hue adjustment that reaches WCAG 2.1 AA;
 * they are enforced by test/contrast.test.ts.
 */

/** Brand palette (BRAND_GUIDE §3). Never change these values without a brand decision. */
export const palette = {
  packNight: '#252347',
  signalViolet: '#6E62F6',
  goodSignalMint: '#A0EBC2',
  alertCoral: '#FF907E',
  focusYellow: '#FFE18C',
  clearSky: '#91DEF3',
} as const;

/** Neutrals and soft tints taken from the HTML template. */
export const neutrals = {
  paper: '#F6F7FB',
  white: '#FFFFFF',
  surfaceSubtle: '#FBFBFE',
  line: '#E9EAF2',
  cardBorder: '#EBECF3',
  /** Template secondary text (#7D7D97, 4.00:1) adjusted for AA. */
  mutedText: '#6E6E8A',
  /** Decorative / disabled only — 2.42:1, never body text. */
  decorative: '#A4A5BA',
  violetSoft: '#EFEDFF',
  mintDeep: '#198F62',
  coralSoft: '#FFF0ED',
  yellowSoft: '#FFF8DF',
  skySoft: '#EAFAFF',
} as const;

/** Dark sidebar surface (Pack Night). */
export const sidebar = {
  bg: palette.packNight,
  hover: '#302E53',
  active: '#46416E',
  border: '#42405F',
  text: '#BFBED4',
  textActive: '#FFFFFF',
  /** Template nav label (#8987AA, 4.33:1) adjusted for AA. */
  label: '#8F8DAE',
  marker: palette.goodSignalMint,
} as const;

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'protocol';

/** Status pills: always pill + text label, never color alone. Text values are AA. */
export const status: Record<StatusTone, { bg: string; text: string }> = {
  ok: { bg: '#E8F9EF', text: '#227D58' },
  warn: { bg: '#FFF7DC', text: '#8C6B18' },
  danger: { bg: '#FFF0ED', text: '#BC4637' },
  info: { bg: '#E9F9FF', text: '#1E788F' },
  protocol: { bg: '#EEECFF', text: '#6051EF' },
};

/** Primary action. Background adjusted from #6E62F6 (4.43:1 with white) for AA. */
export const action = {
  primaryBg: '#6A5DF6',
  primaryBgHover: '#5C50E7',
  primaryText: '#FFFFFF',
} as const;

export const radius = {
  card: '18px',
  control: '11px',
  small: '8px',
  pill: '7px',
  tile: '33%',
} as const;

export const shadow = {
  card: '0 8px 30px rgba(37, 35, 71, 0.045)',
  primary: '0 5px 12px rgba(110, 98, 246, 0.15)',
} as const;

export const font = {
  sans: '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Minimum product type sizes (BRAND_GUIDE §3 rule 4). */
export const typeScale = {
  label: '11px',
  body: '12px',
  bodyLarge: '13px',
  cardTitle: '14px',
  metric: '29px',
  pageTitle: '29px',
  pageTitleMobile: '24px',
} as const;

/** Spacing rhythm: 4 / 8 px multiples. */
export const space = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
} as const;

export const breakpoints = {
  wide: 1150,
  tablet: 850,
  phone: 560,
} as const;

export type ThemeName = 'light';

/**
 * Semantic theme. Components use only these roles (as CSS variables), never raw hex,
 * so a future dark theme is a new entry here plus owner review (decision D2).
 */
export const themes: Record<ThemeName, Record<string, string>> = {
  light: {
    bg: neutrals.paper,
    surface: neutrals.white,
    'surface-subtle': neutrals.surfaceSubtle,
    border: neutrals.line,
    'border-card': neutrals.cardBorder,
    text: palette.packNight,
    'text-muted': neutrals.mutedText,
    'text-decorative': neutrals.decorative,
    accent: palette.signalViolet,
    'accent-soft': neutrals.violetSoft,
    positive: neutrals.mintDeep,
    'focus-ring': palette.signalViolet,
    'primary-bg': action.primaryBg,
    'primary-bg-hover': action.primaryBgHover,
    'primary-text': action.primaryText,
    'sidebar-bg': sidebar.bg,
    'sidebar-hover': sidebar.hover,
    'sidebar-active': sidebar.active,
    'sidebar-border': sidebar.border,
    'sidebar-text': sidebar.text,
    'sidebar-text-active': sidebar.textActive,
    'sidebar-label': sidebar.label,
    'sidebar-marker': sidebar.marker,
    ...Object.fromEntries(
      Object.entries(status).flatMap(([tone, c]) => [
        [`status-${tone}-bg`, c.bg],
        [`status-${tone}-text`, c.text],
      ]),
    ),
  },
};

/** Text/background pairs that must meet WCAG AA (4.5:1) in every theme. */
export const textPairs = (theme: ThemeName): Array<[label: string, fg: string, bg: string]> => {
  const t = themes[theme];
  const pairs: Array<[string, string, string]> = [
    ['text on bg', t.text!, t.bg!],
    ['text on surface', t.text!, t.surface!],
    ['text-muted on bg', t['text-muted']!, t.bg!],
    ['text-muted on surface', t['text-muted']!, t.surface!],
    ['text-muted on surface-subtle', t['text-muted']!, t['surface-subtle']!],
    ['primary-text on primary-bg', t['primary-text']!, t['primary-bg']!],
    ['primary-text on primary-bg-hover', t['primary-text']!, t['primary-bg-hover']!],
    ['sidebar-text on sidebar-bg', t['sidebar-text']!, t['sidebar-bg']!],
    ['sidebar-text on sidebar-active', t['sidebar-text']!, t['sidebar-active']!],
    ['sidebar-text-active on sidebar-active', t['sidebar-text-active']!, t['sidebar-active']!],
    ['sidebar-label on sidebar-bg', t['sidebar-label']!, t['sidebar-bg']!],
  ];
  for (const tone of Object.keys(status)) {
    pairs.push([
      `status-${tone}-text on its bg`,
      t[`status-${tone}-text`]!,
      t[`status-${tone}-bg`]!,
    ]);
    pairs.push([`status-${tone}-text on surface`, t[`status-${tone}-text`]!, t.surface!]);
  }
  return pairs;
};
