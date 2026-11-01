import { createHash } from 'node:crypto';
import { validateEvent, type JgrEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  deliveryEventId,
  GITHUB_EVENT_ID_NAMESPACE,
  githubProducerId,
  mapDelivery,
  prThreadRef,
  runThreadRef,
  sha256Hex,
  suiteThreadRef,
  uuidV5,
  type MapContext,
} from '../src/index.ts';
import {
  checkSuitePayload,
  INSTALLATION_ID,
  installationPayload,
  installationRepositoriesPayload,
  pullRequestPayload,
  REPO,
  workflowRunPayload,
} from './fixtures.ts';

// TEST_PLAN §S5g row "Mapping" and D0 rows (UUIDv5 ids, refs, sequences, no status, M6 gaps).

const BODY = sha256Hex('body');
const ctx: MapContext = {
  bodySha256: BODY,
  installationId: INSTALLATION_ID,
  projectSlug: 'web-app',
  receivedAt: new Date('2026-10-31T12:30:00Z'),
};

const mapOne = (payload: unknown, event: string, c: MapContext = ctx): JgrEvent => {
  const result = mapDelivery(classifyDelivery(payload, event), c);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.events).toHaveLength(1);
  const e = result.events[0]!;
  // Independent JD-M01 check of the produced event (not only the one inside mapDelivery).
  expect(validateEvent(e, c.receivedAt)).toMatchObject({ ok: true });
  return e;
};

const hex32 = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 32);

describe('ids and refs', () => {
  it('uuidV5 matches the RFC 9562 / Python reference vector', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('event ids are lower-case UUIDv5 of <bodySha256>:<index> under the fixed namespace', () => {
    expect(GITHUB_EVENT_ID_NAMESPACE).toBe('a12f7c76-a99e-4db8-8b03-f0b8638b36da');
    const id = deliveryEventId(BODY, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toBe(uuidV5(GITHUB_EVENT_ID_NAMESPACE, `${BODY}:0`));
    expect(deliveryEventId(BODY, 1)).not.toBe(id);
    expect(() => deliveryEventId(BODY.toUpperCase(), 0)).toThrow(RangeError);
    expect(() => deliveryEventId(BODY, -1)).toThrow(RangeError);
  });

  it('thread refs are gh_ + 32 hex of SHA-256 over the documented keys', () => {
    expect(runThreadRef(5, 2)).toBe(`gh_${hex32('run|5|2')}`);
    expect(suiteThreadRef(9)).toBe(`gh_${hex32('suite|9')}`);
    expect(prThreadRef(777, 3)).toBe(`gh_${hex32('pr|777|3')}`);
    expect(githubProducerId(42)).toBe('gh-app_42');
  });
});

describe('workflow_run → task.* / x.github.ci.* (ADR-0019 §5, D0 M1, M3)', () => {
  it('requested and in_progress → task.started with ordinals 0 and 1', () => {
    const requested = mapOne(workflowRunPayload('requested'), 'workflow_run');
    expect(requested).toEqual({
      jgr: '0.1',
      event_id: deliveryEventId(BODY, 0),
      producer_id: `gh-app_${INSTALLATION_ID}`,
      project_ref: 'web-app',
      thread_ref: runThreadRef(30433642, 1),
      sequence: 0,
      type: 'task.started',
      occurred_at: '2026-10-31T12:03:30.000Z',
      privacy_class: 'L0',
      attributes: { tool_name: 'github-actions', task_kind: 'ci.workflow', attempt: 1 },
    });
    expect(requested).not.toHaveProperty('status');
    expect(mapOne(workflowRunPayload('in_progress'), 'workflow_run')).toMatchObject({
      type: 'task.started',
      sequence: 1,
    });
  });

  it.each([
    ['success', 'task.completed'],
    ['neutral', 'task.completed'],
    ['failure', 'task.failed'],
    ['timed_out', 'task.failed'],
    ['startup_failure', 'task.failed'],
    ['cancelled', 'x.github.ci.cancelled'],
    ['skipped', 'x.github.ci.skipped'],
    ['action_required', 'x.github.ci.attention'],
    ['stale', 'x.github.ci.attention'],
  ])('completed %s → %s, sequence 2, duration from run_started_at', (conclusion, type) => {
    const e = mapOne(workflowRunPayload('completed', { conclusion }), 'workflow_run');
    expect(e).toMatchObject({ type, sequence: 2 });
    expect(e.attributes).toEqual({
      tool_name: 'github-actions',
      task_kind: 'ci.workflow',
      attempt: 1,
      duration_ms: 210_000,
    });
    expect(e).not.toHaveProperty('status');
  });

  it('a re-run attempt gets its own thread, so sequences stay strictly increasing (D0 M3)', () => {
    const first = mapOne(workflowRunPayload('completed', { run_attempt: 1 }), 'workflow_run');
    const second = mapOne(workflowRunPayload('requested', { run_attempt: 2 }), 'workflow_run');
    expect(second.thread_ref).not.toBe(first.thread_ref);
    expect(second.thread_ref).toBe(runThreadRef(30433642, 2));
    expect(second.attributes).toMatchObject({ attempt: 2 });
  });
});

describe('check_suite → task.* / x.github.ci.*', () => {
  it('maps a non-Actions suite with its tool name and suite thread', () => {
    const e = mapOne(checkSuitePayload('completed', { conclusion: 'failure' }), 'check_suite');
    expect(e).toMatchObject({
      type: 'task.failed',
      thread_ref: suiteThreadRef(118578147),
      sequence: Date.parse('2026-10-31T12:05:00Z') / 1000,
      attributes: { tool_name: 'circleci-checks', task_kind: 'ci.check_suite' },
    });
    expect(e).not.toHaveProperty('status');
    expect(
      mapOne(
        checkSuitePayload('completed', { slug: 'acme-ci', conclusion: 'stale' }),
        'check_suite',
      ),
    ).toMatchObject({ type: 'x.github.ci.attention', attributes: { tool_name: 'other' } });
  });
});

describe('pull_request → x.github.pr.* (D0 M3, M6)', () => {
  const secs = Date.parse('2026-10-31T12:10:00Z') / 1000;
  it.each([
    ['opened', {}, 'x.github.pr.opened', 0],
    ['reopened', {}, 'x.github.pr.opened', 1],
    ['synchronize', {}, 'x.github.pr.updated', 2],
    ['converted_to_draft', { draft: true }, 'x.github.pr.updated', 3],
    ['ready_for_review', {}, 'x.github.pr.ready', 4],
    ['closed', { merged: false }, 'x.github.pr.closed', 5],
    ['closed', { merged: true }, 'x.github.pr.merged', 5],
  ] as const)('%s %o → %s (ordinal %i)', (action, over, type, ordinal) => {
    const e = mapOne(pullRequestPayload(action, over), 'pull_request');
    expect(e).toMatchObject({
      type,
      thread_ref: prThreadRef(REPO.id, 3),
      sequence: secs * 8 + ordinal,
      attributes: { task_kind: 'draft' in over && over.draft ? 'pr.draft' : 'pr' },
    });
    expect(Object.keys(e.attributes ?? {})).toEqual(['task_kind']);
    expect(e).not.toHaveProperty('status');
  });

  it('a later update always has a higher sequence than any earlier action', () => {
    const closed = mapOne(
      pullRequestPayload('closed', { updated_at: '2026-10-31T12:10:00Z' }),
      'pull_request',
    );
    const reopened = mapOne(
      pullRequestPayload('reopened', { updated_at: '2026-10-31T12:10:01Z' }),
      'pull_request',
    );
    expect(reopened.sequence).toBeGreaterThan(closed.sequence);
  });
});

describe('mapDelivery: dedupe, no-ops and guards', () => {
  it('the same body maps to the same event id; another body to another (D0 H2)', () => {
    const a = mapOne(pullRequestPayload('opened'), 'pull_request');
    const b = mapOne(pullRequestPayload('opened'), 'pull_request');
    const c = mapOne(pullRequestPayload('opened'), 'pull_request', {
      ...ctx,
      bodySha256: sha256Hex('other'),
    });
    expect(a.event_id).toBe(b.event_id);
    expect(c.event_id).not.toBe(a.event_id);
  });

  it('installation*, and ignored deliveries map to no events', () => {
    for (const [payload, event] of [
      [installationPayload('created'), 'installation'],
      [installationRepositoriesPayload('added', [[1, 'a/b']], []), 'installation_repositories'],
      [pullRequestPayload('labeled'), 'pull_request'],
    ] as const) {
      expect(mapDelivery(classifyDelivery(payload, event), ctx)).toEqual({ ok: true, events: [] });
    }
  });

  it('refuses a context whose installation differs from the payload’s, or a bad body hash', () => {
    const c = classifyDelivery(pullRequestPayload('opened'), 'pull_request');
    expect(() => mapDelivery(c, { ...ctx, installationId: 1 })).toThrow(RangeError);
    expect(() => mapDelivery(c, { ...ctx, bodySha256: 'abc' })).toThrow(RangeError);
  });

  it('returns JD-M01 issues (never payload values) when an event is invalid', () => {
    const c = classifyDelivery(
      pullRequestPayload('opened', { updated_at: '2026-10-31T13:00:00Z' }),
      'pull_request',
    );
    const result = mapDelivery(c, ctx); // 30 min ahead of receipt: clock_skew
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'clock_skew', path: 'occurred_at' })],
    });
    const bad = mapDelivery(c, {
      ...ctx,
      projectSlug: 'not/a/slug',
      receivedAt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(bad).toMatchObject({ ok: false, issues: [{ code: 'schema', path: 'project_ref' }] });
  });
});
