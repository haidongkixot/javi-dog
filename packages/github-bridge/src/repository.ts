import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { DELIVERY_MAX_AGE_MS, type RepoRef } from './classify.ts';
import { isSha256Hex } from './ids.ts';
import type { InstallationChange } from './installations.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- composed schema type lives in JD-M06
export type GithubDb = PgDatabase<PgQueryResultHKT, any>;

// Raw SQL by table name, single statements only: neon-http has no interactive transactions
// (ADR-0008). Every write is idempotent or atomic on its own; multi-step writes are ordered so a
// retry converges. Workspace ids come from the caller's verified session, never from GitHub.

/** neon-http and PGlite both return `{ rows }` (same accessor as JD-M06, JD-M08, JD-M12). */
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Deliveries older than this are purged; GitHub redelivers manually for 3 days (D0 H2). */
export const deliveryCutoff = (now: Date) => new Date(now.getTime() - DELIVERY_MAX_AGE_MS);

export type ClaimResult =
  | 'claimed'
  /** Already claimed by this workspace (idempotent success). */
  | 'already_yours'
  | 'claimed_elsewhere'
  | 'not_found'
  /** Organization installations need an API-verified claim path (ADR-0019 §4, follow-up). */
  | 'organization'
  /** The signed-in GitHub account is not the installation's account. */
  | 'account_mismatch';

export type LinkResult =
  | 'linked'
  /** No such repository under an installation this workspace claimed, or no such project here. */
  | 'not_found'
  /** Linked to another project: one project per repository; unlink first. */
  | 'linked_elsewhere';

export interface RouteTarget {
  workspaceId: string;
  projectId: string;
  projectSlug: string;
}

export interface WorkspaceInstallation {
  installationId: number;
  accountType: 'User' | 'Organization';
  suspendedAt: Date | null;
  lastVerifiedDeliveryAt: Date | null;
  repositories: Array<{
    repoId: number;
    fullName: string;
    projectId: string | null;
    linkedAt: Date | null;
  }>;
}

const toDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);

const repoValues = (installationId: number, repos: RepoRef[]): SQL =>
  sql.join(
    repos.map((r) => sql`(${r.repoId}::bigint, ${installationId}::bigint, ${r.fullName})`),
    sql`, `,
  );

/** JD-M10 persistence (ADR-0019 §4, D0 H2/H3/M4/M5). */
export const createGithubRepository = (db: GithubDb) => ({
  /**
   * Records a verified body hash; `true` when it is new, `false` for a repeat (acknowledge and
   * drop, D0 H2). Throws `RangeError` for a hash that is not 64 lower-case hex.
   */
  async recordDelivery(bodySha256: string, receivedAt?: Date): Promise<boolean> {
    if (!isSha256Hex(bodySha256)) throw new RangeError('bodySha256 must be 64 lower-case hex.');
    const rows = rowsOf<{ one: number }>(
      await db.execute(sql`
        insert into github_deliveries (body_sha256, received_at)
        values (${bodySha256}, ${receivedAt ? ts(receivedAt) : sql`now()`})
        on conflict (body_sha256) do nothing
        returning 1 as one`),
    );
    return rows.length === 1;
  },

  /**
   * Forgets a recorded hash so GitHub's manual redelivery is processed again. For a route whose
   * processing failed after `recordDelivery` (it answers 500).
   */
  async forgetDelivery(bodySha256: string): Promise<void> {
    if (!isSha256Hex(bodySha256)) return;
    await db.execute(sql`delete from github_deliveries where body_sha256 = ${bodySha256}`);
  },

  /** Deletes hashes received before `cutoff` (see `deliveryCutoff`); returns the count. */
  async purgeDeliveriesBefore(cutoff: Date): Promise<number> {
    return rowsOf<{ one: number }>(
      await db.execute(sql`
        delete from github_deliveries where received_at < ${ts(cutoff)} returning 1 as one`),
    ).length;
  },

  /**
   * Applies a signed installation change. Ordered statements, each idempotent: installation
   * upsert → suspension → repository upserts (a repository that moved installation loses its
   * link) → removals (only while the repository still belongs to this installation). Account
   * fields are set once: an installation id never changes account on GitHub.
   */
  async applyInstallationChange(change: InstallationChange, at: Date = new Date()): Promise<void> {
    if (change.op === 'delete') {
      if (!isId(change.installationId)) return;
      await db.execute(
        sql`delete from github_installations where installation_id = ${change.installationId}`,
      );
      return;
    }
    const { installationId, accountId, accountType } = change.installation;
    if (!isId(installationId) || !isId(accountId)) throw new RangeError('invalid installation.');
    await db.execute(sql`
      insert into github_installations (installation_id, account_id, account_type)
      values (${installationId}, ${accountId}, ${accountType})
      on conflict (installation_id) do update set updated_at = now()`);
    if (change.suspended !== null) {
      await db.execute(
        change.suspended
          ? sql`update github_installations
                   set suspended_at = coalesce(suspended_at, ${ts(at)}), updated_at = now()
                 where installation_id = ${installationId}`
          : sql`update github_installations set suspended_at = null, updated_at = now()
                 where installation_id = ${installationId}`,
      );
    }
    const repos = change.upsertRepositories.filter((r) => isId(r.repoId));
    if (repos.length > 0) {
      // Same installation: refresh the name, keep the link. Other installation: move and unlink.
      await db.execute(sql`
        insert into github_repositories (repo_id, installation_id, full_name)
        values ${repoValues(installationId, repos)}
        on conflict (repo_id) do update set
          full_name = excluded.full_name,
          project_id = case when github_repositories.installation_id = excluded.installation_id
                            then github_repositories.project_id end,
          workspace_id = case when github_repositories.installation_id = excluded.installation_id
                              then github_repositories.workspace_id end,
          linked_at = case when github_repositories.installation_id = excluded.installation_id
                           then github_repositories.linked_at end,
          linked_by = case when github_repositories.installation_id = excluded.installation_id
                           then github_repositories.linked_by end,
          installation_id = excluded.installation_id,
          updated_at = now()`);
    }
    const removed = change.removeRepositoryIds.filter(isId);
    if (removed.length > 0) {
      await db.execute(sql`
        delete from github_repositories
         where installation_id = ${installationId}
           and repo_id in (${sql.join(
             removed.map((id) => sql`${id}::bigint`),
             sql`, `,
           )})`);
    }
  },

  /**
   * Refreshes `full_name` from a signed run, suite or PR delivery (ADR-0019 §4), only for a row
   * that belongs to that installation. A no-op when nothing changed.
   */
  async refreshRepositoryName(installationId: number, repo: RepoRef): Promise<void> {
    if (!isId(installationId) || !isId(repo.repoId)) return;
    await db.execute(sql`
      update github_repositories set full_name = ${repo.fullName}, updated_at = now()
       where repo_id = ${repo.repoId} and installation_id = ${installationId}
         and full_name <> ${repo.fullName}`);
  },

  /**
   * Claims an installation for a workspace (D0 M5): first claim wins (`… where
   * claimed_workspace_id is null`), only for a `User` installation whose `account_id` equals the
   * signed-in user's GitHub account id. The caller checks the owner/admin role first.
   */
  async claimInstallation(input: {
    workspaceId: string;
    installationId: number;
    githubAccountId: number;
  }): Promise<ClaimResult> {
    const { workspaceId, installationId, githubAccountId } = input;
    if (!isUuid(workspaceId) || !isId(installationId) || !isId(githubAccountId)) {
      return 'not_found';
    }
    const [row] = rowsOf<{
      account_id: number | string;
      account_type: string;
      claimed_workspace_id: string | null;
      claimed: number;
    }>(
      await db.execute(sql`
        with claim as (
          update github_installations
             set claimed_workspace_id = ${workspaceId}::uuid, updated_at = now()
           where installation_id = ${installationId}
             and claimed_workspace_id is null
             and account_type = 'User'
             and account_id = ${githubAccountId}
          returning installation_id)
        select i.account_id, i.account_type, i.claimed_workspace_id,
               (select count(*) from claim)::int as claimed
          from github_installations i
         where i.installation_id = ${installationId}`),
    );
    if (!row) return 'not_found';
    if (row.claimed === 1) return 'claimed';
    if (row.claimed_workspace_id === workspaceId) return 'already_yours';
    if (row.claimed_workspace_id !== null) return 'claimed_elsewhere';
    if (row.account_type !== 'User') return 'organization';
    return 'account_mismatch';
  },

  /**
   * Releases this workspace's claim and clears its repository links in one statement (D0 M5; a
   * data-modifying CTE always runs, and the composite FK is checked at the end of the statement).
   * `false` when the workspace did not hold the claim.
   */
  async releaseInstallation(workspaceId: string, installationId: number): Promise<boolean> {
    if (!isUuid(workspaceId) || !isId(installationId)) return false;
    const rows = rowsOf<{ installation_id: number }>(
      await db.execute(sql`
        with unlinked as (
          update github_repositories
             set project_id = null, workspace_id = null, linked_at = null, linked_by = null,
                 updated_at = now()
           where installation_id = ${installationId}
             and workspace_id = ${workspaceId}::uuid
          returning repo_id)
        update github_installations
           set claimed_workspace_id = null, updated_at = now()
         where installation_id = ${installationId}
           and claimed_workspace_id = ${workspaceId}::uuid
        returning installation_id`),
    );
    return rows.length === 1;
  },

  /**
   * Links a repository of an installation this workspace claimed to a project of the same
   * workspace (ADR-0019 §4). One project per repository: a repository linked elsewhere must be
   * unlinked first. The caller checks the role and the L1/L2 confirmation first.
   */
  async linkRepository(input: {
    workspaceId: string;
    repoId: number;
    projectId: string;
    userId: string;
  }): Promise<LinkResult> {
    const { workspaceId, repoId, projectId, userId } = input;
    if (!isUuid(workspaceId) || !isId(repoId) || !isUuid(projectId)) return 'not_found';
    const linkedBy = isUuid(userId) ? userId : null;
    const [row] = rowsOf<{ found: number; linked: number }>(
      await db.execute(sql`
        with target as (
          select r.repo_id, r.project_id as current_project
            from github_repositories r
            join github_installations i on i.installation_id = r.installation_id
            join projects p on p.id = ${projectId}::uuid and p.workspace_id = ${workspaceId}::uuid
           where r.repo_id = ${repoId}
             and i.claimed_workspace_id = ${workspaceId}::uuid),
        linked as (
          update github_repositories r
             set project_id = ${projectId}::uuid, workspace_id = ${workspaceId}::uuid,
                 linked_at = now(), linked_by = ${linkedBy}::uuid, updated_at = now()
            from target t
           where r.repo_id = t.repo_id
             and (t.current_project is null or t.current_project = ${projectId}::uuid)
          returning r.repo_id)
        select (select count(*) from target)::int as found,
               (select count(*) from linked)::int as linked`),
    );
    if (!row || row.found === 0) return 'not_found';
    return row.linked === 1 ? 'linked' : 'linked_elsewhere';
  },

  /** Removes this workspace's link of a repository; `false` when it had none. */
  async unlinkRepository(workspaceId: string, repoId: number): Promise<boolean> {
    if (!isUuid(workspaceId) || !isId(repoId)) return false;
    const rows = rowsOf<{ repo_id: number }>(
      await db.execute(sql`
        update github_repositories
           set project_id = null, workspace_id = null, linked_at = null, linked_by = null,
               updated_at = now()
         where repo_id = ${repoId} and workspace_id = ${workspaceId}::uuid
        returning repo_id`),
    );
    return rows.length === 1;
  },

  /**
   * Where a run, suite or PR delivery goes (D0 H3): the repository must belong to the payload's
   * installation, the installation must be claimed and unsuspended, and the claimed workspace
   * must be the linked project's workspace. `null` → acknowledge (202) and drop.
   */
  async routeTarget(installationId: number, repoId: number): Promise<RouteTarget | null> {
    if (!isId(installationId) || !isId(repoId)) return null;
    const [row] = rowsOf<{ workspace_id: string; project_id: string; slug: string }>(
      await db.execute(sql`
        select p.workspace_id, p.id as project_id, p.slug
          from github_repositories r
          join github_installations i on i.installation_id = r.installation_id
          join projects p on p.id = r.project_id and p.workspace_id = r.workspace_id
         where r.repo_id = ${repoId}
           and r.installation_id = ${installationId}
           and i.suspended_at is null
           and i.claimed_workspace_id = r.workspace_id`),
    );
    return row
      ? { workspaceId: row.workspace_id, projectId: row.project_id, projectSlug: row.slug }
      : null;
  },

  /**
   * Evidence for "Connected" (D0 M4). Forward-only and capped by the database clock, like
   * `touchSignal` in JD-M06.
   */
  async touchVerifiedDelivery(installationId: number, at: Date): Promise<void> {
    if (!isId(installationId)) return;
    await db.execute(sql`
      update github_installations
         set last_verified_delivery_at = greatest(last_verified_delivery_at, least(${ts(at)}, now()))
       where installation_id = ${installationId}`);
  },

  /** Installations claimed by the workspace, with their repositories (project page, Integrations). */
  async workspaceInstallations(workspaceId: string): Promise<WorkspaceInstallation[]> {
    if (!isUuid(workspaceId)) return [];
    const rows = rowsOf<{
      installation_id: number | string;
      account_type: 'User' | 'Organization';
      suspended_at: string | null;
      last_verified_delivery_at: string | null;
      repo_id: number | string | null;
      full_name: string | null;
      project_id: string | null;
      linked_at: string | null;
    }>(
      await db.execute(sql`
        select i.installation_id, i.account_type, i.suspended_at, i.last_verified_delivery_at,
               r.repo_id, r.full_name,
               case when r.workspace_id = i.claimed_workspace_id then r.project_id end as project_id,
               case when r.workspace_id = i.claimed_workspace_id then r.linked_at end as linked_at
          from github_installations i
          left join github_repositories r on r.installation_id = i.installation_id
         where i.claimed_workspace_id = ${workspaceId}::uuid
         order by i.installation_id, r.full_name, r.repo_id`),
    );
    const out = new Map<number, WorkspaceInstallation>();
    for (const row of rows) {
      const id = Number(row.installation_id);
      let inst = out.get(id);
      if (!inst) {
        inst = {
          installationId: id,
          accountType: row.account_type,
          suspendedAt: toDate(row.suspended_at),
          lastVerifiedDeliveryAt: toDate(row.last_verified_delivery_at),
          repositories: [],
        };
        out.set(id, inst);
      }
      if (row.repo_id !== null && row.full_name !== null) {
        inst.repositories.push({
          repoId: Number(row.repo_id),
          fullName: row.full_name,
          projectId: row.project_id,
          linkedAt: toDate(row.linked_at),
        });
      }
    }
    return [...out.values()];
  },

  /**
   * Unclaimed installations of a GitHub account (the signed-in user's own id), for the claim
   * prompt. No repository names: those are shown only after a claim.
   */
  async claimableInstallations(
    githubAccountId: number,
  ): Promise<Array<{ installationId: number; accountType: 'User' | 'Organization' }>> {
    if (!isId(githubAccountId)) return [];
    return rowsOf<{ installation_id: number | string; account_type: 'User' | 'Organization' }>(
      await db.execute(sql`
        select installation_id, account_type from github_installations
         where account_id = ${githubAccountId} and claimed_workspace_id is null
         order by installation_id`),
    ).map((r) => ({ installationId: Number(r.installation_id), accountType: r.account_type }));
  },
});

export type GithubRepository = ReturnType<typeof createGithubRepository>;
