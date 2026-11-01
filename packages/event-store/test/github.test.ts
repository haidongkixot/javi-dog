import {
  classifyDelivery,
  createGithubRepository,
  deliveryHashKind,
  installationChange,
  sha256Hex,
  type InstallationChange,
  type InstallationDelivery,
  type InstallationRepositoriesDelivery,
} from '@javis-dog/github-bridge';
import { createProjectRepository } from '@javis-dog/projects';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEventRepository } from '../src/index.ts';
import { freshDb } from './helpers.ts';

// JD-M10 repository against the real migrations (0000–0006): TEST_PLAN §S5g rows
// "Installations", "Migration 0006" and the D0 rows on links, claims and replay.

let ctx: Awaited<ReturnType<typeof freshDb>>;
let projectsRepo: ReturnType<typeof createProjectRepository>;
let gh: ReturnType<typeof createGithubRepository>;
let events: ReturnType<typeof createEventRepository>;

beforeAll(async () => {
  ctx = await freshDb();
  projectsRepo = createProjectRepository(ctx.db);
  gh = createGithubRepository(ctx.db);
  events = createEventRepository(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, github_installations, github_deliveries cascade');
});

const INST = 100;
const ACCOUNT = 9001;
const USER = '00000000-0000-4000-8000-0000000000aa';

const setup = async (name = 'Signal team', projectName = 'Web') => {
  const ws = await projectsRepo.createWorkspace({ name });
  const p = await projectsRepo.createProject(ws.id, {
    name: projectName,
    platforms: ['claude-code'],
  });
  return { workspaceId: ws.id, projectId: p.id, slug: p.slug };
};

type Upsert = Extract<InstallationChange, { op: 'upsert' }>;

const upsert = (
  installationId: number,
  repos: Array<[number, string]> = [],
  over: Partial<Upsert> = {},
): Upsert => ({
  op: 'upsert',
  installation: { installationId, accountId: ACCOUNT, accountType: 'User' },
  suspended: null,
  upsertRepositories: repos.map(([repoId, fullName]) => ({ repoId, fullName })),
  removeRepositoryIds: [],
  ...over,
});

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await ctx.client.query<T>(sql, params)).rows[0];

const repoRow = (repoId: number) =>
  one<{
    installation_id: number;
    full_name: string;
    workspace_id: string | null;
    project_id: string | null;
    linked_at: Date | null;
  }>('select * from github_repositories where repo_id = $1', [repoId]);

/** Claimed installation INST with repo 1 linked to the workspace's project. */
const linked = async () => {
  const s = await setup();
  await gh.applyInstallationChange(upsert(INST, [[1, 'octo/one']]));
  expect(
    await gh.claimInstallation({
      workspaceId: s.workspaceId,
      installationId: INST,
      githubAccountId: ACCOUNT,
    }),
  ).toBe('claimed');
  expect(
    await gh.linkRepository({
      workspaceId: s.workspaceId,
      repoId: 1,
      projectId: s.projectId,
      userId: USER,
    }),
  ).toBe('linked');
  return s;
};

describe('delivery hashes (D0 H2)', () => {
  const h = sha256Hex('a body');

  it('records a body once; a repeat is reported whatever its kind', async () => {
    expect(await gh.hasDelivery(h)).toBe(false);
    expect(await gh.recordDelivery(h, 'activity')).toBe(true);
    expect(await gh.hasDelivery(h)).toBe(true);
    expect(await gh.recordDelivery(h, 'activity')).toBe(false);
    expect(await gh.recordDelivery(h, 'installation')).toBe(false); // the body is the key
    expect(await gh.hasDelivery('ABC')).toBe(false);
    await expect(gh.recordDelivery('ABC', 'activity')).rejects.toThrow(RangeError);
    await expect(gh.recordDelivery(h, 'other' as 'activity')).rejects.toThrow(RangeError);
    await expect(
      ctx.client.exec(`insert into github_deliveries (body_sha256) values ('${'A'.repeat(64)}')`),
    ).rejects.toThrow();
    await expect(
      ctx.client.exec(
        `insert into github_deliveries (body_sha256, kind) values ('${'b'.repeat(64)}', 'other')`,
      ),
    ).rejects.toThrow(/github_deliveries_kind_check/);
  });

  it('maps delivery kinds to hash classes', () => {
    expect(deliveryHashKind('installation')).toBe('installation');
    expect(deliveryHashKind('installation_repositories')).toBe('installation');
    for (const k of ['workflow_run', 'check_suite', 'pull_request'] as const) {
      expect(deliveryHashKind(k)).toBe('activity');
    }
  });

  it('purges activity hashes after 3 days, by itself and by the daily retention purge', async () => {
    const now = new Date('2026-11-04T00:00:00Z');
    await gh.recordDelivery(sha256Hex('old'), 'activity', new Date('2026-10-31T23:59:59Z'));
    await gh.recordDelivery(sha256Hex('edge'), 'activity', new Date('2026-11-01T00:00:00Z'));
    await gh.recordDelivery(sha256Hex('new'), 'activity', new Date('2026-11-03T00:00:00Z'));
    expect(await gh.purgeDeliveriesBefore(new Date('2026-11-01T00:00:00Z'))).toBe(1);
    await gh.recordDelivery(sha256Hex('old'), 'activity', new Date('2026-10-30T00:00:00Z'));
    await events.purgeEventsBefore(new Date('2026-10-01T00:00:00Z'), now);
    const left = await ctx.client.query<{ body_sha256: string }>(
      'select body_sha256 from github_deliveries order by received_at',
    );
    expect(left.rows.map((r) => r.body_sha256)).toEqual([sha256Hex('edge'), sha256Hex('new')]);
  });

  it('keeps installation hashes for good: an old body replayed after the purges is still a duplicate', async () => {
    const removed = sha256Hex('{"action":"removed","installation":{"id":100}}');
    const suspend = sha256Hex('{"action":"suspend","installation":{"id":100}}');
    const longAgo = new Date('2026-01-01T00:00:00Z');
    expect(await gh.recordDelivery(removed, 'installation', longAgo)).toBe(true);
    expect(await gh.recordDelivery(suspend, 'installation', longAgo)).toBe(true);
    await gh.recordDelivery(sha256Hex('activity'), 'activity', longAgo);

    const now = new Date('2026-11-04T00:00:00Z');
    expect(await gh.purgeDeliveriesBefore(now)).toBe(1); // the activity hash only
    await events.purgeEventsBefore(new Date('2026-10-01T00:00:00Z'), now);
    // Deleting the installation keeps them too (an old `created` body must not resurrect it).
    await gh.applyInstallationChange(upsert(INST));
    await gh.applyInstallationChange({ op: 'delete', installationId: INST });

    expect(await gh.recordDelivery(removed, 'installation')).toBe(false);
    expect(await gh.recordDelivery(suspend, 'installation')).toBe(false);
    expect(await gh.recordDelivery(sha256Hex('activity'), 'activity')).toBe(true);
  });

  it('applyInstallationDelivery applies once, then records the hash; a replay changes nothing', async () => {
    const body = sha256Hex('{"action":"suspend"}');
    const at = new Date('2026-11-01T10:00:00Z');
    expect(
      await gh.applyInstallationDelivery(upsert(INST, [], { suspended: true }), body, at),
    ).toBe('applied');
    await gh.applyInstallationChange(upsert(INST, [], { suspended: false }));
    // Replaying the captured suspend body (years later, after every purge) is refused.
    await events.purgeEventsBefore(
      new Date('2030-01-01T00:00:00Z'),
      new Date('2030-01-01T00:00:00Z'),
    );
    expect(await gh.applyInstallationDelivery(upsert(INST, [], { suspended: true }), body)).toBe(
      'duplicate',
    );
    expect(await one('select suspended_at from github_installations')).toEqual({
      suspended_at: null,
    });
    expect(await one('select kind from github_deliveries')).toEqual({ kind: 'installation' });
  });

  it('applyInstallationDelivery records nothing when the change fails (GitHub can redeliver)', async () => {
    const body = sha256Hex('{"action":"created"}');
    const bad = upsert(INST, [[-1, 'octo/x']]);
    // A repository row for an installation that cannot be created: force a failure.
    bad.installation = { installationId: INST, accountId: ACCOUNT, accountType: 'Bogus' as 'User' };
    await expect(gh.applyInstallationDelivery(bad, body)).rejects.toThrow();
    expect(await gh.hasDelivery(body)).toBe(false);
    expect(await gh.applyInstallationDelivery(upsert(INST), body)).toBe('applied');
  });
});

describe('installations from signed deliveries', () => {
  it('applies created → added/removed → suspend/unsuspend → deleted', async () => {
    const created = classifyDelivery(
      {
        action: 'created',
        installation: { id: INST, account: { id: ACCOUNT, type: 'User', login: 'x' } },
        repositories: [
          { id: 1, full_name: 'octo/one' },
          { id: 2, full_name: 'octo/two' },
        ],
      },
      'installation',
    ) as InstallationDelivery;
    await gh.applyInstallationChange(installationChange(created));
    expect(
      await one(
        'select account_id, account_type from github_installations where installation_id = $1',
        [INST],
      ),
    ).toEqual({ account_id: ACCOUNT, account_type: 'User' });

    const moved = classifyDelivery(
      {
        action: 'removed',
        installation: { id: INST, account: { id: ACCOUNT, type: 'User' } },
        repositories_added: [{ id: 3, full_name: 'octo/three' }],
        repositories_removed: [{ id: 2, full_name: 'octo/two' }],
      },
      'installation_repositories',
    ) as InstallationRepositoriesDelivery;
    await gh.applyInstallationChange(installationChange(moved));
    const repos = await ctx.client.query<{ repo_id: string }>(
      'select repo_id from github_repositories order by repo_id',
    );
    expect(repos.rows.map((r) => Number(r.repo_id))).toEqual([1, 3]);

    const at = new Date('2026-11-01T10:00:00Z');
    await gh.applyInstallationChange(upsert(INST, [], { suspended: true }), at);
    await gh.applyInstallationChange(upsert(INST, [], { suspended: true }), new Date());
    expect(
      await one<{ suspended_at: Date }>('select suspended_at from github_installations'),
    ).toEqual({ suspended_at: at }); // the first suspension time is kept
    await gh.applyInstallationChange(upsert(INST, [], { suspended: false }));
    expect(await one('select suspended_at from github_installations')).toEqual({
      suspended_at: null,
    });

    await gh.applyInstallationChange({ op: 'delete', installationId: INST });
    expect(await one('select count(*)::int as n from github_repositories')).toEqual({ n: 0 });
    expect(await one('select count(*)::int as n from github_installations')).toEqual({ n: 0 });
  });

  it('refreshes full_name and keeps the link for the same installation', async () => {
    const s = await linked();
    await gh.applyInstallationChange(upsert(INST, [[1, 'octo/renamed']]));
    expect(await repoRow(1)).toMatchObject({
      full_name: 'octo/renamed',
      project_id: s.projectId,
    });
    await gh.refreshRepositoryName(INST, { repoId: 1, fullName: 'octo/again' });
    await gh.refreshRepositoryName(999, { repoId: 1, fullName: 'evil/name' });
    expect(await repoRow(1)).toMatchObject({ full_name: 'octo/again', project_id: s.projectId });
  });

  it('a repository moving to another installation loses its link (D0 H3)', async () => {
    const s = await linked();
    await gh.applyInstallationChange(upsert(200, [[1, 'octo/one']]));
    expect(await repoRow(1)).toMatchObject({
      installation_id: 200,
      workspace_id: null,
      project_id: null,
      linked_at: null,
    });
    // A late removal from the old installation leaves the moved row alone.
    await gh.applyInstallationChange(upsert(INST, [], { removeRepositoryIds: [1] }));
    expect(await repoRow(1)).toMatchObject({ installation_id: 200 });
    expect(await gh.routeTarget(INST, 1)).toBeNull();
    expect(await gh.routeTarget(200, 1)).toBeNull();
    expect(s.projectId).toBeTruthy();
  });

  it('an installation id never changes account (account fields are set once)', async () => {
    await gh.applyInstallationChange(upsert(INST));
    await gh.applyInstallationChange({
      ...upsert(INST),
      installation: { installationId: INST, accountId: 1, accountType: 'Organization' },
    } as InstallationChange);
    expect(await one('select account_id, account_type from github_installations')).toEqual({
      account_id: ACCOUNT,
      account_type: 'User',
    });
  });
});

describe('claims (D0 M5)', () => {
  it('first claim wins; reports why a claim fails', async () => {
    const a = await setup('Team A');
    const b = await setup('Team B');
    await gh.applyInstallationChange(upsert(INST));
    const claim = (workspaceId: string, githubAccountId = ACCOUNT, installationId = INST) =>
      gh.claimInstallation({ workspaceId, installationId, githubAccountId });

    expect(await claim(a.workspaceId, 1)).toBe('account_mismatch');
    expect(await claim(a.workspaceId)).toBe('claimed');
    expect(await claim(a.workspaceId)).toBe('already_yours');
    expect(await claim(b.workspaceId)).toBe('claimed_elsewhere');
    expect(await claim(b.workspaceId, ACCOUNT, 555)).toBe('not_found');
    expect(await claim('not-a-uuid')).toBe('not_found');

    await gh.applyInstallationChange({
      ...upsert(300),
      installation: { installationId: 300, accountId: ACCOUNT, accountType: 'Organization' },
    });
    expect(await claim(b.workspaceId, ACCOUNT, 300)).toBe('organization');
    expect(
      await one(
        'select claimed_workspace_id from github_installations where installation_id = 300',
      ),
    ).toEqual({ claimed_workspace_id: null });
  });

  it('release clears the claim and its links; another workspace cannot release it', async () => {
    const s = await linked();
    const other = await setup('Other');
    expect(await gh.releaseInstallation(other.workspaceId, INST)).toBe(false);
    expect(await repoRow(1)).toMatchObject({ project_id: s.projectId });
    expect(await gh.releaseInstallation(s.workspaceId, INST)).toBe(true);
    expect(await repoRow(1)).toMatchObject({ project_id: null, workspace_id: null });
    expect(await one('select claimed_workspace_id from github_installations')).toEqual({
      claimed_workspace_id: null,
    });
    // Re-claiming follows the same rule.
    expect(
      await gh.claimInstallation({
        workspaceId: other.workspaceId,
        installationId: INST,
        githubAccountId: ACCOUNT,
      }),
    ).toBe('claimed');
  });

  it('lists claimable installations of an account and the workspace’s installations', async () => {
    const s = await linked();
    await gh.applyInstallationChange(upsert(400, [[9, 'octo/nine']]));
    expect(await gh.claimableInstallations(ACCOUNT)).toEqual([
      { installationId: 400, accountType: 'User' },
    ]);
    expect(await gh.claimableInstallations(1)).toEqual([]);
    const list = await gh.workspaceInstallations(s.workspaceId);
    expect(list).toEqual([
      {
        installationId: INST,
        accountId: ACCOUNT,
        accountType: 'User',
        suspendedAt: null,
        lastVerifiedDeliveryAt: null,
        repositories: [
          { repoId: 1, fullName: 'octo/one', projectId: s.projectId, linkedAt: expect.any(Date) },
        ],
      },
    ]);
    expect(await gh.workspaceInstallations((await setup('Empty')).workspaceId)).toEqual([]);
  });
});

describe('links (ADR-0019 §4, D0 H3)', () => {
  it('links within the claiming workspace only, one project per repository', async () => {
    const s = await linked();
    const second = await projectsRepo.createProject(s.workspaceId, {
      name: 'Second',
      platforms: ['claude-code'],
    });
    const other = await setup('Other');
    const link = (workspaceId: string, projectId: string, repoId = 1) =>
      gh.linkRepository({ workspaceId, repoId, projectId, userId: USER });

    expect(await link(s.workspaceId, s.projectId)).toBe('linked'); // idempotent
    expect(await link(s.workspaceId, second.id)).toBe('linked_elsewhere');
    expect(await link(other.workspaceId, other.projectId)).toBe('not_found'); // not its claim
    expect(await link(s.workspaceId, other.projectId)).toBe('not_found'); // other's project
    expect(await link(s.workspaceId, s.projectId, 42)).toBe('not_found');

    expect(await gh.unlinkRepository(other.workspaceId, 1)).toBe(false);
    expect(await gh.unlinkRepository(s.workspaceId, 1)).toBe(true);
    expect(await link(s.workspaceId, second.id)).toBe('linked');
    expect(await repoRow(1)).toMatchObject({ project_id: second.id, workspace_id: s.workspaceId });
  });

  it('refuses cross-workspace links at the SQL level', async () => {
    const a = await linked();
    const b = await setup('Team B');
    const update = (set: string) => ctx.client.exec(`update github_repositories set ${set}`);
    // Project of B under A's claim: the installation FK refuses it.
    await expect(
      update(`project_id = '${b.projectId}', workspace_id = '${b.workspaceId}'`),
    ).rejects.toThrow(/github_repositories_installation_workspace_fk/);
    // Project of B labelled as A's workspace: the project FK refuses it.
    await expect(
      update(`project_id = '${b.projectId}', workspace_id = '${a.workspaceId}'`),
    ).rejects.toThrow(/github_repositories_project_workspace_fk/);
    // Half a link: the check refuses it.
    await expect(update(`project_id = null`)).rejects.toThrow(/github_repositories_link_check/);
    // An unclaimed installation cannot carry a link at all.
    await gh.applyInstallationChange(upsert(500, [[5, 'octo/five']]));
    await expect(
      ctx.client.exec(
        `update github_repositories set project_id = '${a.projectId}', workspace_id = '${a.workspaceId}' where repo_id = 5`,
      ),
    ).rejects.toThrow(/github_repositories_installation_workspace_fk/);
    expect(await repoRow(1)).toMatchObject({ project_id: a.projectId });
  });

  it('deleting the project clears the link and keeps the repository row', async () => {
    const s = await linked();
    await ctx.client.query('delete from projects where id = $1', [s.projectId]);
    expect(await repoRow(1)).toMatchObject({
      full_name: 'octo/one',
      project_id: null,
      workspace_id: null,
    });
    expect(await one('select claimed_workspace_id from github_installations')).toEqual({
      claimed_workspace_id: s.workspaceId,
    });
  });

  it('deleting the workspace clears the claim and the links, keeping the rows', async () => {
    const s = await linked();
    await ctx.client.query('delete from workspaces where id = $1', [s.workspaceId]);
    expect(await repoRow(1)).toMatchObject({ project_id: null, workspace_id: null });
    expect(await one('select claimed_workspace_id from github_installations')).toEqual({
      claimed_workspace_id: null,
    });
  });
});

describe('routing (D0 H3)', () => {
  it('routes only a linked repository of the payload’s claimed, unsuspended installation', async () => {
    const s = await linked();
    expect(await gh.routeTarget(INST, 1)).toEqual({
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      projectSlug: s.slug,
    });
    expect(await gh.routeTarget(999, 1)).toBeNull(); // another installation id
    expect(await gh.routeTarget(INST, 2)).toBeNull(); // unknown repository

    await gh.applyInstallationChange(upsert(INST, [], { suspended: true }));
    expect(await gh.routeTarget(INST, 1)).toBeNull();
    await gh.applyInstallationChange(upsert(INST, [], { suspended: false }));
    expect(await gh.routeTarget(INST, 1)).not.toBeNull();

    await gh.unlinkRepository(s.workspaceId, 1);
    expect(await gh.routeTarget(INST, 1)).toBeNull();
  });
});

describe('touchVerifiedDelivery (D0 M4)', () => {
  it('is forward-only and capped by the database clock', async () => {
    await gh.applyInstallationChange(upsert(INST));
    const read = async () =>
      (await one<{ at: Date | null }>(
        'select last_verified_delivery_at as at from github_installations',
      ))!.at;
    expect(await read()).toBeNull();
    await gh.touchVerifiedDelivery(INST, new Date('2026-10-31T12:00:00Z'));
    expect(await read()).toEqual(new Date('2026-10-31T12:00:00Z'));
    await gh.touchVerifiedDelivery(INST, new Date('2026-10-30T12:00:00Z'));
    expect(await read()).toEqual(new Date('2026-10-31T12:00:00Z'));
    await gh.touchVerifiedDelivery(INST, new Date('2999-01-01T00:00:00Z'));
    expect((await read())!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
