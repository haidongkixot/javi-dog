// Process test for scripts/github-app-create.mjs (ADR-0019 decision 7, D0 L3; TEST_PLAN §S5g
// "Local helper"). The helper runs as a child process against a stub GitHub API on 127.0.0.1;
// nothing here talks to github.com or to production. Every secret below is fake and says so.
//
// Run: node --test scripts/test/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitTreeContaining } from '../github-app-create.mjs';

const HELPER = fileURLToPath(new URL('../github-app-create.mjs', import.meta.url));
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const FAKE = {
  code: 'NOT-REAL-code-4f1d2c',
  webhookSecret: 'NOT-REAL-webhook-secret-9b7e',
  pem: '-----BEGIN NOT-REAL TEST KEY-----\nNOT-REAL-pem-body-3c2a\n-----END NOT-REAL TEST KEY-----\n',
  pemMarker: 'NOT-REAL-pem-body-3c2a',
  clientSecret: 'NOT-REAL-client-secret-71aa',
  clientId: 'NOT-REAL-client-id-5d0e',
};
const RESULT = {
  id: 424242,
  slug: 'javis-dog-test-notreal',
  node_id: 'NOT-REAL-node',
  owner: { login: 'not-real-owner', id: 9_000_001, type: 'User' },
  name: "Javi's Dog (test)",
  client_id: FAKE.clientId,
  client_secret: FAKE.clientSecret,
  webhook_secret: FAKE.webhookSecret,
  pem: FAKE.pem,
  permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', actions: 'read' },
  events: ['pull_request', 'check_suite', 'workflow_run'],
};
const SECRETS = [FAKE.code, FAKE.webhookSecret, FAKE.pemMarker, FAKE.clientSecret, FAKE.clientId];

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'jd-gh-helper-'));
  temps.push(dir);
  return dir;
}

// A stub of POST /app-manifests/{code}/conversions. `hold` keeps the answer back until released.
async function startStub({ status = 201, body = RESULT, hold = false } = {}) {
  const calls = [];
  let release;
  const released = new Promise((r) => (release = r));
  let seen;
  const firstCall = new Promise((r) => (seen = r));
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, accept: req.headers.accept });
    seen();
    if (hold) await released;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status < 300 ? body : { message: 'Not Found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    firstCall,
    release: () => release(),
    close: () => new Promise((r) => server.close(r)),
  };
}

function startHelper(args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_PROXY: '127.0.0.1' };
  delete env.NODE_USE_ENV_PROXY;
  const child = spawn(process.execPath, [HELPER, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const port = new Promise((resolvePort, reject) => {
    const onData = () => {
      const m = out.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        child.stdout.off('data', onData);
        resolvePort(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    exited.then((code) => reject(new Error(`helper exited ${code}: ${out.stderr}`)));
  });
  port.catch(() => {}); // tests that expect an early exit never await the port
  return { child, out, exited, port };
}

function unescapeHtml(s) {
  return s.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e],
  );
}

// Reads the form the helper serves: the POST target and the manifest JSON it would submit.
async function readForm(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  const form = html.match(/<form action="([^"]+)" method="post">/);
  const input = html.match(/<input type="hidden" name="manifest" value="([^"]*)">/);
  assert.ok(form && input, 'form with a hidden manifest input');
  const action = new URL(unescapeHtml(form[1]));
  return {
    action,
    state: action.searchParams.get('state'),
    manifest: JSON.parse(unescapeHtml(input[1])),
    html,
  };
}

function callback(port, params) {
  return fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(params)}`);
}

function assertNoSecrets(out) {
  for (const secret of SECRETS) {
    assert.ok(!out.stdout.includes(secret), `stdout must not contain ${secret}`);
    assert.ok(!out.stderr.includes(secret), `stderr must not contain ${secret}`);
  }
}

describe('github-app-create helper', () => {
  test('full flow: exact manifest, state checks, 0600 result file outside the repo, no secrets printed', async (t) => {
    const stub = await startStub({ hold: true });
    t.after(stub.close);
    const home = tempHome();
    const helper = startHelper(
      ['--name', "Javi's Dog (test)", '--github-api', stub.url, '--timeout', '60'],
      home,
    );
    t.after(() => helper.child.kill());
    const port = await helper.port;

    const { action, state, manifest } = await readForm(port);
    assert.equal(`${action.origin}${action.pathname}`, 'https://github.com/settings/apps/new');
    assert.match(state, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest, {
      name: "Javi's Dog (test)",
      url: 'https://javisdog.vercel.app',
      description:
        "Pull request and CI signals for Javi's Dog. Read-only: metadata, pull requests, checks, Actions. No contents permission.",
      hook_attributes: { url: 'https://javisdog.vercel.app/api/github/webhook', active: true },
      redirect_url: `http://127.0.0.1:${port}/callback`,
      setup_url: 'https://javisdog.vercel.app/integrations/github',
      public: false,
      request_oauth_on_install: false,
      default_permissions: {
        metadata: 'read',
        pull_requests: 'read',
        checks: 'read',
        actions: 'read',
      },
      default_events: ['pull_request', 'check_suite', 'workflow_run'],
    });
    assert.ok(!('contents' in manifest.default_permissions), 'no contents permission');

    // Wrong state: refused, nothing exchanged, nothing written, helper keeps waiting.
    const wrong = await callback(port, { code: FAKE.code, state: 'f'.repeat(64) });
    assert.equal(wrong.status, 403);
    const missing = await callback(port, { code: FAKE.code });
    assert.equal(missing.status, 403);
    assert.equal(stub.calls.length, 0);
    assert.ok(
      !existsSync(join(home, '.javis-dog')) || readdirSync(join(home, '.javis-dog')).length === 0,
    );

    // Correct state: the exchange starts; a second callback with the same state is refused.
    const first = callback(port, { code: FAKE.code, state });
    await stub.firstCall;
    const second = await callback(port, { code: FAKE.code, state });
    assert.equal(second.status, 409);
    stub.release();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    assert.ok(!(await firstRes.text()).includes('NOT-REAL'));

    assert.equal(await helper.exited, 0);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, 'POST');
    assert.equal(stub.calls[0].url, `/app-manifests/${FAKE.code}/conversions`);
    assert.equal(stub.calls[0].accept, 'application/vnd.github+json');

    // The helper is gone: a replayed callback cannot reach anything.
    await assert.rejects(callback(port, { code: FAKE.code, state }));

    const file = join(home, '.javis-dog', `github-app-${RESULT.slug}.json`);
    assert.ok(existsSync(file), 'result file written under the home directory');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), RESULT);
    assert.ok(relative(REPO, file).startsWith('..'), 'result file is outside the repository');
    assert.equal(gitTreeContaining(file), undefined, 'result file is outside any git tree');
    if (process.platform === 'win32') {
      t.diagnostic(
        'mode 0600 not asserted on win32: file modes do not apply (owner check, TEST_PLAN D0)',
      );
    } else {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(home, '.javis-dog')).mode & 0o777, 0o700);
    }

    assert.match(helper.out.stdout, new RegExp(`App slug: +${RESULT.slug}`));
    assert.match(helper.out.stdout, new RegExp(`App id: +${RESULT.id}`));
    assert.match(helper.out.stdout, new RegExp(`Owner account id: +${RESULT.owner.id}`));
    assert.ok(helper.out.stdout.includes(file));
    for (const name of [
      'GITHUB_APP_WEBHOOK_SECRET',
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_OWNER_ID',
    ])
      assert.ok(helper.out.stdout.includes(name), `next steps name ${name}`);
    assert.match(helper.out.stdout, /Only select repositories/);
    assertNoSecrets(helper.out);
  });

  test('a wrong Host header is refused', async (t) => {
    const helper = startHelper(
      ['--github-api', 'http://127.0.0.1:9', '--timeout', '30'],
      tempHome(),
    );
    t.after(() => helper.child.kill());
    const port = await helper.port;
    for (const host of [
      'evil.example',
      `localhost.evil.example:${port}`,
      `127.0.0.1:${port + 1}`,
    ]) {
      const status = await new Promise((r, j) =>
        get({ host: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
          res.resume();
          r(res.statusCode);
        }).on('error', j),
      );
      assert.equal(status, 421, `Host ${host}`);
    }
    helper.child.kill();
  });

  test('a failed code exchange writes nothing, prints no code and exits 1', async (t) => {
    const stub = await startStub({ status: 404 });
    t.after(stub.close);
    const home = tempHome();
    const helper = startHelper(['--github-api', stub.url, '--timeout', '30'], home);
    t.after(() => helper.child.kill());
    const port = await helper.port;
    const { state } = await readForm(port);
    const res = await callback(port, { code: FAKE.code, state });
    assert.equal(res.status, 502);
    assert.equal(await helper.exited, 1);
    assert.equal(stub.calls.length, 1);
    assert.match(helper.out.stderr, /HTTP 404/);
    assert.equal(readdirSync(join(home, '.javis-dog')).length, 0);
    assertNoSecrets(helper.out);
  });

  test('an output directory inside a git working tree is refused before anything starts', async () => {
    const helper = startHelper(['--out-dir', join(REPO, 'tmp-secrets')], tempHome());
    assert.equal(await helper.exited, 2);
    assert.match(helper.out.stderr, /inside a git working tree/);
    assert.ok(!existsSync(join(REPO, 'tmp-secrets')));
  });

  test('no callback before the timeout: exits 1 and writes nothing', async () => {
    const home = tempHome();
    const helper = startHelper(['--github-api', 'http://127.0.0.1:9', '--timeout', '0.5'], home);
    assert.equal(await helper.exited, 1);
    assert.match(helper.out.stderr, /no callback within/);
    assert.equal(readdirSync(join(home, '.javis-dog')).length, 0);
  });
});
