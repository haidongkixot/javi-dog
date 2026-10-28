import type { NextConfig } from 'next';

/**
 * Baseline security headers for every route (S5a review L4). The CSP holds only directives that
 * cannot break Next's inline scripts: no framing, no `<base>` rewrites, forms post to this
 * origin only (all forms are server actions; social sign-in is a fetch followed by a
 * `window.location` redirect, which `form-action` does not govern) and no plugins. A full
 * script CSP needs nonces and is not set. `clipboard-write` stays allowed (Copy token).
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
];

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
  headers: async () => [{ source: '/:path*', headers: securityHeaders }],
};

export default nextConfig;
