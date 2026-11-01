// Payload fixtures shaped like GitHub's webhook schemas (OpenAPI `webhook-*`), with a sentinel
// planted in every field the bridge must never read or store (ADR-0019 §5 "Never stored", D0 L2).

export const SENTINEL = 'SENTINEL';
const s = (field: string) => `${SENTINEL}-${field}`;

export const INSTALLATION_ID = 4242;
export const ACCOUNT_ID = 9001;
export const REPO = { id: 777, full_name: 'octo-owner/octo-repo' };

/** A personal user object (sender, actor, requester, owner…) full of sentinels. */
const person = (field: string) => ({
  login: s(`${field}.login`),
  id: 31337,
  name: s(`${field}.name`),
  email: s(`${field}.email`),
  avatar_url: s(`${field}.avatar_url`),
  html_url: s(`${field}.html_url`),
  type: 'User',
});

const repository = (repo = REPO) => ({
  id: repo.id,
  node_id: s('repository.node_id'),
  name: s('repository.name'),
  full_name: repo.full_name,
  private: true,
  owner: person('repository.owner'),
  html_url: s('repository.html_url'),
  description: s('repository.description'),
  url: s('repository.url'),
  default_branch: s('repository.default_branch'),
  topics: [s('repository.topics')],
});

const installation = (id = INSTALLATION_ID) => ({ id, node_id: s('installation.node_id') });

const headCommit = () => ({
  id: s('head_commit.id'),
  tree_id: s('head_commit.tree_id'),
  message: s('head_commit.message'),
  timestamp: '2026-10-31T11:00:00Z',
  author: { name: s('head_commit.author.name'), email: s('head_commit.author.email') },
  committer: { name: s('head_commit.committer.name'), email: s('head_commit.committer.email') },
});

const common = () => ({
  repository: repository(),
  installation: installation(),
  sender: person('sender'),
  organization: { login: s('organization.login'), id: 5, url: s('organization.url') },
  enterprise: { name: s('enterprise.name'), slug: s('enterprise.slug'), id: 6 },
});

export const workflowRunPayload = (
  action: string,
  over: { conclusion?: string | null; run_attempt?: number; updated_at?: string } = {},
) => ({
  action,
  workflow_run: {
    id: 30433642,
    name: s('workflow_run.name'),
    node_id: s('workflow_run.node_id'),
    head_branch: s('workflow_run.head_branch'),
    head_sha: s('workflow_run.head_sha'),
    path: s('workflow_run.path'),
    display_title: s('workflow_run.display_title'),
    run_number: 562,
    event: 'push',
    status: action === 'completed' ? 'completed' : action,
    conclusion:
      over.conclusion !== undefined ? over.conclusion : action === 'completed' ? 'success' : null,
    workflow_id: 159038,
    url: s('workflow_run.url'),
    html_url: s('workflow_run.html_url'),
    pull_requests: [{ number: 3, head: { ref: s('workflow_run.pull_requests.head.ref') } }],
    created_at: '2026-10-31T11:58:00Z',
    updated_at: over.updated_at ?? '2026-10-31T12:03:30Z',
    actor: person('workflow_run.actor'),
    triggering_actor: person('workflow_run.triggering_actor'),
    run_attempt: over.run_attempt ?? 1,
    run_started_at: '2026-10-31T12:00:00Z',
    head_commit: headCommit(),
    repository: repository(),
    head_repository: repository(),
    referenced_workflows: [{ path: s('referenced_workflows.path'), ref: s('ref'), sha: s('sha') }],
  },
  workflow: { id: 159038, name: s('workflow.name'), path: s('workflow.path') },
  ...common(),
});

export const checkSuitePayload = (
  action: string,
  over: { conclusion?: string | null; slug?: string; updated_at?: string } = {},
) => ({
  action,
  check_suite: {
    id: 118578147,
    node_id: s('check_suite.node_id'),
    head_branch: s('check_suite.head_branch'),
    head_sha: s('check_suite.head_sha'),
    status: 'completed',
    conclusion: over.conclusion === undefined ? 'success' : over.conclusion,
    url: s('check_suite.url'),
    before: s('check_suite.before'),
    after: s('check_suite.after'),
    pull_requests: [{ number: 3, head: { ref: s('check_suite.pull_requests.head.ref') } }],
    app: {
      id: 1,
      slug: over.slug ?? 'circleci-checks',
      name: s('check_suite.app.name'),
      owner: person('check_suite.app.owner'),
      description: s('check_suite.app.description'),
      external_url: s('check_suite.app.external_url'),
    },
    created_at: '2026-10-31T12:00:00Z',
    updated_at: over.updated_at ?? '2026-10-31T12:05:00Z',
    head_commit: headCommit(),
  },
  ...common(),
});

export const pullRequestPayload = (
  action: string,
  over: { draft?: boolean; merged?: boolean | null; updated_at?: string; number?: number } = {},
) => ({
  action,
  number: over.number ?? 3,
  pull_request: {
    url: s('pull_request.url'),
    id: 191568743,
    node_id: s('pull_request.node_id'),
    html_url: s('pull_request.html_url'),
    diff_url: s('pull_request.diff_url'),
    number: over.number ?? 3,
    state: action === 'closed' ? 'closed' : 'open',
    locked: false,
    title: s('pull_request.title'),
    user: person('pull_request.user'),
    body: s('pull_request.body'),
    labels: [{ name: s('pull_request.labels.name') }],
    milestone: { title: s('pull_request.milestone.title') },
    created_at: '2026-10-31T10:00:00Z',
    updated_at: over.updated_at ?? '2026-10-31T12:10:00Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: s('pull_request.merge_commit_sha'),
    assignee: person('pull_request.assignee'),
    assignees: [person('pull_request.assignees')],
    requested_reviewers: [person('pull_request.requested_reviewers')],
    requested_teams: [{ name: s('pull_request.requested_teams.name') }],
    head: { label: s('head.label'), ref: s('head.ref'), sha: s('head.sha'), user: person('head') },
    base: { label: s('base.label'), ref: s('base.ref'), sha: s('base.sha'), user: person('base') },
    draft: over.draft ?? false,
    merged: over.merged === undefined ? false : over.merged,
    merged_by: person('pull_request.merged_by'),
    comments: 1,
    commits: 2,
    additions: 10,
    deletions: 3,
    changed_files: 1,
  },
  changes: { title: { from: s('changes.title.from') }, body: { from: s('changes.body.from') } },
  label: { name: s('label.name') },
  requested_reviewer: person('requested_reviewer'),
  ...common(),
});

const repoItem = (id: number, fullName: string) => ({
  id,
  node_id: s('repositories.node_id'),
  name: s('repositories.name'),
  full_name: fullName,
  private: true,
});

const installationObject = (
  over: { id?: number; accountId?: number; accountType?: string } = {},
) => ({
  id: over.id ?? INSTALLATION_ID,
  account: {
    ...person('installation.account'),
    id: over.accountId ?? ACCOUNT_ID,
    type: over.accountType ?? 'User',
  },
  repository_selection: 'selected',
  access_tokens_url: s('installation.access_tokens_url'),
  repositories_url: s('installation.repositories_url'),
  html_url: s('installation.html_url'),
  app_id: 1,
  app_slug: s('installation.app_slug'),
  target_id: over.accountId ?? ACCOUNT_ID,
  target_type: over.accountType ?? 'User',
  permissions: { metadata: 'read', pull_requests: 'read' },
  events: ['pull_request'],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  single_file_name: s('installation.single_file_name'),
  suspended_by: person('installation.suspended_by'),
  suspended_at: null,
  contact_email: s('installation.contact_email'),
});

export const installationPayload = (
  action: string,
  over: {
    id?: number;
    accountId?: number;
    accountType?: string;
    repositories?: Array<[number, string]>;
  } = {},
) => ({
  action,
  installation: installationObject(over),
  repositories: (over.repositories ?? [[REPO.id, REPO.full_name]]).map(([id, n]) =>
    repoItem(id, n),
  ),
  requester: person('requester'),
  sender: person('sender'),
});

export const installationRepositoriesPayload = (
  action: string,
  added: Array<[number, string]>,
  removed: Array<[number, string]>,
  over: { id?: number; accountId?: number } = {},
) => ({
  action,
  installation: installationObject(over),
  repository_selection: 'selected',
  repositories_added: added.map(([id, n]) => repoItem(id, n)),
  repositories_removed: removed.map(([id, n]) => repoItem(id, n)),
  requester: person('requester'),
  sender: person('sender'),
});

export const pingPayload = () => ({
  zen: s('zen'),
  hook_id: 1,
  hook: { type: 'App', config: { url: s('hook.config.url'), secret: s('hook.config.secret') } },
  sender: person('sender'),
});
