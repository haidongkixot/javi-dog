#!/usr/bin/env node
// github-app-create.mjs — register the Javi's Dog GitHub App from a manifest (ADR-0019 decision 7,
// design review D0 H1 and L3). Runs on the OWNER's machine only: never in a cloud session, and
// never against production in tests (the tests point --github-api at a local stub).
//
// Usage:  node scripts/github-app-create.mjs [options]
//
//   --name <name>          App name shown on GitHub (1–34 characters, unique on GitHub).
//                          Default: "Javi's Dog (<6 random hex>)". You can still edit it on GitHub.
//   --base-url <url>       Deployment base URL (https). Default: https://javisdog.vercel.app
//   --port <n>             Local port on 127.0.0.1. Default: 0 (a free port).
//   --out-dir <dir>        Where the result file goes. Default: ~/.javis-dog
//                          Must be outside any git working tree.
//   --timeout <seconds>    Give up when no callback arrives. Default: 600 (10 minutes).
//   --github-api <url>     GitHub REST base URL. Default: https://api.github.com (tests only).
//   -h, --help             Show this help.
//
// Flow (GitHub docs, "Registering a GitHub App from a manifest"): a local page POSTs the manifest
// to https://github.com/settings/apps/new?state=<state>; GitHub redirects back to the local
// callback with a one-time `code`; the helper exchanges it with
// POST /app-manifests/{code}/conversions and writes the full result (it includes the webhook
// secret, the private key and the client secret) to a 0600 file. It prints only the app slug,
// app id, owner account id, the file path and the next steps. The code works once and expires
// after one hour.
//
// Exit:   0 app created and saved · 1 refused, failed or timed out (reason on stderr) · 2 bad usage
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_WEB = 'https://github.com';
const DEFAULTS = {
  baseUrl: 'https://javisdog.vercel.app',
  githubApi: 'https://api.github.com',
  port: 0,
  timeout: 600,
};
// ADR-0019 decision 1: PRs and CI only. No `contents`, so the app cannot read code.
// `installation` and `installation_repositories` events are always delivered to GitHub Apps.
const PERMISSIONS = { metadata: 'read', pull_requests: 'read', checks: 'read', actions: 'read' };
const EVENTS = ['pull_request', 'check_suite', 'workflow_run'];
const DESCRIPTION =
  "Pull request and CI signals for Javi's Dog. Read-only: metadata, pull requests, checks, Actions. No contents permission.";

const isWindows = process.platform === 'win32';

class UsageError extends Error {}

function help() {
  return `Usage: node scripts/github-app-create.mjs [--name <name>] [--base-url <url>] [--port <n>]
       [--out-dir <dir>] [--timeout <seconds>] [--github-api <url>]
Registers the Javi's Dog GitHub App from a manifest. See docs/how-to/set-up-github-app.md.`;
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, name: undefined, outDir: undefined };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--name':
        opts.name = take(i++, arg);
        break;
      case '--base-url':
        opts.baseUrl = take(i++, arg);
        break;
      case '--port':
        opts.port = Number(take(i++, arg));
        break;
      case '--out-dir':
        opts.outDir = take(i++, arg);
        break;
      case '--timeout':
        opts.timeout = Number(take(i++, arg));
        break;
      case '--github-api':
        opts.githubApi = take(i++, arg);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.help) return opts;

  opts.name = (opts.name ?? `Javi's Dog (${randomBytes(3).toString('hex')})`).trim();
  if (opts.name.length < 1 || opts.name.length > 34)
    throw new UsageError('--name must be 1–34 characters (GitHub limit)');
  opts.baseUrl = httpsOrigin(opts.baseUrl, '--base-url', { allowLoopbackHttp: false });
  opts.githubApi = httpsOrigin(opts.githubApi, '--github-api', { allowLoopbackHttp: true });
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
    throw new UsageError('--port must be an integer from 0 to 65535');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0)
    throw new UsageError('--timeout must be a positive number of seconds');
  return opts;
}

// An https origin (plus optional path for the API base) without query, hash or credentials.
// Plain http is accepted only for a loopback test stub.
function httpsOrigin(value, flag, { allowLoopbackHttp }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} is not a URL`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const okProtocol =
    url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:');
  if (!okProtocol || url.username || url.password || url.search || url.hash)
    throw new UsageError(`${flag} must be a plain https URL`);
  return url.href.replace(/\/+$/, '');
}

export function buildManifest({ name, baseUrl, redirectUrl }) {
  return {
    name,
    url: baseUrl,
    description: DESCRIPTION,
    hook_attributes: { url: `${baseUrl}/api/github/webhook`, active: true },
    redirect_url: redirectUrl,
    setup_url: `${baseUrl}/integrations/github`,
    public: false,
    request_oauth_on_install: false,
    default_permissions: { ...PERMISSIONS },
    default_events: [...EVENTS],
  };
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Refuse any directory inside a git working tree (this repository included), so the secrets
// can never be committed by accident. Symlinks are resolved through the nearest existing parent.
export function gitTreeContaining(dir) {
  let probe = resolve(dir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let current = join(realpathSync(probe), resolve(dir).slice(probe.length));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function prepareOutDir(outDir) {
  const dir = resolve(outDir ?? join(homedir(), '.javis-dog'));
  const tree = gitTreeContaining(dir);
  if (tree) throw new UsageError(`refusing to write secrets inside a git working tree (${tree})`);
  const ownRepo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (dir === ownRepo || dir.startsWith(ownRepo + sep))
    throw new UsageError('refusing to write secrets inside the Javi’s Dog repository');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!statSync(dir).isDirectory()) throw new UsageError(`${dir} is not a directory`);
  if (!isWindows && (statSync(dir).mode & 0o077) !== 0)
    process.stderr.write(
      `Warning: ${dir} is readable by other users. Consider: chmod 700 "${dir}"\n`,
    );
  return dir;
}

// Create the result file with mode 0600 from the start (no chmod afterwards) and never overwrite.
function writeResult(dir, slug, json) {
  const safeSlug =
    String(slug ?? 'app')
      .replace(/[^a-z0-9-]/gi, '-')
      .slice(0, 60) || 'app';
  for (let n = 1; n < 100; n++) {
    const file = join(dir, `github-app-${safeSlug}${n === 1 ? '' : `-${n}`}.json`);
    try {
      writeFileSync(file, json, { mode: 0o600, flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not find a free file name in ${dir}`);
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Resolves once the response has been handed to the socket, so closing the server cannot cut it.
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  const flushed = new Promise((r) => res.once('close', r));
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${GITHUB_WEB}; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(body);
  return flushed;
}

function page(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}code{font-size:.9em}</style>
</head><body>${inner}</body></html>
`;
}

function formPage({ manifest, state }) {
  const action = `${GITHUB_WEB}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return page(
    "Create the Javi's Dog GitHub App",
    `<h1>Create the GitHub App</h1>
<p>This sends the app settings below to GitHub. GitHub shows them before anything is created; you can still change the name there.</p>
<form action="${escapeHtml(action)}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<p>Permissions (read-only): ${Object.keys(manifest.default_permissions).map(escapeHtml).join(', ')}. Events: ${manifest.default_events.map(escapeHtml).join(', ')}. Private app: only your own account can install it.</p>
<pre><code>${escapeHtml(JSON.stringify(manifest, null, 2))}</code></pre>`,
  );
}

async function exchange(githubApi, code) {
  const res = await fetch(`${githubApi}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'javis-dog-github-app-create',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} to the code exchange`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('GitHub answered with something that is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('GitHub answered with an unexpected JSON shape');
  return { body, text };
}

function nextSteps({ slug, id, ownerId, file }) {
  const lines = [
    '',
    'GitHub App created.',
    `  App slug:          ${slug}`,
    `  App id:            ${id}`,
    `  Owner account id:  ${ownerId}`,
    `  Result file:       ${file}`,
    '',
    'The result file holds the webhook secret, private key and client secret. Nothing secret was printed.',
    '',
    'Next steps (docs/how-to/set-up-github-app.md):',
    '  1. Vercel -> javisdog -> Settings -> Environment Variables, Production:',
    '       GITHUB_APP_WEBHOOK_SECRET  = "webhook_secret" from the result file (mark it Sensitive)',
    `       GITHUB_APP_ID              = ${id}`,
    `       GITHUB_APP_SLUG            = ${slug}`,
    `       GITHUB_APP_OWNER_ID        = ${ownerId}`,
    '     Then redeploy production.',
    '  2. Keep "pem" and "client_secret" offline, or delete them: Javi’s Dog never needs them,',
    '     and GitHub can generate new ones.',
    `  3. Install the app on "Only select repositories": https://github.com/apps/${slug}/installations/new`,
    '  4. In Javi’s Dog: claim the installation on /integrations/github, then link a repository',
    '     on the project page.',
  ];
  if (isWindows)
    lines.push(
      '',
      'Windows: file modes do not apply. The file sits under your user profile; keep that folder private.',
    );
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  let outDir;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(help() + '\n');
      return 0;
    }
    outDir = prepareOutDir(opts.outDir);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`github-app-create: ${err.message}\n${help()}\n`);
      return 2;
    }
    throw err;
  }
  if (isWindows)
    process.stderr.write(
      'Warning: on Windows, file modes do not apply. The result file goes under your user profile.\n',
    );

  const state = randomBytes(32).toString('hex');
  let used = false;
  let finish;
  const done = new Promise((r) => (finish = r));

  const server = createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost) return send(res, 421, 'Wrong Host header.\n');
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed.\n');
    const url = new URL(req.url, `http://${expectedHost}`);

    if (url.pathname === '/') {
      if (used) return send(res, 410, 'This helper run is finished.\n');
      const manifest = buildManifest({
        name: opts.name,
        baseUrl: opts.baseUrl,
        redirectUrl: `http://${expectedHost}/callback`,
      });
      return send(res, 200, formPage({ manifest, state }), 'text/html; charset=utf-8');
    }

    if (url.pathname !== '/callback') return send(res, 404, 'Not found.\n');
    if (used) return send(res, 409, 'This one-time callback was already used.\n');
    const code = url.searchParams.get('code') ?? '';
    if (!sameSecret(url.searchParams.get('state') ?? '', state)) {
      process.stderr.write('Refused a callback with a missing or wrong state. Still waiting.\n');
      return send(res, 403, 'Refused: the state does not match. Nothing was exchanged.\n');
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) {
      process.stderr.write('Refused a callback without a well-formed code. Still waiting.\n');
      return send(res, 400, 'Refused: missing or malformed code. Nothing was exchanged.\n');
    }
    used = true;

    try {
      const { body, text } = await exchange(opts.githubApi, code);
      const file = writeResult(outDir, body.slug, text.endsWith('\n') ? text : text + '\n');
      const slug = typeof body.slug === 'string' ? body.slug : '(missing)';
      const id = Number.isInteger(body.id) ? body.id : '(missing)';
      const ownerId = Number.isInteger(body.owner?.id) ? body.owner.id : '(missing)';
      process.stdout.write(nextSteps({ slug, id, ownerId, file }));
      const complete = typeof body.webhook_secret === 'string' && slug !== '(missing)';
      if (!complete)
        process.stderr.write(
          'GitHub’s answer lacks a slug or webhook secret; the file holds what was returned.\n',
        );
      await send(
        res,
        200,
        page(
          'GitHub App created',
          `<h1>GitHub App created</h1><p>App <code>${escapeHtml(slug)}</code> is registered. Go back to your terminal for the next steps. You can close this tab.</p>`,
        ),
        'text/html; charset=utf-8',
      );
      finish(complete ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `github-app-create: ${err.message}. Nothing was written. The code works once and expires ` +
          'after one hour. If GitHub created the app anyway, delete it under GitHub -> Settings -> ' +
          'Developer settings -> GitHub Apps and run this helper again.\n',
      );
      await send(res, 502, 'The code exchange failed. See your terminal.\n');
      finish(1);
    }
  });

  await new Promise((r, j) => {
    server.once('error', j);
    server.listen(opts.port, '127.0.0.1', r);
  });
  const port = server.address().port;
  process.stdout.write(
    `Open http://127.0.0.1:${port}/ in your browser and follow the button to GitHub.\n` +
      `App name: ${opts.name} (editable on GitHub; it must be unique there).\n` +
      `Waiting up to ${Math.round(opts.timeout)} s for GitHub to send you back...\n`,
  );

  const timer = setTimeout(() => {
    process.stderr.write(
      `github-app-create: no callback within ${Math.round(opts.timeout)} s. Nothing was written. ` +
        'If you clicked "Create GitHub App", delete that app on GitHub and run this helper again.\n',
    );
    finish(1);
  }, opts.timeout * 1000);

  const code = await done;
  clearTimeout(timer);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  return code;
}

// Run only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`github-app-create: ${err?.message ?? 'unexpected error'}\n`);
      process.exit(1);
    },
  );
}
