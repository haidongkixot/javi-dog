# JD-APP · `@javis-dog/web` — Web application

Status: **in-progress**. Next.js 16 App Router (ADR-0002), styled exclusively through JD-M13 tokens mapped into Tailwind v4 (`src/app/globals.css`).

## Today (S1a)

The five-space shell from the brand template, with a global "Preview build" disclosure (product rule 4):

| Route | Space | State today |
|---|---|---|
| `/` | Overview | Four KPIs render "No signal yet"; usage, activity, health and squad cards show empty states |
| `/projects` | Projects | Registry table with empty state; "Create project" disabled until sign-in (S2) |
| `/agents` | Live agents | Metrics "No signal yet"; inspector lists the JGR v0.1 fields it will show |
| `/token-network` | Token network | **Concept only** — safety principles and scope note; no numbers or exchange |
| `/integrations` | JGR & Integrations | Integration directory ("Connection not verified yet"), envelope draft, privacy classes, delivery targets labelled as hypotheses |

Tests: `test/shell.test.tsx` (navigation, aria-current, no live claims, no sample numbers) and `test/brand-static.test.ts` (no raw hex in UI code).

## Next

Sign-in and real projects (S2), then live data via JGR ingest (S3–S4).

## Commands

```bash
pnpm --filter @javis-dog/web dev     # local dev server
pnpm --filter @javis-dog/web build   # production build
```
