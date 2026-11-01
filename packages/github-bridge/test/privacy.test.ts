import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  deliveryTimestamp,
  installationChange,
  isTooOld,
  mapDelivery,
  sha256Hex,
  type DeliveryKind,
} from '../src/index.ts';
import {
  checkSuitePayload,
  INSTALLATION_ID,
  installationPayload,
  installationRepositoriesPayload,
  pingPayload,
  pullRequestPayload,
  SENTINEL,
  workflowRunPayload,
} from './fixtures.ts';

// TEST_PLAN §S5g row "Never stored" (unit layer) and D0 L2: the bridge never READS the fields
// on ADR-0019's never-stored list, so it cannot copy them into events, rows or logs.

/**
 * Records every property access (get, has, own-property lookups, key enumeration) on a payload
 * and its nested objects, by dotted path; array indexes are recorded as `*`. Same pattern as
 * collectors/adapters/test/self-report.test.ts (S5d).
 */
const recordReads = (target: object) => {
  const reads = new Set<string>();
  const name = (key: string | symbol) =>
    typeof key === 'symbol' ? key.toString() : /^\d+$/.test(key) ? '*' : key;
  const wrap = (obj: object, prefix: string): object =>
    new Proxy(obj, {
      get(t, key, receiver) {
        const path = `${prefix}${name(key)}`;
        reads.add(path);
        const value: unknown = Reflect.get(t, key, receiver);
        return value !== null && typeof value === 'object' ? wrap(value, `${path}.`) : value;
      },
      has(t, key) {
        reads.add(`${prefix}${name(key)}`);
        return Reflect.has(t, key);
      },
      getOwnPropertyDescriptor(t, key) {
        reads.add(`${prefix}${name(key)}`);
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        reads.add(`${prefix}*keys`);
        return Reflect.ownKeys(t);
      },
    });
  return { proxy: wrap(target, ''), reads };
};

const ARRAY_READS = ['length', 'Symbol(Symbol.iterator)', '*'];
const list = (prefix: string, fields: string[]) => [
  prefix,
  ...ARRAY_READS.map((r) => `${prefix}.${r}`),
  ...fields.map((f) => `${prefix}.*.${f}`),
];

/** Every path the bridge may read (README "Fields read"). Anything else is a failure. */
const ALLOWED = new Set([
  'action',
  'workflow_run',
  'workflow_run.id',
  'workflow_run.run_attempt',
  'workflow_run.conclusion',
  'workflow_run.run_started_at',
  'workflow_run.updated_at',
  'check_suite',
  'check_suite.id',
  'check_suite.conclusion',
  'check_suite.app',
  'check_suite.app.slug',
  'check_suite.updated_at',
  'pull_request',
  'pull_request.number',
  'pull_request.draft',
  'pull_request.merged',
  'pull_request.updated_at',
  'installation',
  'installation.id',
  'installation.account',
  'installation.account.id',
  'installation.account.type',
  'repository',
  'repository.id',
  'repository.full_name',
  ...list('repositories', ['id', 'full_name']),
  ...list('repositories_added', ['id', 'full_name']),
  ...list('repositories_removed', ['id', 'full_name']),
]);

const ctx = {
  bodySha256: sha256Hex('x'),
  installationId: INSTALLATION_ID,
  projectSlug: 'web-app',
  receivedAt: new Date('2026-10-31T12:30:00Z'),
};

const cases: Array<[name: string, event: string, payload: object]> = [
  ['workflow_run requested', 'workflow_run', workflowRunPayload('requested')],
  [
    'workflow_run completed',
    'workflow_run',
    workflowRunPayload('completed', { conclusion: 'failure' }),
  ],
  ['check_suite completed', 'check_suite', checkSuitePayload('completed')],
  [
    'check_suite of GitHub Actions',
    'check_suite',
    checkSuitePayload('completed', { slug: 'github-actions' }),
  ],
  ['check_suite rerequested', 'check_suite', checkSuitePayload('rerequested')],
  ['pull_request opened', 'pull_request', pullRequestPayload('opened')],
  ['pull_request closed merged', 'pull_request', pullRequestPayload('closed', { merged: true })],
  ['pull_request edited', 'pull_request', pullRequestPayload('edited')],
  ['installation created', 'installation', installationPayload('created')],
  ['installation suspend', 'installation', installationPayload('suspend')],
  ['installation deleted', 'installation', installationPayload('deleted')],
  [
    'installation_repositories',
    'installation_repositories',
    installationRepositoriesPayload('added', [[1, 'a/b']], [[2, 'a/c']]),
  ],
  ['ping', 'ping', pingPayload()],
  ['mislabelled header', 'check_suite', workflowRunPayload('completed')],
];

describe('read trap: only the documented fields are read (ADR-0019 §5 never-stored list)', () => {
  it.each(cases)('%s', (_name, event, payload) => {
    const { proxy, reads } = recordReads(payload);
    const classified = classifyDelivery(proxy, event);
    for (const kind of ['workflow_run', 'check_suite', 'pull_request', 'installation'] as const) {
      deliveryTimestamp(kind as DeliveryKind, proxy);
      isTooOld(kind as DeliveryKind, proxy, ctx.receivedAt);
    }
    mapDelivery(classified, ctx);
    if (classified.kind === 'installation' || classified.kind === 'installation_repositories') {
      installationChange(classified);
    }
    const forbidden = [...reads].filter((r) => !ALLOWED.has(r));
    expect(forbidden).toEqual([]);
  });
});

describe('sentinels: nothing from a forbidden field reaches the output', () => {
  it.each(cases)('%s', (_name, event, payload) => {
    const classified = classifyDelivery(payload, event);
    const mapped = mapDelivery(classified, ctx);
    const change =
      classified.kind === 'installation' || classified.kind === 'installation_repositories'
        ? installationChange(classified)
        : null;
    const out = JSON.stringify({ classified, mapped, change });
    expect(out).not.toContain(SENTINEL);
  });

  it('events carry only L0 allowlisted attributes and no status', () => {
    for (const [, event, payload] of cases) {
      const mapped = mapDelivery(classifyDelivery(payload, event), ctx);
      if (!mapped.ok) continue;
      for (const e of mapped.events) {
        expect(e.privacy_class).toBe('L0');
        expect(e).not.toHaveProperty('status');
        expect(e).not.toHaveProperty('agent_ref');
        expect(e).not.toHaveProperty('usage_delta');
        expect(e).not.toHaveProperty('encrypted');
        for (const key of Object.keys(e.attributes ?? {})) {
          expect(['tool_name', 'task_kind', 'attempt', 'duration_ms']).toContain(key);
        }
        // Repository names stay in JD-M10 rows, never in events.
        expect(JSON.stringify(e)).not.toContain('octo');
      }
    }
  });
});
