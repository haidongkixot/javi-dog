import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  DELIVERY_MAX_AGE_MS,
  deliveryTimestamp,
  isTooOld,
  type DeliveryKind,
} from '../src/index.ts';
import {
  ACCOUNT_ID,
  checkSuitePayload,
  INSTALLATION_ID,
  installationPayload,
  installationRepositoriesPayload,
  pingPayload,
  pullRequestPayload,
  REPO,
  workflowRunPayload,
} from './fixtures.ts';

// TEST_PLAN §S5g rows "Route: unknown event, ping → 202" (classification part), "D0: re-labelled
// X-GitHub-Event stores nothing new" and "D0: per-event 3-day timestamps".

const repository = { repoId: REPO.id, fullName: REPO.full_name };

describe('classifyDelivery: kinds from the payload shape', () => {
  it('workflow_run requested / in_progress / completed', () => {
    expect(classifyDelivery(workflowRunPayload('requested'), 'workflow_run')).toEqual({
      kind: 'workflow_run',
      action: 'requested',
      installationId: INSTALLATION_ID,
      repository,
      runId: 30433642,
      runAttempt: 1,
      conclusion: null,
      runStartedAt: new Date('2026-10-31T12:00:00Z'),
      updatedAt: new Date('2026-10-31T12:03:30Z'),
    });
    expect(
      classifyDelivery(
        workflowRunPayload('completed', { conclusion: 'failure', run_attempt: 2 }),
        'workflow_run',
      ),
    ).toMatchObject({
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'failure',
      runAttempt: 2,
    });
  });

  it('check_suite completed, with CI app slug or "other"', () => {
    expect(classifyDelivery(checkSuitePayload('completed'), 'check_suite')).toEqual({
      kind: 'check_suite',
      action: 'completed',
      installationId: INSTALLATION_ID,
      repository,
      suiteId: 118578147,
      conclusion: 'success',
      ciApp: 'circleci-checks',
      updatedAt: new Date('2026-10-31T12:05:00Z'),
    });
    expect(
      classifyDelivery(checkSuitePayload('completed', { slug: 'my-own-ci' }), 'check_suite'),
    ).toMatchObject({ kind: 'check_suite', ciApp: 'other' });
    // G24: an app without a string slug is an unknown app, not a malformed delivery.
    const noSlug = checkSuitePayload('completed') as {
      check_suite: { app: Record<string, unknown> };
    };
    delete noSlug.check_suite.app.slug;
    expect(classifyDelivery(noSlug, 'check_suite')).toMatchObject({
      kind: 'check_suite',
      ciApp: 'other',
    });
    noSlug.check_suite.app.slug = 42;
    expect(classifyDelivery(noSlug, 'check_suite')).toMatchObject({ ciApp: 'other' });
  });

  it('pull_request actions, draft and merged', () => {
    expect(classifyDelivery(pullRequestPayload('opened', { draft: true }), 'pull_request')).toEqual(
      {
        kind: 'pull_request',
        action: 'opened',
        installationId: INSTALLATION_ID,
        repository,
        number: 3,
        draft: true,
        merged: false,
        updatedAt: new Date('2026-10-31T12:10:00Z'),
      },
    );
    expect(
      classifyDelivery(pullRequestPayload('closed', { merged: true }), 'pull_request'),
    ).toMatchObject({ action: 'closed', merged: true });
  });

  it('installation and installation_repositories', () => {
    expect(classifyDelivery(installationPayload('created'), 'installation')).toEqual({
      kind: 'installation',
      action: 'created',
      installation: {
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
        accountType: 'User',
      },
      repositories: [repository],
    });
    expect(classifyDelivery(installationPayload('suspend'), 'installation')).toMatchObject({
      action: 'suspend',
      repositories: [],
    });
    expect(
      classifyDelivery(
        installationRepositoriesPayload('added', [[1, 'a/b']], [[2, 'a/c']]),
        'installation_repositories',
      ),
    ).toEqual({
      kind: 'installation_repositories',
      action: 'added',
      installation: {
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
        accountType: 'User',
      },
      added: [{ repoId: 1, fullName: 'a/b' }],
      removed: [{ repoId: 2, fullName: 'a/c' }],
    });
  });
});

describe('classifyDelivery: ignored deliveries', () => {
  it('ping, push-like and junk payloads → shape', () => {
    expect(classifyDelivery(pingPayload(), 'ping')).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(classifyDelivery({ ref: 'refs/heads/x', commits: [] }, 'push')).toMatchObject({
      reason: 'shape',
    });
    for (const junk of [null, 'x', 1, [], [workflowRunPayload('completed')]]) {
      expect(classifyDelivery(junk, 'workflow_run')).toEqual({ kind: 'ignored', reason: 'shape' });
    }
  });

  it('a header that names another kind, or none, → event_mismatch (D0 H2)', () => {
    expect(classifyDelivery(workflowRunPayload('completed'), 'check_suite')).toEqual({
      kind: 'ignored',
      reason: 'event_mismatch',
    });
    expect(classifyDelivery(workflowRunPayload('completed'), null)).toMatchObject({
      reason: 'event_mismatch',
    });
    expect(
      classifyDelivery(installationPayload('deleted'), 'installation_repositories'),
    ).toMatchObject({ reason: 'event_mismatch' });
    expect(classifyDelivery(pullRequestPayload('opened'), 'PULL_REQUEST')).toMatchObject({
      reason: 'event_mismatch',
    });
  });

  it('a payload with two discriminating objects → ambiguous', () => {
    const both = {
      ...workflowRunPayload('completed'),
      check_suite: checkSuitePayload('completed').check_suite,
    };
    expect(classifyDelivery(both, 'workflow_run')).toEqual({
      kind: 'ignored',
      reason: 'ambiguous',
    });
  });

  it.each([
    ['workflow_run', workflowRunPayload('queued')],
    ['check_suite', checkSuitePayload('requested')],
    ['check_suite', checkSuitePayload('rerequested')],
    ['pull_request', pullRequestPayload('edited')],
    ['pull_request', pullRequestPayload('labeled')],
    ['pull_request', pullRequestPayload('review_requested')],
    ['installation_repositories', installationRepositoriesPayload('renamed', [], [])],
  ])('unmapped action of %s → action', (event, payload) => {
    expect(classifyDelivery(payload, event)).toEqual({ kind: 'ignored', reason: 'action' });
  });

  it('unknown installation actions are not an installation shape', () => {
    expect(classifyDelivery(installationPayload('unknown_action'), 'installation')).toMatchObject({
      reason: 'shape',
    });
  });

  it.each([
    ['workflow_run', workflowRunPayload('completed')],
    ['check_suite', checkSuitePayload('completed')],
    ['pull_request', pullRequestPayload('opened')],
  ])('%s without installation.id → no_installation (D0 H3)', (event, payload) => {
    const rest: Record<string, unknown> = { ...payload };
    delete rest.installation;
    expect(classifyDelivery(rest, event)).toEqual({ kind: 'ignored', reason: 'no_installation' });
    expect(classifyDelivery({ ...rest, installation: { id: '4242' } }, event)).toMatchObject({
      reason: 'no_installation',
    });
  });

  it('GitHub Actions’ own check suites → github_actions_suite', () => {
    expect(
      classifyDelivery(checkSuitePayload('completed', { slug: 'github-actions' }), 'check_suite'),
    ).toEqual({ kind: 'ignored', reason: 'github_actions_suite' });
  });

  it.each<[string, string, Record<string, unknown>]>([
    [
      'bad repo id',
      'workflow_run',
      { ...workflowRunPayload('completed'), repository: { id: -1, full_name: 'a/b' } },
    ],
    [
      'repo name with a space',
      'workflow_run',
      { ...workflowRunPayload('completed'), repository: { id: 1, full_name: 'a b/c' } },
    ],
    [
      'unknown conclusion',
      'workflow_run',
      workflowRunPayload('completed', { conclusion: 'weird' }),
    ],
    [
      'completed without conclusion',
      'workflow_run',
      workflowRunPayload('completed', { conclusion: null }),
    ],
    [
      'non-ISO updated_at',
      'workflow_run',
      workflowRunPayload('completed', { updated_at: 'yesterday' }),
    ],
    [
      'suite without conclusion',
      'check_suite',
      checkSuitePayload('completed', { conclusion: null }),
    ],
    [
      'closed PR without merged flag',
      'pull_request',
      pullRequestPayload('closed', { merged: null }),
    ],
    [
      'enterprise account',
      'installation',
      installationPayload('created', { accountType: 'Enterprise' }),
    ],
    [
      'bad repository entry',
      'installation',
      installationPayload('created', { repositories: [[0, 'a/b']] }),
    ],
  ])('%s → shape', (_name, event, payload) => {
    expect(classifyDelivery(payload, event)).toEqual({ kind: 'ignored', reason: 'shape' });
  });
});

describe('deliveryTimestamp and isTooOld (D0 H4)', () => {
  const now = new Date('2026-11-03T12:10:00Z');

  it('reads updated_at per kind; installation* have none', () => {
    expect(deliveryTimestamp('workflow_run', workflowRunPayload('completed'))).toEqual(
      new Date('2026-10-31T12:03:30Z'),
    );
    expect(deliveryTimestamp('check_suite', checkSuitePayload('completed'))).toEqual(
      new Date('2026-10-31T12:05:00Z'),
    );
    expect(deliveryTimestamp('pull_request', pullRequestPayload('opened'))).toEqual(
      new Date('2026-10-31T12:10:00Z'),
    );
    expect(deliveryTimestamp('installation', installationPayload('created'))).toBeNull();
    expect(deliveryTimestamp('pull_request', null)).toBeNull();
  });

  it('drops a delivery older than 3 days and keeps one at exactly 3 days', () => {
    const at = (iso: string) => pullRequestPayload('opened', { updated_at: iso });
    expect(DELIVERY_MAX_AGE_MS).toBe(259_200_000);
    expect(isTooOld('pull_request', at('2026-10-31T12:10:00Z'), now)).toBe(false); // exactly 3 d
    expect(isTooOld('pull_request', at('2026-10-31T12:09:59Z'), now)).toBe(true);
    expect(isTooOld('pull_request', at('2026-11-03T12:00:00Z'), now)).toBe(false);
  });

  it.each<DeliveryKind>(['workflow_run', 'check_suite', 'pull_request'])(
    '%s without a valid timestamp is too old (fail closed)',
    (kind) => {
      expect(isTooOld(kind, { [kind]: { updated_at: 'not a date' } }, now)).toBe(true);
      expect(isTooOld(kind, {}, now)).toBe(true);
    },
  );

  it('installation* are exempt, however old', () => {
    const later = new Date('2030-01-01T00:00:00Z');
    expect(isTooOld('installation', installationPayload('created'), later)).toBe(false);
    expect(
      isTooOld(
        'installation_repositories',
        installationRepositoriesPayload('added', [], []),
        later,
      ),
    ).toBe(false);
  });
});
