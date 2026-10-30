/**
 * Content Security Policy for every page (ADR-0018 decision 11, review M7).
 *
 * `src/proxy.ts` makes a fresh nonce per request and sends this policy on both the request
 * (Next.js reads the nonce from the request's `Content-Security-Policy` header and puts it on its
 * own scripts) and the response (the browser enforces it). Pages must render dynamically, so the
 * root layout opts every page into request-time rendering.
 *
 * Sources, checked against the app on 2026-10-30:
 * - scripts: only Next.js's own, carrying the nonce; `'strict-dynamic'` lets them load chunks.
 *   No third-party scripts. `'self'` is ignored by CSP3 browsers next to `'strict-dynamic'` and
 *   kept as the ADR states it.
 * - styles: Next.js and Tailwind inline CSS, and React `style` props, need `'unsafe-inline'`.
 * - fonts: Inter is self-hosted by `@fontsource-variable/inter` (served from `/_next/static`).
 * - images: none from other origins (no avatars, no `next/image`).
 * - connect: same origin only (`/api/auth`, `/api/dashboard/snapshot`, server actions).
 * - forms: server actions post to this origin. Social sign-in is a `fetch` to `/api/auth`
 *   that answers JSON `{ url, redirect }`, then a `window.location` navigation to the provider;
 *   neither `form-action` nor `connect-src` governs that navigation.
 */

/** Random bytes per nonce: 16 bytes = 128 bits. */
export const NONCE_BYTES = 16;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A fresh, unpredictable nonce: 128 random bits from Web Crypto, base64-encoded. */
export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface CspOptions {
  /** `next dev` only: React uses `eval` for its debugging aids. Never set in production. */
  dev?: boolean;
}

/** The policy as ordered `[directive, sources]` pairs (exported for tests). */
export function cspDirectives(nonce: string, options: CspOptions = {}): Array<[string, string]> {
  if (!BASE64.test(nonce) || nonce.length < 22) {
    throw new Error('CSP nonce must be base64 and carry at least 128 bits');
  }
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  if (options.dev) scriptSrc.push(`'unsafe-eval'`);
  return [
    ['default-src', `'self'`],
    ['script-src', scriptSrc.join(' ')],
    ['style-src', `'self' 'unsafe-inline'`],
    ['img-src', `'self'`],
    ['font-src', `'self'`],
    ['connect-src', `'self'`],
    ['object-src', `'none'`],
    ['base-uri', `'none'`],
    ['frame-ancestors', `'none'`],
    ['form-action', `'self'`],
  ];
}

/** The `Content-Security-Policy` header value for one request. */
export function buildCsp(nonce: string, options: CspOptions = {}): string {
  return cspDirectives(nonce, options)
    .map(([name, sources]) => `${name} ${sources}`)
    .join('; ');
}
