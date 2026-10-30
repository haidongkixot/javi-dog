import type { NextConfig } from 'next';

/**
 * Baseline security headers for every route (S5a review L4). `clipboard-write` stays allowed
 * (Copy token).
 *
 * Content Security Policy: pages get a nonce-based policy per request from `src/proxy.ts`
 * (ADR-0018 decision 11; built in `src/lib/csp.ts`). The proxy skips `/api/*`, so API routes keep
 * the static baseline below: no framing, no `<base>` rewrites, forms post to this origin only and
 * no plugins. The two never apply to the same response, so no response carries two policies.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
];

/** Static CSP for API responses (JSON); pages get theirs from the proxy. */
const apiContentSecurityPolicy =
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const nextConfig: NextConfig = {
  // Workspace modules ship TypeScript source (ADR-0001).
  transpilePackages: [
    '@javis-dog/ui',
    '@javis-dog/analytics',
    '@javis-dog/event-store',
    '@javis-dog/identity',
    '@javis-dog/ingest',
    '@javis-dog/jgr-spec',
    '@javis-dog/notify',
    '@javis-dog/projects',
    '@javis-dog/realtime',
    '@javis-dog/resilience',
  ],
  poweredByHeader: false,
  headers: async () => [
    { source: '/:path*', headers: securityHeaders },
    // `:path+` (not `*`): a bare `/api` is a 404 page and goes through the proxy instead.
    {
      source: '/api/:path+',
      headers: [{ key: 'Content-Security-Policy', value: apiContentSecurityPolicy }],
    },
  ],
};

export default nextConfig;
