import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, createNonce } from '@/lib/csp';

/**
 * Nonce-based Content Security Policy for every page (ADR-0018 decision 11). A fresh nonce per
 * request goes on the request header (Next.js reads it there and stamps its scripts) and on the
 * response header (the browser enforces it). Any `Content-Security-Policy` request header the
 * client sent is replaced, so a caller cannot choose the nonce.
 */
export function proxy(request: NextRequest) {
  const csp = buildCsp(createNonce(), { dev: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. `/api/*` answers JSON and keeps the baseline policy from next.config.ts (so
      // the ingest path pays no proxy call); `_next/static` and `_next/image` are not documents.
      // Router prefetches carry RSC payloads, not documents, and skip the proxy as the Next.js
      // CSP guide recommends.
      source: '/((?!api/|_next/static/|_next/image/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
