---
name: nonce-csp-rollout
description: Roll out a nonce-based Content Security Policy on a server-rendered web app (Next.js, Remix, SvelteKit, Rails, Django …) and prove it with a bounded, screenshot-free browser run — a fresh nonce per request on the request and the response, `'strict-dynamic'`, pages forced to render per request (a prerendered page carries no nonce), a deny-everything policy for JSON APIs, prefetches and static assets skipped, routes discovered from the file system so a new page cannot be missed, red runs that prove the check fails (nonce stripped, pages left static), production verified on public routes by counting `securitypolicyviolation` events, and features that need the CSP (keys or tokens remembered in the browser) gated on that evidence by one constant. Use before storing secrets, keys or tokens in the browser, when adding a CSP or moving from `'unsafe-inline'` to nonces, when a CSP "works locally" but nobody has counted violations, when a security review asks for XSS mitigation, or when asked to "add a CSP", "harden headers" or "verify the CSP in production" without screenshots.
metadata:
  version: "0.1.0"
  origin: "javis-dog ad-hoc-privacy (S5f, ADR-0018 decision 11)"
  confidence: "medium (one rollout: local check 12/12 routes with two red runs, production 6 public routes with 0 violations); low (signed-in pages and browsers other than Chromium: NOT RUN)"
---

# Nonce CSP rollout

A CSP is the main defence between an injected script and anything the page can use — session cookies, API calls, and in the origin, decryption keys held in the browser. A policy that "is set" proves little: a nonce the framework never stamped breaks the app, a prerendered page silently ships without the nonce, and a check that only looks at the header cannot see either. The evidence that counts is the browser's own violation events on every route.

The rule: **per-request nonce, per-request rendering, a bounded browser run that counts violations on every route and is shown to fail, and features that depend on the CSP gated on that run.**

## Forces

- **Strictness vs. framework behaviour.** Frameworks inline bootstrap scripts and styles. Nonces cover scripts; inline styles usually still need `'unsafe-inline'` for `style-src`.
- **Static speed vs. nonces.** A nonce must be unique per response, so pages that carry one cannot be prerendered or cached as HTML.
- **Evidence vs. screenshots.** Visual checks cannot see a blocked script; violation events can, without a single image.

## 1. Policy

```text
script-src 'self' 'nonce-<fresh per request>' 'strict-dynamic'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'
```

- Generate ≥ 128 random bits per request.
- Put the policy on the **request** headers (so the framework can read the nonce and stamp its scripts — Next.js reads it there) and on the **response**. Replace any CSP header the client sent, so a caller cannot choose the nonce.
- In development, add only what the dev server needs (for example `'unsafe-eval'`), behind an explicit dev flag.
- **APIs get their own policy:** JSON responses need no scripts — `default-src 'none'; script-src 'none'; frame-ancestors 'none'` (the origin's first API policy lacked the deny-all default; a review low).
- Skip the per-request work where it does not apply: API routes, static assets, image endpoints, and router prefetch requests (they carry data payloads, not documents).

## 2. Render per request

A page rendered at build time has no request, so no nonce, and its scripts are blocked (or, with a fallback, run without protection). Force dynamic rendering for every page that needs the policy — in the origin's Next.js 16 app, one `connection()` call in the root layout made the remaining static pages (two content pages and the 404) render per request. Accept the cost: HTML is no longer cached at the edge.

## 3. Bound the browser check before running it

Write the bounds into the script header:

- **Question:** does every route load with zero CSP violations under the real policy?
- **Matrix:** every page route **discovered from the file system** (dynamic segments filled with a sample value), plus a 404, the sign-in error page and an API path; one browser engine; one visit per route.
- **Signals:** `securitypolicyviolation` events and console CSP errors, counted per route; the response's policy header asserted (nonce present, `'strict-dynamic'` present; API policy equal to the expected string).
- **Screenshots:** none. **Output:** one JSON line per route plus a summary on stdout; nothing written to disk.
- **Exit codes:** 0 PASS, 1 FAIL (a violation or a header assertion), 2 could not run (no browser library, no build). Keep it out of the unit-test command; it needs a production build.

## 4. Prove the check can fail

Run it red before trusting it green:

| Mode | Expected | Origin result |
|---|---|---|
| Real policy | PASS | 12 of 12 routes |
| Nonce stripped from each page's policy (request interception) | FAIL | 1 of 12 passed |
| Pages left static (no per-request rendering) | FAIL | 8 of 12 passed |

Keep the red mode as a flag (`--policy=no-nonce`) so anyone can repeat it.

## 5. Production, bounded

After deploy: fetch the headers of the deployed commit, then load the **public** routes in one headless browser with the violation listener — no screenshots, no sign-in, no data changes. The origin loaded 6 public routes, 0 violations, with the framework runtime started. Pages behind sign-in are a separate run by the owner (or a test account the owner approves); until then they are NOT RUN.

## 6. Gate what depends on the CSP

If a feature is only safe with the CSP (remembering keys or tokens in IndexedDB or `localStorage`), put it behind **one constant** that names the evidence it waits for (`REMEMBER_ON_DEVICE_ENABLED = false // until the signed-in CSP run passes`). With the gate off, the UI does not offer the feature, and storage written by an earlier build is deleted. Test the feature's logic with the gate forced on in unit tests, so flipping it is a one-line change after the run.

## Pitfalls

- **A header check as evidence.** Only the browser's violation events show what was blocked.
- **Prerendered pages.** They carry no nonce.
- **One policy for pages and APIs.** APIs can deny everything.
- **A route list maintained by hand.** New pages are skipped silently.
- **A check never seen red.** Strip the nonce once.
- **Signed-out routes reported as "all routes".** Signed-in views are a separate, owner-run matrix.
- **Shipping the dependent feature with the policy.** Ship the policy, verify, then flip the gate.

## Evidence from origin project

Javi's Dog, Sprint 5f (2026-10-30), Next.js 16 app on Vercel; owner decision after the design review (ADR-0018 *Changes* D0 M7): "add the CSP this sprint, then 'Remember on this device'".

- Implementation `6c35838` (merge `ae27c91`): per-request policy in the request proxy (`apps/web/src/proxy.ts`), client-sent CSP replaced, matcher skipping `api/`, `_next/static/`, `_next/image/` and prefetch headers; `connection()` in the root layout; static baseline CSP for `/api/*` in `next.config.ts`.
- Check: `apps/web/scripts/csp-check.mjs` (question, matrix, budget, exit codes in its header; routes discovered from `src/app/**/page.tsx`); "12/12 PASS with the real policy; FAIL with the nonce stripped (red) and with prerendered pages"; sprint log: "red-first: without the nonce 1 of 12; with pages left static 8 of 12".
- Production: "the header is live on `ae27c91`, and a browser load of 6 public routes gave 0 CSP violations with the Next runtime started. Signed-in data views were not loaded (owner)" (`docs/sprints/SPRINT-05f.md` Log). The production script was a scratch script, not committed.
- API policy hardened after the security review (L2, `a3e8aa4`): `default-src 'none'; script-src 'none'; …`; `csp:check` 12/12 again.
- Gate: `REMEMBER_ON_DEVICE_ENABLED = false` (`apps/web/src/lib/privacy/remember-gate.ts`, `4a71bf2`): no checkbox offered, earlier rows deleted, logic tested with the gate forced on; readiness row "Remember on this device" BLOCKED (owner).
- NOT RUN: signed-in pages, browsers other than Chromium.
