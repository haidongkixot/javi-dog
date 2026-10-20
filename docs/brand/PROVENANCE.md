# Brand Asset Provenance

| Asset | Origin | Received | SHA-256 | Status |
|---|---|---|---|---|
| `source/javis-dog-creative-proposal-concept-0.1.pdf` | Provided by project owner (Hai) in session | 2026-10-20 | `201ac0850384ec89c9d618ebb144d8cfa6ec4514962f394de5f91550d0c1c50b` | Concept 0.1 |
| `source/javis-dog-design-template-concept-0.1.html` | Provided by project owner (Hai) in session | 2026-10-20 | `3ad945387a996849657e7668c258e1d90d9c4618de4d92191c4c37526f0139f8` | Concept 0.1 |
| `apps/web/public/brand/javis-dog-mark.svg` | Extracted from the template's inline sidebar SVG; fill normalized `#282347` → `#252347` | 2026-10-20 | — | Concept 0.1 |
| `apps/web/public/brand/javis-dog-tile.svg` | Mark on mint tile (geometry from template `.brand-mark`: 40px tile, 13px radius, 35px mark) | 2026-10-20 | — | Concept 0.1 |
| `apps/web/public/brand/javis-dog-lockup-on-{dark,light}.svg` | Tile + wordmark + descriptor, typography per template `.brand-name` / `.brand-sub` | 2026-10-20 | — | Concept 0.1 |

## Open items

- **Trademark / name clearance: NOT DONE.** The proposal states "Final trademark/name clearance remains separate." Do not register domains, app-store listings or marketing using the mark as final until cleared.
- The proposal (slide 1) and the template show slightly different ear/face geometry. The template SVG is used as v0.1 by owner decision (2026-10-20). Replace all files above when an official logo package arrives.
- No dark theme is defined. MVP is light-only by owner decision (2026-10-20); tokens are theme-scoped so a dark theme can be added after beta with separate owner review.
- No raster exports (PNG/ICO) yet. Next.js serves `apps/web/src/app/icon.svg` (the tile) as the favicon; an Open Graph image is planned for S1.
- Inter is licensed under the SIL Open Font License 1.1 (self-hosted via `@fontsource-variable/inter`, bundled at build time — no call to Google Fonts).
