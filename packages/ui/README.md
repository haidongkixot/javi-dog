# JD-M13 · `@javis-dog/ui` — Design system

Status: **in-progress** (S0: tokens; S1: components). Decision record: [ADR-0003](../../docs/adr/0003-brand-to-design-tokens.md). Brand source: [BRAND_GUIDE](../../docs/brand/BRAND_GUIDE.md).

## Public contract

| Export | Description |
|---|---|
| `palette`, `neutrals`, `sidebar`, `status`, `action` | Raw brand values (hex) |
| `radius`, `shadow`, `font`, `typeScale`, `space`, `breakpoints` | Shape, type and layout tokens |
| `themes` | Semantic roles per theme (light only — decision D2) |
| `textPairs(theme)` | Text/background pairs that must meet WCAG AA |
| `contrastRatio`, `relativeLuminance`, `parseHex`, `AA_NORMAL_TEXT`, `AA_LARGE_TEXT` | WCAG 2.1 utilities |
| `renderTokensCss()` | Renders the CSS custom properties |
| `@javis-dog/ui/tokens.css` | Generated CSS: `--jd-<role>` variables on `:root, [data-theme='light']` |

## Rules

- Components and apps use **semantic** variables (`var(--jd-text-muted)`), never raw hex.
- Pastels (mint, yellow, sky, coral) are fills, never text on light surfaces.
- Status is always pill + text label.
- After editing `src/tokens.ts`, run `pnpm --filter @javis-dog/ui tokens:build`; CI runs `tokens:check`.

## Tests

`pnpm --filter @javis-dog/ui test` — palette fidelity, theme role parity, CSS rendering, and WCAG AA for every pair in `textPairs`.
