import {
  JGR_VERSION,
  validateEvent,
  type Issue,
  type JgrEvent,
  type JgrEventInput,
} from '@javis-dog/jgr-spec';
import type {
  CheckSuiteDelivery,
  CiConclusion,
  ClassifiedDelivery,
  PullRequestAction,
  PullRequestDelivery,
  WorkflowRunDelivery,
} from './classify.ts';
import {
  deliveryEventId,
  githubProducerId,
  isSha256Hex,
  prThreadRef,
  runThreadRef,
  suiteThreadRef,
} from './ids.ts';

/** Route-side facts the mapping needs; none of them comes from unsigned headers (D0 H2). */
export interface MapContext {
  /** Lower-case hex SHA-256 of the raw, verified body: seeds every `event_id`. */
  bodySha256: string;
  /** The installation the route resolved; must equal the payload's `installation.id` (D0 H3). */
  installationId: number;
  /** Slug of the linked project (`project_ref`). */
  projectSlug: string;
  /** Receipt time: the `now` of the JD-M01 validation (clock-skew rule). */
  receivedAt: Date;
}

export type MapResult =
  | { ok: true; events: JgrEvent[] }
  /** A produced event failed JD-M01 validation (codes and paths only, never payload values). */
  | { ok: false; issues: Issue[] };

/** `tool_name` of workflow runs (ADR-0019 §5). */
export const GITHUB_ACTIONS_TOOL = 'github-actions';

/** Run-thread sequence = the action ordinal (D0 M3). */
const RUN_ORDINAL = { requested: 0, in_progress: 1, completed: 2 } as const;

/**
 * PR-thread sequence = `updated_at` in seconds × 8 + this ordinal (D0 M3), so two actions in one
 * second still increase strictly in their natural order.
 */
export const PR_ACTION_ORDINAL: Record<PullRequestAction, number> = {
  opened: 0,
  reopened: 1,
  synchronize: 2,
  converted_to_draft: 3,
  ready_for_review: 4,
  closed: 5,
};

/** JGR type of a completed run or suite (ADR-0019 §5, D0 M1, M6). */
const conclusionType = (c: CiConclusion): string => {
  switch (c) {
    case 'success':
    case 'neutral':
      return 'task.completed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'task.failed';
    case 'cancelled':
      return 'x.github.ci.cancelled';
    case 'skipped':
      return 'x.github.ci.skipped';
    case 'action_required':
    case 'stale':
      return 'x.github.ci.attention';
  }
};

const PR_TYPE: Record<PullRequestAction, string> = {
  opened: 'x.github.pr.opened',
  reopened: 'x.github.pr.opened',
  synchronize: 'x.github.pr.updated',
  converted_to_draft: 'x.github.pr.updated',
  ready_for_review: 'x.github.pr.ready',
  closed: 'x.github.pr.closed',
};

type Draft = Pick<JgrEventInput, 'thread_ref' | 'sequence' | 'type' | 'attributes'> & {
  occurredAt: Date;
};

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

const workflowRunEvent = (c: WorkflowRunDelivery): Draft => {
  const attributes: Record<string, string | number> = {
    tool_name: GITHUB_ACTIONS_TOOL,
    task_kind: 'ci.workflow',
    attempt: c.runAttempt,
  };
  let type = 'task.started';
  if (c.action === 'completed') {
    type = conclusionType(c.conclusion!);
    if (c.runStartedAt) {
      const duration = c.updatedAt.getTime() - c.runStartedAt.getTime();
      if (duration >= 0) attributes.duration_ms = duration;
    }
  }
  return {
    thread_ref: runThreadRef(c.runId, c.runAttempt),
    sequence: RUN_ORDINAL[c.action],
    type,
    attributes,
    occurredAt: c.updatedAt,
  };
};

const checkSuiteEvent = (c: CheckSuiteDelivery): Draft => ({
  thread_ref: suiteThreadRef(c.suiteId),
  // One `completed` per suite run; a re-requested suite completes again later (higher second).
  sequence: seconds(c.updatedAt),
  type: conclusionType(c.conclusion),
  attributes: { tool_name: c.ciApp, task_kind: 'ci.check_suite' },
  occurredAt: c.updatedAt,
});

const pullRequestEvent = (c: PullRequestDelivery): Draft => ({
  thread_ref: prThreadRef(c.repository.repoId, c.number),
  sequence: seconds(c.updatedAt) * 8 + PR_ACTION_ORDINAL[c.action],
  type: c.action === 'closed' && c.merged ? 'x.github.pr.merged' : PR_TYPE[c.action],
  attributes: { task_kind: c.draft ? 'pr.draft' : 'pr' },
  occurredAt: c.updatedAt,
});

/**
 * Maps a classified delivery to JGR events exactly as ADR-0019 §5 and D0 M1/M3/M6 say: L0 only,
 * **no `status`**, `producer_id` `gh-app_<installation_id>`, `event_id` = UUIDv5 of
 * `<bodySha256>:<index>`, `occurred_at` = GitHub's `updated_at`. Every event is validated with
 * JD-M01 against `receivedAt`. `installation*` and `ignored` deliveries map to no events.
 *
 * Throws `RangeError` for a malformed context (a route bug, never payload data): a body hash that
 * is not 64 lower-case hex, or an `installationId` that differs from the payload's.
 */
export const mapDelivery = (classified: ClassifiedDelivery, ctx: MapContext): MapResult => {
  if (!isSha256Hex(ctx.bodySha256)) throw new RangeError('bodySha256 must be 64 lower-case hex.');
  let draft: Draft;
  switch (classified.kind) {
    case 'workflow_run':
      draft = workflowRunEvent(classified);
      break;
    case 'check_suite':
      draft = checkSuiteEvent(classified);
      break;
    case 'pull_request':
      draft = pullRequestEvent(classified);
      break;
    default:
      return { ok: true, events: [] };
  }
  if (classified.installationId !== ctx.installationId) {
    throw new RangeError('installationId does not match the delivery.');
  }
  const drafts = [draft];
  const events: JgrEvent[] = [];
  for (const [index, d] of drafts.entries()) {
    const input: JgrEventInput = {
      jgr: JGR_VERSION,
      event_id: deliveryEventId(ctx.bodySha256, index),
      producer_id: githubProducerId(ctx.installationId),
      project_ref: ctx.projectSlug,
      thread_ref: d.thread_ref,
      sequence: d.sequence,
      type: d.type,
      occurred_at: d.occurredAt.toISOString(),
      privacy_class: 'L0',
      ...(d.attributes ? { attributes: d.attributes } : {}),
    };
    const result = validateEvent(input, ctx.receivedAt);
    if (!result.ok) return { ok: false, issues: result.issues };
    events.push(result.event);
  }
  return { ok: true, events };
};
