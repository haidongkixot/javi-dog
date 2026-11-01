// Strict, read-minimal classification of a verified GitHub webhook payload (ADR-0019 §3, D0 H2,
// H3, H4, M6). Only the fields listed in README "Fields read" are ever accessed: titles, bodies,
// logins, emails, commit data, branch names, URLs and paths are never read, so they cannot leak
// into events, rows or logs (proved by a Proxy read recorder in test/privacy.test.ts).

/** Conclusions GitHub reports for completed workflow runs and check suites. */
export const CI_CONCLUSIONS = [
  'success',
  'neutral',
  'failure',
  'timed_out',
  'startup_failure',
  'cancelled',
  'skipped',
  'action_required',
  'stale',
] as const;
export type CiConclusion = (typeof CI_CONCLUSIONS)[number];

/**
 * CI apps whose check-suite slug becomes `tool_name`; any other app is `"other"` (ADR-0019 §5).
 * GitHub Actions' own suites are ignored: `workflow_run` already covers them.
 */
export const CI_APP_SLUGS = [
  'azure-pipelines',
  'buildkite',
  'circleci-checks',
  'cirrus-ci',
  'codecov',
  'google-cloud-build',
  'netlify',
  'semaphoreci',
  'sonarqubecloud',
  'travis-ci',
  'vercel',
] as const;
export type CiApp = (typeof CI_APP_SLUGS)[number] | 'other';

export const WORKFLOW_RUN_ACTIONS = ['requested', 'in_progress', 'completed'] as const;
export const PULL_REQUEST_ACTIONS = [
  'opened',
  'reopened',
  'synchronize',
  'converted_to_draft',
  'ready_for_review',
  'closed',
] as const;
export const INSTALLATION_ACTIONS = [
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
] as const;
export const INSTALLATION_REPOSITORIES_ACTIONS = ['added', 'removed'] as const;

export type WorkflowRunAction = (typeof WORKFLOW_RUN_ACTIONS)[number];
export type PullRequestAction = (typeof PULL_REQUEST_ACTIONS)[number];
export type InstallationAction = (typeof INSTALLATION_ACTIONS)[number];
export type InstallationRepositoriesAction = (typeof INSTALLATION_REPOSITORIES_ACTIONS)[number];

/** A repository as the bridge keeps it: numeric id and `owner/name` (stored only in JD-M10 rows). */
export interface RepoRef {
  repoId: number;
  fullName: string;
}

/** An installation as the bridge keeps it. `accountType` other than these two is ignored. */
export interface InstallationRef {
  installationId: number;
  accountId: number;
  accountType: 'User' | 'Organization';
}

export interface WorkflowRunDelivery {
  kind: 'workflow_run';
  action: WorkflowRunAction;
  installationId: number;
  repository: RepoRef;
  runId: number;
  runAttempt: number;
  /** Set only for `completed`. */
  conclusion: CiConclusion | null;
  /** `workflow_run.run_started_at`, when present and valid. */
  runStartedAt: Date | null;
  /** `workflow_run.updated_at` (the delivery timestamp, D0 H4). */
  updatedAt: Date;
}

export interface CheckSuiteDelivery {
  kind: 'check_suite';
  action: 'completed';
  installationId: number;
  repository: RepoRef;
  suiteId: number;
  conclusion: CiConclusion;
  ciApp: CiApp;
  /** `check_suite.updated_at` (D0 H4). */
  updatedAt: Date;
}

export interface PullRequestDelivery {
  kind: 'pull_request';
  action: PullRequestAction;
  installationId: number;
  repository: RepoRef;
  number: number;
  draft: boolean;
  /** Read only for `closed`; false otherwise. */
  merged: boolean;
  /** `pull_request.updated_at` (D0 H4). */
  updatedAt: Date;
}

export interface InstallationDelivery {
  kind: 'installation';
  action: InstallationAction;
  installation: InstallationRef;
  /** `repositories` of a `created` delivery; empty for every other action. */
  repositories: RepoRef[];
}

export interface InstallationRepositoriesDelivery {
  kind: 'installation_repositories';
  action: InstallationRepositoriesAction;
  installation: InstallationRef;
  added: RepoRef[];
  removed: RepoRef[];
}

/**
 * Why a verified delivery is acknowledged (202) and dropped:
 * - `shape`: no known payload shape (`ping`, `push`, anything else) or a malformed field;
 * - `ambiguous`: the payload matches more than one shape;
 * - `event_mismatch`: `X-GitHub-Event` is missing or names another kind (it is only a hint);
 * - `action`: an action the bridge does not map (`edited`, `labeled`, `rerequested`, …);
 * - `no_installation`: a run, suite or PR without `installation.id` (D0 H3);
 * - `github_actions_suite`: GitHub Actions' own check suite (covered by `workflow_run`).
 */
export type IgnoredReason =
  'shape' | 'ambiguous' | 'event_mismatch' | 'action' | 'no_installation' | 'github_actions_suite';

export interface IgnoredDelivery {
  kind: 'ignored';
  reason: IgnoredReason;
}

export type ClassifiedDelivery =
  | WorkflowRunDelivery
  | CheckSuiteDelivery
  | PullRequestDelivery
  | InstallationDelivery
  | InstallationRepositoriesDelivery
  | IgnoredDelivery;

/** Every kind but `ignored`. */
export type DeliveryKind = Exclude<ClassifiedDelivery['kind'], 'ignored'>;
/** Kinds that carry a source timestamp and fall under the 3-day rule (D0 H4). */
export type TimedKind = 'workflow_run' | 'check_suite' | 'pull_request';

/** GitHub's manual redelivery window; older deliveries are acknowledged and dropped (§3.5). */
export const DELIVERY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** `2020-01-22T19:33:08Z` (GitHub's form), with optional fraction and offset. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const toDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** `owner/name` with GitHub's character rules; anything else is a shape error. */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Reads `id` and `full_name` only. */
const repoRef = (v: unknown): RepoRef | null => {
  if (!isObj(v)) return null;
  const repoId = v.id;
  const fullName = v.full_name;
  if (!posInt(repoId) || typeof fullName !== 'string' || !FULL_NAME.test(fullName)) return null;
  return { repoId, fullName };
};

/** Reads `id`, `account.id` and `account.type` only (never `account.login`). */
const installationRef = (v: unknown): InstallationRef | null => {
  if (!isObj(v)) return null;
  const installationId = v.id;
  const account = v.account;
  if (!posInt(installationId) || !isObj(account)) return null;
  const accountId = account.id;
  const accountType = account.type;
  if (!posInt(accountId) || (accountType !== 'User' && accountType !== 'Organization')) return null;
  return { installationId, accountId, accountType };
};

const repoList = (v: unknown): RepoRef[] | null => {
  if (!Array.isArray(v)) return null;
  const out: RepoRef[] = [];
  for (const item of v as unknown[]) {
    const ref = repoRef(item);
    if (!ref) return null;
    out.push(ref);
  }
  return out;
};

/** `installation.id` of a run, suite or PR payload (its account is not needed there). */
const installationIdOf = (p: Obj): number | null => {
  const inst = p.installation;
  if (!isObj(inst)) return null;
  const id = inst.id;
  return posInt(id) ? id : null;
};

/** The kind(s) the payload's shape matches; decided by discriminating keys, never the header. */
const shapeKinds = (p: Obj): DeliveryKind[] => {
  const kinds: DeliveryKind[] = [];
  if (isObj(p.workflow_run)) kinds.push('workflow_run');
  if (isObj(p.check_suite)) kinds.push('check_suite');
  if (isObj(p.pull_request)) kinds.push('pull_request');
  const added = p.repositories_added;
  const removed = p.repositories_removed;
  if (Array.isArray(added) && Array.isArray(removed)) kinds.push('installation_repositories');
  if (kinds.length === 0 && isObj(p.installation) && oneOf(INSTALLATION_ACTIONS, p.action)) {
    // `repository` belongs to repository-scoped events, never to `installation`.
    if (!('repository' in p)) kinds.push('installation');
  }
  return kinds;
};

const ignored = (reason: IgnoredReason): IgnoredDelivery => ({ kind: 'ignored', reason });

/**
 * The delivery's source time (D0 H4): `workflow_run.updated_at`, `check_suite.updated_at` or
 * `pull_request.updated_at`. `null` for `installation*` (they carry no event time) and for a
 * missing or invalid timestamp. Reads that one field only.
 */
export const deliveryTimestamp = (kind: DeliveryKind, payload: unknown): Date | null => {
  if (kind === 'installation' || kind === 'installation_repositories') return null;
  if (!isObj(payload)) return null;
  // The timestamp lives in the object named like the kind (`workflow_run.updated_at`, …).
  const holder = payload[kind];
  return isObj(holder) ? toDate(holder.updated_at) : null;
};

/**
 * The 3-day rule (§3.5, D0 H4): true when the source timestamp is older than
 * `DELIVERY_MAX_AGE_MS` before `now`, and also when a timed kind has no valid timestamp (fail
 * closed). `installation*` deliveries are exempt (always false): the signed-body dedupe (D0 H2)
 * protects them.
 */
export const isTooOld = (kind: DeliveryKind, payload: unknown, now: Date): boolean => {
  if (kind === 'installation' || kind === 'installation_repositories') return false;
  const at = deliveryTimestamp(kind, payload);
  return at === null || now.getTime() - at.getTime() > DELIVERY_MAX_AGE_MS;
};

const classifyWorkflowRun = (p: Obj): ClassifiedDelivery => {
  if (!oneOf(WORKFLOW_RUN_ACTIONS, p.action)) return ignored('action');
  const action = p.action;
  const installationId = installationIdOf(p);
  if (installationId === null) return ignored('no_installation');
  const repository = repoRef(p.repository);
  const run = p.workflow_run as Obj;
  const runId = run.id;
  const runAttempt = run.run_attempt;
  const updatedAt = deliveryTimestamp('workflow_run', p);
  if (!repository || !posInt(runId) || !posInt(runAttempt) || !updatedAt) return ignored('shape');
  let conclusion: CiConclusion | null = null;
  if (action === 'completed') {
    const c = run.conclusion;
    if (!oneOf(CI_CONCLUSIONS, c)) return ignored('shape');
    conclusion = c;
  }
  return {
    kind: 'workflow_run',
    action,
    installationId,
    repository,
    runId,
    runAttempt,
    conclusion,
    runStartedAt: toDate(run.run_started_at),
    updatedAt,
  };
};

const classifyCheckSuite = (p: Obj): ClassifiedDelivery => {
  if (p.action !== 'completed') return ignored('action');
  const installationId = installationIdOf(p);
  if (installationId === null) return ignored('no_installation');
  const repository = repoRef(p.repository);
  const suite = p.check_suite as Obj;
  const suiteId = suite.id;
  const conclusion = suite.conclusion;
  const app = suite.app;
  const slug = isObj(app) ? app.slug : undefined;
  const updatedAt = deliveryTimestamp('check_suite', p);
  if (
    !repository ||
    !posInt(suiteId) ||
    !oneOf(CI_CONCLUSIONS, conclusion) ||
    typeof slug !== 'string' ||
    !updatedAt
  ) {
    return ignored('shape');
  }
  if (slug === 'github-actions') return ignored('github_actions_suite');
  return {
    kind: 'check_suite',
    action: 'completed',
    installationId,
    repository,
    suiteId,
    conclusion,
    ciApp: oneOf(CI_APP_SLUGS, slug) ? slug : 'other',
    updatedAt,
  };
};

const classifyPullRequest = (p: Obj): ClassifiedDelivery => {
  if (!oneOf(PULL_REQUEST_ACTIONS, p.action)) return ignored('action');
  const action = p.action;
  const installationId = installationIdOf(p);
  if (installationId === null) return ignored('no_installation');
  const repository = repoRef(p.repository);
  const pr = p.pull_request as Obj;
  const number = pr.number;
  const draft = pr.draft;
  const updatedAt = deliveryTimestamp('pull_request', p);
  if (!repository || !posInt(number) || typeof draft !== 'boolean' || !updatedAt) {
    return ignored('shape');
  }
  let merged = false;
  if (action === 'closed') {
    const m = pr.merged;
    if (typeof m !== 'boolean') return ignored('shape');
    merged = m;
  }
  return {
    kind: 'pull_request',
    action,
    installationId,
    repository,
    number,
    draft,
    merged,
    updatedAt,
  };
};

const classifyInstallation = (p: Obj): ClassifiedDelivery => {
  const action = p.action as InstallationAction; // checked by shapeKinds
  const installation = installationRef(p.installation);
  if (!installation) return ignored('shape');
  let repositories: RepoRef[] = [];
  if (action === 'created' && p.repositories !== undefined) {
    const list = repoList(p.repositories);
    if (!list) return ignored('shape');
    repositories = list;
  }
  return { kind: 'installation', action, installation, repositories };
};

const classifyInstallationRepositories = (p: Obj): ClassifiedDelivery => {
  if (!oneOf(INSTALLATION_REPOSITORIES_ACTIONS, p.action)) return ignored('action');
  const action = p.action;
  const installation = installationRef(p.installation);
  const added = repoList(p.repositories_added);
  const removed = repoList(p.repositories_removed);
  if (!installation || !added || !removed) return ignored('shape');
  return { kind: 'installation_repositories', action, installation, added, removed };
};

/**
 * Classifies a **verified** delivery (call only after `verifyGithubSignature` returned `ok`).
 * The kind comes from a strict check of the payload's shape; `X-GitHub-Event` is only a hint and
 * must name the same kind, otherwise the delivery is `ignored` (`event_mismatch`, D0 H2).
 * Returns only the fields the bridge maps; nothing else of the payload is read.
 */
export const classifyDelivery = (
  payload: unknown,
  headerEvent: string | null,
): ClassifiedDelivery => {
  if (!isObj(payload)) return ignored('shape');
  const kinds = shapeKinds(payload);
  if (kinds.length === 0) return ignored('shape');
  if (kinds.length > 1) return ignored('ambiguous');
  const kind = kinds[0]!;
  if (headerEvent !== kind) return ignored('event_mismatch');
  switch (kind) {
    case 'workflow_run':
      return classifyWorkflowRun(payload);
    case 'check_suite':
      return classifyCheckSuite(payload);
    case 'pull_request':
      return classifyPullRequest(payload);
    case 'installation':
      return classifyInstallation(payload);
    case 'installation_repositories':
      return classifyInstallationRepositories(payload);
  }
};
