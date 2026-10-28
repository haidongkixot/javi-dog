import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

// S5a review L4: baseline security headers on every route. Config-level check (lowest layer);
// `next build` proves the config loads.

const allRoutes = async () => {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === '/:path*');
  return new Map((rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
};

describe('security headers (next.config headers())', () => {
  it('applies one rule to every route', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(['/:path*']);
  });

  it('sets nosniff, a strict referrer policy and refuses framing', async () => {
    const h = await allRoutes();
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(h.get('x-frame-options')).toBe('DENY');
  });

  it('has a CSP limited to directives that cannot break Next inline scripts', async () => {
    const csp = (await allRoutes()).get('content-security-policy') ?? '';
    const directives = Object.fromEntries(
      csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/);
          return [name!, values.join(' ')];
        }),
    );
    expect(directives).toEqual({
      'frame-ancestors': "'none'",
      'base-uri': "'self'",
      'form-action': "'self'",
      'object-src': "'none'",
    });
  });

  it('turns off powerful browser features the app never uses, but keeps clipboard copy', async () => {
    const policy = (await allRoutes()).get('permissions-policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(policy).toContain(`${feature}=()`);
    }
    expect(policy).not.toContain('clipboard-write');
  });

  it('keeps the X-Powered-By header off', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
