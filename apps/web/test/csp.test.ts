import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { buildCsp, createNonce, cspDirectives, NONCE_BYTES } from '@/lib/csp';
import { config, proxy } from '@/proxy';

// ADR-0018 decision 11 (review M7): nonce-based CSP on every page. Unit layer: exact directives,
// nonce shape and freshness, and what the proxy puts on the request and the response. The browser
// run (`pnpm --filter @javis-dog/web csp:check`) proves the pages load with zero violations.

const NONCE = 'AAECAwQFBgcICQoLDA0ODw==';

const parse = (csp: string) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name!, values.join(' ')];
      }),
  );

describe('buildCsp', () => {
  it('states exactly the ADR-0018 §11 directives plus the sources the app needs', () => {
    expect(parse(buildCsp(NONCE))).toEqual({
      'default-src': "'self'",
      'script-src': `'self' 'nonce-${NONCE}' 'strict-dynamic'`,
      'style-src': "'self' 'unsafe-inline'",
      'img-src': "'self'",
      'font-src': "'self'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'frame-ancestors': "'none'",
      'form-action': "'self'",
    });
  });

  it('is one line with directives separated by "; "', () => {
    const csp = buildCsp(NONCE);
    expect(csp).not.toMatch(/[\r\n]/);
    expect(csp.split('; ')).toHaveLength(cspDirectives(NONCE).length);
  });

  it("allows 'unsafe-eval' only in dev, and never 'unsafe-inline' for scripts", () => {
    expect(buildCsp(NONCE)).not.toContain('unsafe-eval');
    expect(parse(buildCsp(NONCE, { dev: true }))['script-src']).toBe(
      `'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`,
    );
    for (const dev of [false, true]) {
      expect(parse(buildCsp(NONCE, { dev }))['script-src']).not.toContain('unsafe-inline');
    }
  });

  it('refuses a nonce that is not base64 or is shorter than 128 bits', () => {
    expect(() => buildCsp("abc'; script-src *")).toThrow(/base64/);
    expect(() => buildCsp('QUJD')).toThrow(/128 bits/);
    expect(() => buildCsp('')).toThrow();
  });
});

describe('createNonce', () => {
  it('is base64 of 16 random bytes (128 bits)', () => {
    const nonce = createNonce();
    expect(NONCE_BYTES).toBeGreaterThanOrEqual(16);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(NONCE_BYTES);
    expect(Buffer.from(nonce, 'base64').toString('base64')).toBe(nonce);
  });

  it('is fresh on every call', () => {
    const nonces = new Set(Array.from({ length: 1000 }, createNonce));
    expect(nonces.size).toBe(1000);
  });
});

describe('proxy', () => {
  const run = (headers: Record<string, string> = {}) =>
    proxy(new NextRequest('http://localhost:3000/projects', { headers }));
  const nonceOf = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? '')?.[1];

  it('sends the policy on the response and the same policy on the request for Next.js', () => {
    const res = run();
    const csp = res.headers.get('content-security-policy');
    expect(nonceOf(csp)).toBeTruthy();
    expect(csp).toBe(buildCsp(nonceOf(csp)!));
    // NextResponse.next({ request: { headers } }) forwards request headers this way.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(res.headers.get('x-middleware-override-headers')).toContain('content-security-policy');
  });

  it('uses a fresh nonce per request', () => {
    const a = nonceOf(run().headers.get('content-security-policy'));
    const b = nonceOf(run().headers.get('content-security-policy'));
    expect(a).not.toBe(b);
  });

  it('replaces a client-supplied CSP request header, so a caller cannot pick the nonce', () => {
    const res = run({ 'content-security-policy': `script-src 'nonce-${NONCE}'` });
    const forwarded = res.headers.get('x-middleware-request-content-security-policy');
    expect(forwarded).not.toContain(NONCE);
    expect(forwarded).toBe(res.headers.get('content-security-policy'));
  });

  it('covers pages and skips API routes, static chunks and image optimization', () => {
    const [rule] = config.matcher;
    const re = new RegExp(`^${rule!.source}$`);
    for (const page of ['/', '/projects', '/projects/abc', '/sign-in', '/icon.svg', '/api', '/x'])
      expect(re.test(page), page).toBe(true);
    for (const skipped of ['/api/health', '/api/v1/events', '/_next/static/chunks/a.js'])
      expect(re.test(skipped), skipped).toBe(false);
  });
});
