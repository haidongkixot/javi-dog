---
'@javis-dog/web': minor
---

S5f K6 — nonce-based Content Security Policy for every page (ADR-0018 decision 11, review M7). `src/proxy.ts` makes a fresh 128-bit base64 nonce per request and sends `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` (`'unsafe-eval'` added in `next dev` only); the root layout calls `connection()`, so `/integrations`, `/token-network` and the 404 page now render per request instead of being prerendered. `/api/*` is skipped by the proxy and keeps the static baseline policy from `next.config.ts`, which no longer sets a CSP for pages. New `pnpm --filter @javis-dog/web csp:check`: a bounded Playwright run (no screenshots, needs `next build`) that visits every page route and asserts zero CSP violations; not part of `pnpm test`.
