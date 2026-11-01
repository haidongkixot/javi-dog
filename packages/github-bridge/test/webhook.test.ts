import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createGithubWebhookHandler,
  deliveryEventId,
  readRawBody,
  sha256Hex,
  verifyGithubSignature,
  WEBHOOK_MAX_BODY_BYTES,
  type DeliveryHashKind,
  type GithubEventRow,
  type GithubWebhookDeps,
  type GithubWebhookLogEntry,
  type GithubWebhookStore,
  type InstallationChange,
  type RouteTarget,
} from '../src/index.ts';
import {
  checkSuitePayload,
  INSTALLATION_ID,
  installationPayload,
  installationRepositoriesPayload,
  pingPayload,
  pullRequestPayload,
  REPO,
  SENTINEL,
  workflowRunPayload,
} from './fixtures.ts';
// Not re-exported from the package index yet (a shared edit); tested here at its source.
import { githubWebhookSecretsState } from '../src/webhook.ts';

// TEST_PLAN §S5g rows "Signature", "Route", "Never stored" (logs), the D0 replay row, "D0:
// per-event 3-day timestamps" and "D0: timingSafeEqual only on equal-length buffers", plus the
// adopted gaps G13, G14, G18, G19, G21, G22 — at the handler layer. JD-M10 cannot depend on
// JD-M06 (it composes these tables), so the store here is an in-memory stand-in with the
// repository's contract; the same handler runs on PGlite with every migration in
// apps/web/test/github-webhook-route.test.ts.

// Obviously fake secrets: never real webhook secrets.
const CURRENT = 'test-webhook-secret-current-NOT-REAL';
const PREVIOUS = 'test-webhook-secret-previous-NOT-REAL';
const OTHER = 'test-webhook-secret-other-NOT-REAL';

const NOW = new Date('2026-11-01T12:00:00Z');
const GUID = '0D0C0FFE-0019-41F1-8000-000000000001';
const TARGET: RouteTarget = {
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  projectId: '00000000-0000-4000-8000-00000000000b',
  projectSlug: 'web-app',
};

const enc = new TextEncoder();
const sign = (body: Uint8Array, secret = CURRENT) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const bytesOf = (payload: unknown) => enc.encode(JSON.stringify(payload));

/** In-memory stand-in for `createGithubRepository(db)`, recording every call in order. */
const fakeWorld = () => {
  const calls: string[] = [];
  const deliveries = new Map<string, DeliveryHashKind>();
  const changes: InstallationChange[] = [];
  const refreshed: Array<[number, { repoId: number; fullName: string }]> = [];
  const rows: GithubEventRow[] = [];
  const state = { route: TARGET as RouteTarget | null, failing: new Set<string>() };
  const touch = (name: string) => {
    calls.push(name);
    // A driver error that echoes a connection string: it must never reach a log or a response.
    if (state.failing.has(name) || state.failing.has('*')) {
      throw new Error(`connect failed postgresql://user:${SENTINEL}@db.example/neondb`);
    }
  };
  const store: GithubWebhookStore = {
    async hasDelivery(sha) {
      touch('hasDelivery');
      return deliveries.has(sha);
    },
    async recordDelivery(sha, kind) {
      touch(`recordDelivery:${kind}`);
      if (deliveries.has(sha)) return false;
      deliveries.set(sha, kind);
      return true;
    },
    async applyInstallationDelivery(change, sha) {
      touch('applyInstallationDelivery');
      if (deliveries.has(sha)) return 'duplicate';
      changes.push(change);
      deliveries.set(sha, 'installation');
      return 'applied';
    },
    async refreshRepositoryName(installationId, repo) {
      touch('refreshRepositoryName');
      refreshed.push([installationId, repo]);
    },
    async routeTarget(installationId, repoId) {
      touch('routeTarget');
      return installationId === INSTALLATION_ID && repoId === REPO.id ? state.route : null;
    },
    async touchVerifiedDelivery() {
      touch('touchVerifiedDelivery');
    },
  };
  const logs: GithubWebhookLogEntry[] = [];
  const readBody = vi.fn(readRawBody);
  const touchSignal = vi.fn(async () => touch('touchSignal'));
  const deps: GithubWebhookDeps = {
    secrets: { current: CURRENT },
    store,
    insertEvents: async (batch) => {
      touch('insertEvents');
      // Same dedupe key as JD-M06: (project, producer, event_id).
      const fresh = batch.filter(
        (r) =>
          !rows.some(
            (x) =>
              x.projectId === r.projectId &&
              x.producerId === r.producerId &&
              x.eventId === r.eventId,
          ),
      );
      rows.push(...fresh);
      return fresh.length;
    },
    touchSignal,
    readBody,
    now: () => NOW,
    log: (entry) => logs.push(entry),
  };
  return { calls, deliveries, changes, refreshed, rows, state, logs, readBody, touchSignal, deps };
};

type World = ReturnType<typeof fakeWorld>;

interface Send {
  body?: Uint8Array;
  payload?: unknown;
  event?: string | null;
  signature?: string | null;
  headers?: Record<string, string>;
  secret?: string;
}

const send = async (world: World, opts: Send, over: Partial<GithubWebhookDeps> = {}) => {
  const body = opts.body ?? bytesOf(opts.payload ?? workflowRunPayload('completed'));
  const headers = new Headers(opts.headers);
  const signature = opts.signature === undefined ? sign(body, opts.secret) : opts.signature;
  if (signature !== null) headers.set('x-hub-signature-256', signature);
  const event = opts.event === undefined ? 'workflow_run' : opts.event;
  if (event !== null) headers.set('x-github-event', event);
  if (!headers.has('x-github-delivery')) headers.set('x-github-delivery', GUID);
  const handler = createGithubWebhookHandler({ ...world.deps, ...over });
  const res = await handler(
    new Request('https://javisdog.test/api/github/webhook', { method: 'POST', headers, body }),
  );
  const text = await res.text();
  return { res, status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
};

describe('configuration (ADR-0019 §3.1, G13)', () => {
  it('answers 503 not_configured without a current secret, before anything else', async () => {
    for (const secrets of [{}, { current: '' }, { current: null, previous: PREVIOUS }]) {
      const w = fakeWorld();
      const r = await send(
        w,
        { signature: sign(enc.encode('{}'), PREVIOUS), headers: { 'content-encoding': 'gzip' } },
        { secrets },
      );
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'not_configured' });
      expect(r.res.headers.get('cache-control')).toBe('no-store');
      expect(w.readBody).not.toHaveBeenCalled();
      expect(w.calls).toEqual([]);
    }
  });

  // L-1: the handler, the UI config (JD-APP `githubAppConfig`) and health agree on one rule.
  it('treats a whitespace-only current secret as absent: 503 not_configured', async () => {
    for (const blank of [' ', '\n', ' \t ']) {
      const w = fakeWorld();
      const r = await send(w, { secret: blank }, { secrets: { current: blank } });
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'not_configured' });
      expect(w.logs).toEqual([expect.objectContaining({ status: 503, outcome: 'not_configured' })]);
      expect(w.calls).toEqual([]);
    }
  });

  it('refuses a secret with leading or trailing whitespace: 503, logged as misconfigured_secret without the value', async () => {
    for (const secrets of [
      { current: 'abc\n' },
      { current: ' abc' },
      { current: CURRENT, previous: `${PREVIOUS} ` },
    ]) {
      const w = fakeWorld();
      const r = await send(w, { secret: secrets.current }, { secrets });
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'not_configured' });
      expect(w.logs).toEqual([
        {
          level: 'warn',
          module: 'JD-M10',
          msg: 'github webhook',
          status: 503,
          outcome: 'misconfigured_secret',
        },
      ]);
      expect(JSON.stringify(w.logs)).not.toContain('abc');
      expect(w.readBody).not.toHaveBeenCalled();
      expect(w.calls).toEqual([]);
    }
  });

  it('ignores a whitespace-only previous secret: a body signed with it is a 401', async () => {
    const w = fakeWorld();
    const r = await send(w, { secret: ' ' }, { secrets: { current: CURRENT, previous: ' ' } });
    expect(r.status).toBe(401);
    expect((await send(w, {}, { secrets: { current: CURRENT, previous: ' ' } })).status).toBe(200);
  });

  it('githubWebhookSecretsState names the same three states', () => {
    expect(githubWebhookSecretsState({ current: CURRENT })).toBe('configured');
    expect(githubWebhookSecretsState({ current: CURRENT, previous: '  ' })).toBe('configured');
    expect(githubWebhookSecretsState({ current: '  ', previous: PREVIOUS })).toBe('not_configured');
    expect(githubWebhookSecretsState({})).toBe('not_configured');
    expect(githubWebhookSecretsState({ current: 'abc\n' })).toBe('misconfigured_secret');
    expect(githubWebhookSecretsState({ current: CURRENT, previous: '\told' })).toBe(
      'misconfigured_secret',
    );
  });
});

describe('request checks before the body is read (D0 L1, G11, G19)', () => {
  it('refuses any Content-Encoding but identity with 415, before reading or the header check', async () => {
    for (const encoding of ['gzip', 'br', 'deflate', 'GZIP', 'identity, gzip', '']) {
      const w = fakeWorld();
      const r = await send(w, { signature: 'sha1=bad', headers: { 'content-encoding': encoding } });
      expect(r.status, encoding).toBe(415);
      expect(r.json).toEqual({ error: 'unsupported_media_type' });
      expect(w.readBody).not.toHaveBeenCalled();
      expect(w.calls).toEqual([]);
    }
  });

  it('accepts identity in any case', async () => {
    for (const encoding of ['identity', 'IDENTITY', ' Identity ']) {
      const w = fakeWorld();
      const r = await send(w, { headers: { 'content-encoding': encoding } });
      expect(r.status, encoding).toBe(200);
    }
  });

  it('refuses a missing or malformed signature header with one 401, before reading', async () => {
    const body = bytesOf(workflowRunPayload('completed'));
    const hex = createHmac('sha256', CURRENT).update(body).digest('hex');
    const headers: Array<string | null> = [
      null,
      '',
      `sha1=${hex.slice(0, 40)}`,
      `SHA256=${hex}`,
      `sha256=${hex.toUpperCase()}`,
      hex,
      `sha256=${hex.slice(0, 63)}`,
      `sha256=${hex}0`,
      `sha256=${Buffer.from(hex, 'hex').toString('base64')}`,
      `sha256=${hex}, sha256=${hex}`,
      `sha256= ${hex}`,
      'sha256=',
    ];
    const bodies = new Set<string>();
    for (const signature of headers) {
      const w = fakeWorld();
      const r = await send(w, { body, signature });
      expect(r.status, String(signature)).toBe(401);
      bodies.add(r.text);
      expect(w.readBody).not.toHaveBeenCalled();
      expect(w.calls).toEqual([]);
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: 'unauthorized' })]);
  });
});

describe('body size (§3.2)', () => {
  const padded = (size: number) => {
    const json = JSON.stringify(workflowRunPayload('completed'));
    return enc.encode(json + ' '.repeat(size - json.length));
  };

  it('answers 413 above 1 MiB even with a well-formed wrong signature', async () => {
    const w = fakeWorld();
    const body = padded(WEBHOOK_MAX_BODY_BYTES + 1);
    const r = await send(w, { body, signature: sign(body, OTHER) });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: 'too_large' });
    expect(w.calls).toEqual([]);
  });

  it('answers 401, not 413, for a malformed header on an oversized body', async () => {
    const w = fakeWorld();
    const r = await send(w, { body: padded(WEBHOOK_MAX_BODY_BYTES + 1), signature: 'sha256=x' });
    expect(r.status).toBe(401);
  });

  it('stores a signed body of exactly 1 MiB', async () => {
    const w = fakeWorld();
    const r = await send(w, { body: padded(WEBHOOK_MAX_BODY_BYTES) });
    expect(r.status).toBe(200);
    expect(w.rows).toHaveLength(1);
  });

  it('refuses a declared Content-Length above the limit without reading', async () => {
    const big = new Request('https://javisdog.test/x', {
      method: 'POST',
      headers: { 'content-length': String(WEBHOOK_MAX_BODY_BYTES + 1) },
      body: 'x',
    });
    expect(await readRawBody(big, WEBHOOK_MAX_BODY_BYTES)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reads the exact raw bytes, BOM and invalid UTF-8 included', async () => {
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x7d]);
    const result = await readRawBody(
      new Request('https://javisdog.test/x', { method: 'POST', body: raw }),
      WEBHOOK_MAX_BODY_BYTES,
    );
    expect(result).toEqual({ ok: true, bytes: raw });
  });
});

describe('signature (§3.3, D0 L1)', () => {
  it('rejects a well-formed wrong signature with the same 401 and parses nothing', async () => {
    // Not JSON at all: a 400 or 202 here would mean the body was parsed before verification.
    const body = enc.encode(`not json ${SENTINEL}`);
    const w = fakeWorld();
    const wrong = await send(w, { body, signature: sign(body, OTHER) });
    const malformed = await send(w, { body, signature: 'sha256=0' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toBe(malformed.text);
    expect(w.calls).toEqual([]);
  });

  it('accepts the previous secret only while it is configured (rotation)', async () => {
    const w = fakeWorld();
    const old = await send(w, { secret: PREVIOUS });
    expect(old.status).toBe(401);
    const rotating = { secrets: { current: CURRENT, previous: PREVIOUS } };
    expect((await send(w, { secret: PREVIOUS }, rotating)).status).toBe(200);
    const next = workflowRunPayload('in_progress');
    expect((await send(w, { payload: next, secret: CURRENT }, rotating)).status).toBe(200);
    expect((await send(w, { secret: OTHER }, rotating)).status).toBe(401);
  });

  it('never calls timingSafeEqual on unequal lengths: 63/65-hex headers are a 401, not a throw', () => {
    const body = enc.encode('{}');
    const hex = createHmac('sha256', CURRENT).update(body).digest('hex');
    for (const header of [
      `sha256=${hex.slice(1)}`,
      `sha256=${hex}ab`,
      `sha256=${'0'.repeat(66)}`,
    ]) {
      expect(() => verifyGithubSignature(body, header, [CURRENT])).not.toThrow();
      expect(verifyGithubSignature(body, header, [CURRENT])).toBe('malformed');
    }
  });
});

describe('a stored delivery (§3.6, D0 M1, G3, G14)', () => {
  it('maps, validates and stores one L0 event, touches the signals, and records the hash last', async () => {
    const w = fakeWorld();
    const body = bytesOf(workflowRunPayload('completed'));
    const r = await send(w, { body });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, outcome: 'stored' });
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    const sha = sha256Hex(body);
    expect(w.rows).toEqual([
      {
        projectId: TARGET.projectId,
        workspaceId: TARGET.workspaceId,
        producerId: `gh-app_${INSTALLATION_ID}`,
        eventId: deliveryEventId(sha, 0),
        threadRef: expect.stringMatching(/^gh_[0-9a-f]{32}$/),
        agentRef: null,
        sequence: 2,
        type: 'task.completed',
        status: null,
        privacyClass: 'L0',
        occurredAt: new Date('2026-10-31T12:03:30Z'),
        receivedAt: NOW,
        usageDelta: null,
        attributes: {
          tool_name: 'github-actions',
          task_kind: 'ci.workflow',
          attempt: 1,
          duration_ms: 210_000,
        },
        encrypted: null,
      },
    ]);
    expect(w.touchSignal).toHaveBeenCalledWith(
      { projectId: TARGET.projectId, workspaceId: TARGET.workspaceId },
      NOW,
    );
    expect(w.calls).toEqual([
      'hasDelivery',
      'refreshRepositoryName',
      'routeTarget',
      'insertEvents',
      'touchSignal',
      'touchVerifiedDelivery',
      'recordDelivery:activity',
    ]);
    expect(w.deliveries.get(sha)).toBe('activity');
    expect(w.refreshed).toEqual([[INSTALLATION_ID, { repoId: REPO.id, fullName: REPO.full_name }]]);
  });

  it('stores check suites and pull requests too', async () => {
    const w = fakeWorld();
    expect(
      (await send(w, { payload: checkSuitePayload('completed'), event: 'check_suite' })).status,
    ).toBe(200);
    expect(
      (await send(w, { payload: pullRequestPayload('opened'), event: 'pull_request' })).status,
    ).toBe(200);
    expect(w.rows.map((r) => r.type)).toEqual(['task.completed', 'x.github.pr.opened']);
    expect(w.rows.every((r) => r.status === null && r.privacyClass === 'L0')).toBe(true);
  });
});

describe('replay and redelivery (D0 H2, TEST_PLAN D0 replay row)', () => {
  it('the same body with a new GUID, no GUID or a re-labelled event stores nothing new', async () => {
    const w = fakeWorld();
    const body = bytesOf(workflowRunPayload('completed'));
    expect((await send(w, { body })).status).toBe(200);
    const other = { 'x-github-delivery': '0d0c0ffe-0019-41f1-8000-000000000002' };
    const again = [
      await send(w, { body, headers: other }),
      await send(w, { body, headers: { 'x-github-delivery': '' } }),
      await send(w, { body, event: 'check_suite' }),
      await send(w, { body, event: 'pull_request' }),
    ];
    for (const r of again) {
      expect(r.status).toBe(202);
      expect(r.json).toEqual({ ok: true, outcome: 'duplicate' });
    }
    expect(w.rows).toHaveLength(1);
    expect(w.calls.filter((c) => c === 'insertEvents')).toHaveLength(1);
  });

  it('replayed installation bodies change nothing', async () => {
    const w = fakeWorld();
    const removed = bytesOf(
      installationRepositoriesPayload('removed', [], [[REPO.id, REPO.full_name]]),
    );
    const added = bytesOf(
      installationRepositoriesPayload('added', [[REPO.id, REPO.full_name]], []),
    );
    const ev = 'installation_repositories';
    expect((await send(w, { body: removed, event: ev })).status).toBe(200);
    expect((await send(w, { body: added, event: ev })).status).toBe(200);
    const replay = await send(w, { body: removed, event: ev });
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ ok: true, outcome: 'duplicate' });
    expect(w.changes).toHaveLength(2);

    const suspend = bytesOf(installationPayload('suspend'));
    const unsuspend = bytesOf(installationPayload('unsuspend'));
    expect((await send(w, { body: suspend, event: 'installation' })).status).toBe(200);
    expect((await send(w, { body: unsuspend, event: 'installation' })).status).toBe(200);
    expect((await send(w, { body: suspend, event: 'installation' })).status).toBe(202);
    expect(w.changes).toHaveLength(4);
    expect([...w.deliveries.values()]).toEqual([
      'installation',
      'installation',
      'installation',
      'installation',
    ]);
  });
});

describe('unwanted deliveries → 202, nothing stored (§3.4, G10–G12, G22, G23)', () => {
  const cases: Array<[string, unknown, string | null, string]> = [
    ['ping', pingPayload(), 'ping', 'ignored:shape'],
    ['push-like', { ref: SENTINEL, commits: [{ message: SENTINEL }] }, 'push', 'ignored:shape'],
    ['header disagrees', workflowRunPayload('completed'), 'check_suite', 'ignored:event_mismatch'],
    ['header missing', workflowRunPayload('completed'), null, 'ignored:event_mismatch'],
    ['unmapped action', pullRequestPayload('labeled'), 'pull_request', 'ignored:action'],
    [
      'no installation',
      { ...workflowRunPayload('completed'), installation: undefined },
      'workflow_run',
      'ignored:no_installation',
    ],
    [
      'GitHub Actions suite',
      checkSuitePayload('completed', { slug: 'github-actions' }),
      'check_suite',
      'ignored:github_actions_suite',
    ],
    [
      'null conclusion (G22)',
      workflowRunPayload('completed', { conclusion: null }),
      'workflow_run',
      'ignored:shape',
    ],
    [
      'unknown conclusion (G22)',
      workflowRunPayload('completed', { conclusion: 'exploded' }),
      'workflow_run',
      'ignored:shape',
    ],
  ];

  it.each(cases)('%s', async (_label, payload, event, outcome) => {
    const w = fakeWorld();
    const r = await send(w, { payload, event });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, outcome });
    expect(w.rows).toEqual([]);
    expect(w.changes).toEqual([]);
    expect(w.touchSignal).not.toHaveBeenCalled();
    // Y11: every verified, acknowledged body is recorded (activity class: purged after 3 days).
    expect(w.calls).toEqual(['hasDelivery', 'recordDelivery:activity']);
  });

  it('an unlinked or unrouted repository → 202 after the full_name refresh (G20)', async () => {
    const w = fakeWorld();
    w.state.route = null;
    const r = await send(w, {});
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, outcome: 'unrouted' });
    expect(w.rows).toEqual([]);
    expect(w.calls).toEqual([
      'hasDelivery',
      'refreshRepositoryName',
      'routeTarget',
      'recordDelivery:activity',
    ]);
  });

  it('installation new_permissions_accepted changes nothing → 202 (QA Y12)', async () => {
    const w = fakeWorld();
    const r = await send(w, {
      payload: installationPayload('new_permissions_accepted'),
      event: 'installation',
    });
    expect(r.status).toBe(202);
    expect(w.changes).toEqual([]);
    expect(w.calls).toEqual(['hasDelivery', 'recordDelivery:installation']);
  });
});

describe('a valid signature over a body that is not UTF-8 JSON → 202 (G18)', () => {
  it.each([
    ['not JSON', enc.encode('hello')],
    ['empty', new Uint8Array(0)],
    [
      'BOM-prefixed JSON',
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(workflowRunPayload('completed'))]),
    ],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
  ])('%s', async (_label, body) => {
    const w = fakeWorld();
    const r = await send(w, { body });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, outcome: 'not_json' });
    expect(w.rows).toEqual([]);
    expect(w.calls).toEqual(['hasDelivery', 'recordDelivery:activity']);
  });
});

describe('time rules (D0 H4, G21)', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString().replace('.000Z', 'Z');
  const H = 3_600_000;

  it('keeps exactly 72 h, drops 72 h + 1 s, per event timestamp', async () => {
    const w = fakeWorld();
    const keep = workflowRunPayload('completed', { updated_at: at(-72 * H) });
    expect((await send(w, { payload: keep })).status).toBe(200);
    for (const [payload, event] of [
      [workflowRunPayload('in_progress', { updated_at: at(-72 * H - 1000) }), 'workflow_run'],
      [checkSuitePayload('completed', { updated_at: at(-72 * H - 1000) }), 'check_suite'],
      [pullRequestPayload('synchronize', { updated_at: at(-72 * H - 1000) }), 'pull_request'],
    ] as const) {
      const before = w.calls.length;
      const r = await send(w, { payload, event });
      expect(r.status).toBe(202);
      expect(r.json).toEqual({ ok: true, outcome: 'too_old' });
      // No refresh or routing for a dropped old body.
      expect(w.calls.slice(before)).toEqual(['hasDelivery', 'recordDelivery:activity']);
    }
    expect(w.rows).toHaveLength(1);
  });

  it('installation deliveries are exempt from the 3-day rule', async () => {
    const w = fakeWorld();
    const r = await send(w, { payload: installationPayload('created'), event: 'installation' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, outcome: 'applied' });
    expect(w.changes).toHaveLength(1);
  });

  it('an event more than 5 minutes in the future is rejected by JD-M01 and nothing is stored', async () => {
    const w = fakeWorld();
    const future = workflowRunPayload('completed', { updated_at: at(6 * 60_000) });
    const r = await send(w, { payload: future });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, outcome: 'rejected' });
    expect(w.rows).toEqual([]);
    expect(w.deliveries.size).toBe(0);
    expect(w.touchSignal).not.toHaveBeenCalled();
    const soon = workflowRunPayload('completed', { updated_at: at(4 * 60_000) });
    expect((await send(w, { payload: soon })).status).toBe(200);
  });
});

describe('store failures → 500, nothing recorded, redelivery processed (§3.7, G14)', () => {
  it.each(['hasDelivery', 'routeTarget', 'insertEvents', 'touchSignal', 'touchVerifiedDelivery'])(
    '%s fails',
    async (failing) => {
      const w = fakeWorld();
      const body = bytesOf(workflowRunPayload('completed'));
      w.state.failing.add(failing);
      const r = await send(w, { body });
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: 'unavailable' });
      expect(w.deliveries.size).toBe(0);
      expect(r.text).not.toContain(SENTINEL);
      w.state.failing.clear();
      const again = await send(w, { body });
      expect(again.status).toBe(200);
      expect(w.rows).toHaveLength(1);
      expect(w.deliveries.size).toBe(1);
    },
  );

  it('an installation change that fails is a 500 too', async () => {
    const w = fakeWorld();
    w.state.failing.add('applyInstallationDelivery');
    const r = await send(w, { payload: installationPayload('created'), event: 'installation' });
    expect(r.status).toBe(500);
  });
});

describe('logs carry only GUID, event, action and outcome (§3.8, D0 H2)', () => {
  it('one line per request, no sentinel, secret, signature, header or body value', async () => {
    const w = fakeWorld();
    const body = bytesOf(workflowRunPayload('completed'));
    const signature = sign(body);
    const sends: Send[] = [
      { body },
      { body },
      { body, signature: sign(body, OTHER) },
      { body, signature: `sha256=${SENTINEL}` },
      { body, headers: { 'content-encoding': `${SENTINEL}-gzip` } },
      { payload: pullRequestPayload('opened'), event: `${SENTINEL}-event` },
      { payload: pingPayload(), event: 'ping' },
      { payload: installationPayload('created'), event: 'installation' },
      {
        payload: pullRequestPayload('closed', { merged: true }),
        event: 'pull_request',
        headers: { 'x-github-delivery': `${SENTINEL}-not-a-guid` },
      },
      { body: enc.encode(`${SENTINEL} not json`) },
    ];
    for (const s of sends) await send(w, s);
    w.state.failing.add('*');
    await send(w, { payload: checkSuitePayload('completed'), event: 'check_suite' });

    expect(w.logs).toHaveLength(sends.length + 1);
    const text = JSON.stringify(w.logs);
    for (const forbidden of [
      SENTINEL.toLowerCase(),
      CURRENT.toLowerCase(),
      signature.slice(7),
      sha256Hex(body),
      REPO.full_name,
      'postgresql',
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
    const allowed = new Set([
      'level',
      'module',
      'msg',
      'status',
      'outcome',
      'delivery',
      'event',
      'action',
    ]);
    for (const entry of w.logs) {
      for (const key of Object.keys(entry)) expect(allowed.has(key), key).toBe(true);
      if (entry.delivery !== undefined) expect(entry.delivery).toBe(GUID.toLowerCase());
    }
    expect(
      w.logs.map((l) => [l.status, l.outcome, l.event, l.action, l.delivery !== undefined]),
    ).toEqual([
      [200, 'stored', 'workflow_run', 'completed', true],
      [202, 'duplicate', undefined, undefined, true],
      [401, 'unauthorized', undefined, undefined, false],
      [401, 'unauthorized', undefined, undefined, false],
      [415, 'unsupported_encoding', undefined, undefined, false],
      [202, 'ignored:event_mismatch', undefined, undefined, true],
      [202, 'ignored:shape', 'ping', undefined, true],
      [200, 'applied', 'installation', 'created', true],
      [200, 'stored', 'pull_request', 'closed', false],
      [202, 'not_json', undefined, undefined, true],
      [500, 'error', undefined, undefined, true],
    ]);
    expect(w.logs.at(-1)?.level).toBe('error');
  });

  it('responses never echo the request', async () => {
    const w = fakeWorld();
    const r = await send(w, { payload: pullRequestPayload('opened'), event: 'pull_request' });
    expect(r.text).toBe(JSON.stringify({ ok: true, outcome: 'stored' }));
    expect(JSON.stringify(w.rows)).not.toContain(SENTINEL);
    expect(JSON.stringify(w.rows)).not.toContain(REPO.full_name);
  });
});
