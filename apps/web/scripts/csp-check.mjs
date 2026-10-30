#!/usr/bin/env node
// Bounded browser run for the Content Security Policy (ADR-0018 decision 11, TEST_PLAN §S5f).
//
// Question: does every app route load with zero CSP violations under the nonce policy?
// Matrix: every `src/app/**/page.tsx` route (dynamic segments filled with a sample value) plus a
// 404, a bare `/api` 404 and `/sign-in?error=…`; one Chromium; one visit per route; no database or
// auth env, so pages show their not-configured / signed-out states. Screenshots: none (budget 0).
// Output: one JSON line per route on stdout and a summary; nothing is written to disk.
//
// Needs `next build` first. Not part of `pnpm test`. Usage:
//   pnpm --filter @javis-dog/web build && pnpm --filter @javis-dog/web csp:check
//   … csp:check --policy=no-nonce   # red check: strips the nonce from each page's policy in the
//                                    # browser (request interception); the run must then FAIL.
// Exit codes: 0 PASS, 1 FAIL (a violation or a header assertion), 2 could not run.
//
// Playwright is not a workspace dependency: the script resolves an installed copy (`require`
// from here, then NODE_PATH and global folders), or `PLAYWRIGHT_MODULE=/path/to/playwright`.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(webDir, 'src', 'app');
const policyMode = (process.argv.find((a) => a.startsWith('--policy=')) ?? '--policy=real').slice(
  9,
);
if (!['real', 'no-nonce'].includes(policyMode)) {
  console.error(`Unknown --policy=${policyMode} (use real or no-nonce)`);
  process.exit(2);
}

const SAMPLE_PARAMS = { id: '00000000-0000-4000-8000-000000000000' };
const EXTRA_ROUTES = ['/sign-in?error=access_denied', '/csp-check-not-found', '/api'];
const API_ROUTES = ['/api/health'];
const API_CSP =
  "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const ROUTE_TIMEOUT_MS = 30_000;

const cannotRun = (message) => {
  console.error(`csp:check NOT RUN — ${message}`);
  process.exit(2);
};

const loadPlaywright = () => {
  const fromEnv = process.env.PLAYWRIGHT_MODULE;
  try {
    return createRequire(import.meta.url)(fromEnv ?? 'playwright');
  } catch {
    return cannotRun('Playwright not found; set PLAYWRIGHT_MODULE to an installed copy.');
  }
};

/** Page routes from the file system, so a new page cannot be skipped silently. */
const discoverRoutes = () => {
  const routes = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') {
        const segments = relative(appDir, dir)
          .split(sep)
          .filter((s) => s && !/^\(.*\)$/.test(s))
          .map((s) => {
            const param = /^\[(\w+)\]$/.exec(s)?.[1];
            if (!param) return s;
            if (!(param in SAMPLE_PARAMS)) cannotRun(`add a sample value for [${param}]`);
            return SAMPLE_PARAMS[param];
          });
        routes.push(`/${segments.join('/')}`);
      }
    }
  };
  walk(appDir);
  return routes.sort();
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const startServer = async (port) => {
  if (!existsSync(join(webDir, '.next', 'BUILD_ID'))) cannotRun('no build; run next build first');
  // Allow-list env: no DATABASE_URL, auth secrets or provider keys reach the server.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1' };
  const bin = join(webDir, 'node_modules', '.bin', 'next');
  const child = spawn(bin, ['start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) cannotRun(`next start exited ${child.exitCode}\n${log}`);
    try {
      await fetch(`${base}/api/health`);
      return { child, base, log: () => log };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  child.kill();
  return cannotRun(`next start did not answer within 30 s\n${log}`);
};

const cspHeaders = (headers) =>
  headers.filter((h) => h.name.toLowerCase() === 'content-security-policy').map((h) => h.value);
const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp ?? '')?.[1];

/** Header-level checks with plain HTTP: one policy, a nonce of ≥128 bits, fresh per request. */
const checkHeaders = async (base, route) => {
  const get = async () => {
    const res = await fetch(base + route, { redirect: 'manual' });
    return [...res.headers].filter(([k]) => k === 'content-security-policy').map(([, v]) => v);
  };
  const [a, b] = [await get(), await get()];
  const nonceA = nonceOf(a[0]);
  const bits = nonceA ? Buffer.from(nonceA, 'base64').length * 8 : 0;
  return { policies: a.length, nonceBits: bits, freshNonce: !!nonceA && nonceA !== nonceOf(b[0]) };
};

const visit = async (context, base, route) => {
  const page = await context.newPage();
  const consoleCsp = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  const documents = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'document' && r.frame() === page.mainFrame())
      documents.push(r);
  });
  let status = null;
  let error = null;
  try {
    const res = await page.goto(base + route, { waitUntil: 'load', timeout: ROUTE_TIMEOUT_MS });
    status = res?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  } catch (e) {
    error = String(e).slice(0, 200);
  }
  const final = documents.at(-1);
  const policies = final ? cspHeaders(await final.headersArray()) : [];
  const state = await page
    .evaluate(() => ({
      violations: (window.__cspViolations ?? []).slice(0, 5),
      count: (window.__cspViolations ?? []).length,
      nextRuntime: typeof window.next === 'object' && window.next !== null,
    }))
    .catch(() => ({ violations: [], count: -1, nextRuntime: false }));
  const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.close();
  return {
    route,
    status,
    landedOn: finalPath,
    policies: policies.length,
    nonce: !!nonceOf(policies[0]),
    strictDynamic: (policies[0] ?? '').includes("'strict-dynamic'"),
    nextRuntime: state.nextRuntime,
    violations: state.count,
    sample: state.violations,
    consoleCspErrors: consoleCsp.length,
    consoleSample: consoleCsp.slice(0, 2),
    pageErrors,
    error,
  };
};

const main = async () => {
  const { chromium } = loadPlaywright();
  const routes = [...discoverRoutes(), ...EXTRA_ROUTES];
  const port = await freePort();
  const server = await startServer(port);
  const browser = await chromium.launch();
  const failures = [];
  try {
    const context = await browser.newContext();
    // Runs before any page script (injected by the browser tooling, not subject to the CSP).
    await context.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective,
          blocked: String(e.blockedURI).slice(0, 80),
          sample: String(e.sample ?? '').slice(0, 40),
        });
      });
    });
    if (policyMode === 'no-nonce') {
      // Deliberately broken policy for the red check: same header without the nonce.
      await context.route('**/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        const res = await route.fetch({ maxRedirects: 0 });
        const headers = { ...res.headers() };
        if (headers['content-security-policy'])
          headers['content-security-policy'] = headers['content-security-policy'].replace(
            / 'nonce-[^']+'/,
            '',
          );
        return route.fulfill({ response: res, headers });
      });
    }
    // Social sign-in leaves the app by `window.location` navigation (Better Auth's redirect
    // plugin). Stub the provider so nothing leaves this machine.
    await context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>provider stub</p>' }),
    );

    for (const route of routes) {
      const result = await visit(context, server.base, route);
      const headers = await checkHeaders(server.base, route);
      Object.assign(result, { freshNonce: headers.freshNonce, nonceBits: headers.nonceBits });
      const problems = [];
      if (result.error) problems.push('navigation error');
      if (result.violations !== 0) problems.push(`${result.violations} violation(s)`);
      if (result.consoleCspErrors !== 0) problems.push('CSP console errors');
      if (result.policies !== 1 || headers.policies !== 1) problems.push('not exactly one policy');
      if (!result.nonce || !result.strictDynamic) problems.push('nonce/strict-dynamic missing');
      if (headers.nonceBits < 128 || !headers.freshNonce) problems.push('nonce not fresh/128-bit');
      if (!result.nextRuntime) problems.push('Next.js runtime did not start');
      result.result = problems.length ? `FAIL: ${problems.join(', ')}` : 'PASS';
      if (problems.length) failures.push(route);
      console.log(JSON.stringify(result));
    }

    // OAuth hand-off: Better Auth answers `{ url, redirect: true }` and sets window.location.
    // A top-level navigation is not governed by form-action or connect-src; prove it here.
    {
      const page = await context.newPage();
      await page.goto(`${server.base}/sign-in`, { waitUntil: 'load' });
      const before = await page.evaluate(() => window.__cspViolations.length);
      await Promise.all([
        page.waitForURL('https://github.com/**', { timeout: 10_000 }),
        page.evaluate(() => {
          window.location.href = 'https://github.com/login/oauth/authorize?client_id=stub';
        }),
      ]).catch(() => {});
      const landed = page.url();
      await page.close();
      const ok = landed.startsWith('https://github.com/login/oauth/authorize') && before === 0;
      if (!ok) failures.push('oauth-navigation');
      console.log(
        JSON.stringify({
          route: 'oauth-navigation (/sign-in → github.com stub)',
          landedOn: landed,
          violationsBefore: before,
          result: ok ? 'PASS' : 'FAIL',
        }),
      );
    }

    // API routes keep the static baseline policy from next.config.ts (one header, no nonce).
    for (const route of API_ROUTES) {
      const res = await fetch(server.base + route);
      const policies = [...res.headers].filter(([k]) => k === 'content-security-policy');
      const ok = policies.length === 1 && policies[0][1] === API_CSP;
      if (!ok) failures.push(route);
      console.log(
        JSON.stringify({
          route,
          status: res.status,
          policies: policies.length,
          ok,
          result: ok ? 'PASS' : 'FAIL',
        }),
      );
    }
  } finally {
    await browser.close();
    server.child.kill();
  }
  const total = routes.length + 1 + API_ROUTES.length;
  console.log(
    `csp:check policy=${policyMode}: ${total - failures.length}/${total} PASS` +
      (failures.length ? `; FAIL: ${failures.join(', ')}` : ''),
  );
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
