# JD-APP · `@javis-dog/web` — Web application

Status: **in-progress**. Next.js 16 App Router (ADR-0002), styled exclusively through JD-M13 tokens mapped into Tailwind v4 (`src/app/globals.css`).

## Today (S0)

A single foundation page that discloses that no backend is connected (product rule 4). No sample metrics are shown.

## Next (S1)

The five-space shell from the brand template — Overview, Projects, Live agents, Token network (concept only), JGR & Integrations — with empty / loading / stale / not-connected states.

## Commands

```bash
pnpm --filter @javis-dog/web dev     # local dev server
pnpm --filter @javis-dog/web build   # production build
```
