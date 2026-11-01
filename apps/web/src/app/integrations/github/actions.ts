'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/auth';
import { githubRepository, parseGithubId, viewerGithubAccountId } from '@/lib/github';
import { canManageProject } from '@/lib/permissions';
import { getViewer, isUuid } from '@/lib/viewer';
import { CLAIM_MESSAGES, LINK_CONFIRM_REQUIRED } from './messages';

// GitHub installation claims and repository links (ADR-0019 §4; design review D0 H3, M5).
// Owners and admins only; the workspace and role come from the viewer (session + membership),
// the GitHub account id from Better Auth's `accounts` row, and the installation's account from
// the signed webhook row. Nothing from the request is trusted beyond the ids it names, and every
// id is re-checked in SQL against the viewer's workspace. Arguments are never logged.

export interface GithubActionState {
  error?: string;
  done?: string;
  /** Set when an L1/L2 project needs the explicit repository-name confirmation. */
  needsConfirm?: boolean;
}

const SIGNED_OUT = 'Your session ended. Sign in again to continue.';
const NOT_ALLOWED = 'Only workspace owners and admins can change GitHub connections.';
const NO_DB = 'GitHub connections need a database, and none is configured.';
const NO_INSTALLATION = 'We have no record of that installation.';
const NO_REPOSITORY = 'That repository is not available to this workspace.';
const NO_PROJECT = 'Project not found.';
const FAILED = 'That change could not be saved. Reload the page and try again.';

const failure = (msg: string, error: unknown): GithubActionState => {
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg,
      // The name only: driver messages can echo hosts, ids or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );
  return { error: FAILED };
};

/** The viewer and database when the viewer may change GitHub connections, else an error. */
const scope = async () => {
  const viewer = await getViewer();
  if (!viewer) return { error: SIGNED_OUT } as const;
  // Owners and admins only (ADR-0019 §4); the role comes from the membership row.
  if (!canManageProject(viewer.role)) return { error: NOT_ALLOWED } as const;
  const db = getDb();
  if (!db) return { error: NO_DB } as const;
  return { viewer, db } as const;
};

const revalidateGithub = (projectId?: string) => {
  revalidatePath('/integrations/github');
  revalidatePath('/integrations');
  if (projectId) revalidatePath(`/projects/${projectId}`);
};

/**
 * Claims an installation for the viewer's workspace (form field `installationId`). Checks, in
 * order: signed in → owner/admin → database → a well-formed id → the viewer's linked GitHub
 * account → JD-M10 `claimInstallation` (first claim wins, `User` installations only, the
 * installation's `account_id` from the signed webhook must equal the viewer's GitHub id).
 */
export async function claimInstallationAction(
  _prev: GithubActionState,
  form: FormData,
): Promise<GithubActionState> {
  const s = await scope();
  if ('error' in s) return { error: s.error };
  const installationId = parseGithubId(form.get('installationId'));
  if (installationId === null) return { error: CLAIM_MESSAGES.not_found };
  try {
    const githubAccountId = await viewerGithubAccountId(s.db, s.viewer.user.id);
    if (githubAccountId === null) return { error: CLAIM_MESSAGES.no_github_account };
    const result = await githubRepository(s.db).claimInstallation({
      workspaceId: s.viewer.workspaceId,
      installationId,
      githubAccountId,
    });
    if (result !== 'claimed' && result !== 'already_yours')
      return { error: CLAIM_MESSAGES[result] };
    revalidateGithub();
    return { done: CLAIM_MESSAGES[result] };
  } catch (error) {
    return failure('github claim failed', error);
  }
}

/**
 * Releases the workspace's claim (form field `installationId`) and clears its repository links
 * (D0 M5). Owners and admins; no GitHub account check, so a claim can be released even after the
 * GitHub account was unlinked.
 */
export async function releaseInstallationAction(
  _prev: GithubActionState,
  form: FormData,
): Promise<GithubActionState> {
  const s = await scope();
  if ('error' in s) return { error: s.error };
  const installationId = parseGithubId(form.get('installationId'));
  if (installationId === null) return { error: NO_INSTALLATION };
  try {
    const released = await githubRepository(s.db).releaseInstallation(
      s.viewer.workspaceId,
      installationId,
    );
    if (!released) return { error: NO_INSTALLATION };
  } catch (error) {
    return failure('github release failed', error);
  }
  revalidateGithub();
  revalidatePath('/projects', 'layout');
  return { done: 'Claim released. Its repository links were removed.' };
}

/**
 * Links a repository (form fields `repoId`, `projectId`) of an installation this workspace claimed
 * to a project of this workspace. Checks, in order: signed in → owner/admin → database → well-
 * formed ids → the project exists in the viewer's workspace → for an L1/L2 project, the form's
 * `confirmRepoName` must be `yes` (checked here, not only in the browser) → JD-M10
 * `linkRepository` (same workspace, one project per repository; the composite FKs refuse a
 * cross-workspace link in SQL as well).
 */
export async function linkRepositoryAction(
  _prev: GithubActionState,
  form: FormData,
): Promise<GithubActionState> {
  const s = await scope();
  if ('error' in s) return { error: s.error };
  const repoId = parseGithubId(form.get('repoId'));
  const projectId = form.get('projectId');
  if (!isUuid(projectId)) return { error: NO_PROJECT };
  if (repoId === null) return { error: NO_REPOSITORY };
  try {
    const project = await s.viewer.projects.getProject(s.viewer.workspaceId, projectId);
    if (!project) return { error: NO_PROJECT };
    if (project.privacyClass !== 'L0' && form.get('confirmRepoName') !== 'yes') {
      return { error: LINK_CONFIRM_REQUIRED, needsConfirm: true };
    }
    const result = await githubRepository(s.db).linkRepository({
      workspaceId: s.viewer.workspaceId,
      repoId,
      projectId: project.id,
      userId: s.viewer.user.id,
    });
    if (result === 'not_found') return { error: NO_REPOSITORY };
    if (result === 'linked_elsewhere') {
      return {
        error:
          'This repository is already linked to another project. Unlink it there first: a repository belongs to one project.',
      };
    }
  } catch (error) {
    return failure('github link failed', error);
  }
  revalidateGithub(projectId);
  return { done: 'Repository linked.' };
}

/** Removes the workspace's link of a repository (form fields `repoId`, `projectId`). */
export async function unlinkRepositoryAction(
  _prev: GithubActionState,
  form: FormData,
): Promise<GithubActionState> {
  const s = await scope();
  if ('error' in s) return { error: s.error };
  const repoId = parseGithubId(form.get('repoId'));
  const projectId = form.get('projectId');
  if (repoId === null) return { error: NO_REPOSITORY };
  try {
    const unlinked = await githubRepository(s.db).unlinkRepository(s.viewer.workspaceId, repoId);
    if (!unlinked) return { error: NO_REPOSITORY };
  } catch (error) {
    return failure('github unlink failed', error);
  }
  revalidateGithub(isUuid(projectId) ? projectId : undefined);
  return { done: 'Repository unlinked.' };
}
