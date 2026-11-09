'use server';

import { revalidatePath } from 'next/cache';
import {
  MAX_ACTIVE_TOKENS_PER_PROJECT,
  MAX_PROJECTS_PER_WORKSPACE,
  MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY,
  PrivacyClass,
  ProjectRepositoryError,
  type ProjectRepositoryErrorCode,
} from '@javis-dog/projects';
import { ZodError } from 'zod';
import { getDb } from '@/lib/auth';
import { budgetDeps, budgetLimitSchema, canManageBudget } from '@/lib/budgets';
import { githubRepository } from '@/lib/github';
import { canManageProject } from '@/lib/permissions';
import { getViewer, isUuid } from '@/lib/viewer';

export interface CreateProjectState {
  errors?: Record<string, string>;
  createdId?: string;
}

// Project and token changes: workspace owners and admins only (S5a review L1, like budgets).
const NOT_ALLOWED_PROJECT = 'Only workspace owners and admins can create projects.';
const NOT_ALLOWED_TOKEN = 'Only workspace owners and admins can issue tokens.';

/** Token refusals; anything else (including another workspace's project) reads as not found. */
const TOKEN_ERRORS: Partial<Record<ProjectRepositoryErrorCode, string>> = {
  token_limit: `This project already has ${MAX_ACTIVE_TOKENS_PER_PROJECT} active tokens. Revoke one first.`,
  token_issue_limit: `This project has issued ${MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY} tokens in the last 24 hours. You can issue another once the oldest is a day old.`,
};

const formToInput = (form: FormData) => ({
  name: String(form.get('name') ?? ''),
  platforms: form.getAll('platforms').map(String),
  ...(form.get('description') ? { description: String(form.get('description')) } : {}),
  ...(form.get('repositoryUrl') ? { repositoryUrl: String(form.get('repositoryUrl')) } : {}),
});

export async function createProjectAction(
  _prev: CreateProjectState,
  form: FormData,
): Promise<CreateProjectState> {
  const viewer = await getViewer();
  if (!viewer) return { errors: { form: 'Your session ended. Sign in again to continue.' } };
  // Owners and admins only (S5a review L1); the role comes from the membership row.
  if (!canManageProject(viewer.role)) return { errors: { form: NOT_ALLOWED_PROJECT } };
  try {
    const project = await viewer.projects.createProject(viewer.workspaceId, formToInput(form));
    revalidatePath('/projects');
    return { createdId: project.id };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        errors: Object.fromEntries(
          error.issues.map((issue) => [String(issue.path[0] ?? 'form'), issue.message]),
        ),
      };
    }
    if (error instanceof ProjectRepositoryError && error.code === 'slug_taken') {
      return { errors: { name: 'This workspace already has a project with that name.' } };
    }
    if (error instanceof ProjectRepositoryError && error.code === 'project_limit') {
      return {
        errors: {
          form: `This workspace already has ${MAX_PROJECTS_PER_WORKSPACE} projects, the most it can hold for now.`,
        },
      };
    }
    throw error;
  }
}

export interface IssueTokenState {
  token?: string;
  error?: string;
}

export async function issueTokenAction(
  projectId: string,
  _prev: IssueTokenState,
  form: FormData,
): Promise<IssueTokenState> {
  const viewer = await getViewer();
  if (!viewer) return { error: 'Your session ended. Sign in again to continue.' };
  if (!canManageProject(viewer.role)) return { error: NOT_ALLOWED_TOKEN };
  if (!isUuid(projectId)) return { error: 'Project not found.' };
  try {
    const { token } = await viewer.projects.issueToken(
      viewer.workspaceId,
      projectId,
      String(form.get('name') ?? ''),
    );
    revalidatePath(`/projects/${projectId}`);
    // Returned once to this response only; never stored or logged.
    return { token };
  } catch (error) {
    if (error instanceof ProjectRepositoryError) {
      return { error: TOKEN_ERRORS[error.code] ?? 'Project not found.' };
    }
    throw error;
  }
}

/**
 * Revokes one token. A plain form action (no state): members, signed-out requests and malformed
 * ids write nothing, and the page never offers the control to members.
 */
export async function revokeTokenAction(projectId: string, form: FormData): Promise<void> {
  const viewer = await getViewer();
  const tokenId = form.get('tokenId');
  if (!viewer || !canManageProject(viewer.role) || !isUuid(tokenId) || !isUuid(projectId)) return;
  await viewer.projects.revokeToken(viewer.workspaceId, tokenId);
  revalidatePath(`/projects/${projectId}`);
}

// Budgets (ADR-0014). Only workspace owners and admins may set or clear one; members read
// only. The workspace comes from the viewer; the project id from the form is checked against
// it here and again by the JD-M12 repository. Nothing is written unless every check passes.

export interface BudgetActionState {
  errors?: { limitUsd?: string; form?: string };
  saved?: 'set' | 'cleared';
}

const SIGNED_OUT = 'Your session ended. Sign in again to continue.';
const NOT_ALLOWED = 'Only workspace owners and admins can change budgets.';
const NOT_FOUND = 'Project not found.';

const budgetFailure = (error: unknown): BudgetActionState => {
  if (error instanceof RangeError) return { errors: { limitUsd: 'This limit is out of range.' } };
  if ((error as { code?: unknown } | null)?.code === 'not_found')
    return { errors: { form: NOT_FOUND } };
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg: 'budget change failed',
      // The name only: driver messages can echo hosts or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );
  return { errors: { form: 'The budget could not be saved. Try again in a moment.' } };
};

/** The viewer, store and project id when the viewer may change this project's budget. */
const budgetScope = async (form: FormData) => {
  const viewer = await getViewer();
  if (!viewer) return { error: SIGNED_OUT } as const;
  if (!canManageBudget(viewer.role)) return { error: NOT_ALLOWED } as const;
  const projectId = form.get('projectId');
  if (!isUuid(projectId)) return { error: NOT_FOUND } as const;
  const db = budgetDeps.getDb();
  if (!db) return { error: 'Budgets need a database, and none is configured.' } as const;
  return { viewer, projectId, store: budgetDeps.repository(db) } as const;
};

const revalidateBudget = (projectId: string) => {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
};

/** Sets or replaces the project's monthly limit (form fields `projectId`, `limitUsd`). */
export async function setBudgetAction(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const scope = await budgetScope(form);
  if ('error' in scope) return { errors: { form: scope.error } };
  const parsed = budgetLimitSchema.safeParse(String(form.get('limitUsd') ?? ''));
  if (!parsed.success)
    return { errors: { limitUsd: parsed.error.issues[0]?.message ?? 'Check the limit.' } };
  const { viewer, projectId, store } = scope;
  try {
    if (!(await viewer.projects.getProject(viewer.workspaceId, projectId)))
      return { errors: { form: NOT_FOUND } };
    await store.setBudget(viewer.workspaceId, projectId, parsed.data, viewer.user.id);
  } catch (error) {
    return budgetFailure(error);
  }
  revalidateBudget(projectId);
  return { saved: 'set' };
}

/** Removes the project's monthly limit (form field `projectId`). */
export async function clearBudgetAction(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const scope = await budgetScope(form);
  if ('error' in scope) return { errors: { form: scope.error } };
  const { viewer, projectId, store } = scope;
  try {
    if (!(await viewer.projects.getProject(viewer.workspaceId, projectId)))
      return { errors: { form: NOT_FOUND } };
    await store.clearBudget(viewer.workspaceId, projectId);
  } catch (error) {
    return budgetFailure(error);
  }
  revalidateBudget(projectId);
  return { saved: 'cleared' };
}

// Privacy class (ADR-0018 §7). Owners and admins only (S5a role rule). The action receives the
// project id and the class, never a key: raising happens in the browser's key setup flow after
// the full recovery key was pasted back, and lowering after the warning was shown. One existing
// column; no migration. Arguments are never logged.
//
// Raising with a linked GitHub repository (ADR-0019 Changes "S5h"): L1 and L2 keep repository
// names away from Javi's Dog, but a linked repository's name (owner/repo) stays stored with the
// project. Raising L0 → L1/L2 or L1 → L2 while one is linked therefore needs an explicit
// confirmation, checked here like the link's own (ADR-0019 decision 4): without
// `{ confirmLinkedRepo: true }` the action answers `needsConfirm` with the name(s) and changes
// nothing. Lowering, keeping the class, or a project with no linked repository never asks. The
// names come from installations the viewer's workspace claimed, so another workspace's project
// reads as not found and its repository is never named.

export type PrivacyClassActionResult =
  | { privacyClass: 'L0' | 'L1' | 'L2' }
  /**
   * Nothing changed: the project has a linked repository; retry with the confirmation.
   * `repository` is the first name (owner/repo), `repositories` all of them in name order. It
   * carries an `error` text too (like the link action's `needsConfirm`), so a caller that does not
   * handle the confirmation shows why nothing changed instead of failing silently.
   */
  | { needsConfirm: true; repository: string; repositories: string[]; error: string }
  | { error: string };

export interface PrivacyClassOptions {
  /** The owner saw that the linked repository's name stays known and confirmed. Only `true` counts. */
  confirmLinkedRepo?: boolean;
}

const NOT_ALLOWED_PRIVACY = 'Only workspace owners and admins can change the privacy class.';
const PRIVACY_FAILED = 'The privacy class could not be changed. Try again in a moment.';
const CLASS_RANK: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2 };

/** The `error` text of a `needsConfirm` answer (the browser flow shows its own warning). */
const linkedRepoNotice = (names: string[], privacyClass: string) =>
  names.length === 1
    ? `This project is linked to GitHub repository ${names[0]}, and Javi’s Dog keeps knowing that name under ${privacyClass}. Confirm to turn on ${privacyClass}.`
    : `This project is linked to GitHub repositories ${names.join(', ')}, and Javi’s Dog keeps knowing those names under ${privacyClass}. Confirm to turn on ${privacyClass}.`;

/** Only a plain `{ confirmLinkedRepo: true }` confirms; anything else (a string, 1, a key) does not. */
const confirmsLinkedRepo = (options: unknown) =>
  typeof options === 'object' &&
  options !== null &&
  (options as { confirmLinkedRepo?: unknown }).confirmLinkedRepo === true;

/** Names (owner/repo) of repositories linked to the project in the viewer's workspace, sorted. */
const linkedRepositoryNames = async (workspaceId: string, projectId: string) => {
  const db = getDb();
  // Without a database there are no GitHub links (ADR-0019 §4 stores them in the database).
  if (!db) return [];
  const installations = await githubRepository(db).workspaceInstallations(workspaceId);
  return installations
    .flatMap((i) => i.repositories)
    .filter((r) => r.projectId === projectId)
    .map((r) => r.fullName)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

export async function changePrivacyClassAction(
  projectId: string,
  privacyClass: string,
  // A default keeps the two required arguments (project id, class); never a key.
  options: PrivacyClassOptions = {},
): Promise<PrivacyClassActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { error: SIGNED_OUT };
  if (!canManageProject(viewer.role)) return { error: NOT_ALLOWED_PRIVACY };
  if (!isUuid(projectId)) return { error: NOT_FOUND };
  const parsed = PrivacyClass.safeParse(privacyClass);
  if (!parsed.success) return { error: 'Choose L0, L1 or L2.' };
  if (parsed.data !== 'L0' && !confirmsLinkedRepo(options)) {
    let names: string[];
    try {
      names = await linkedRepositoryNames(viewer.workspaceId, projectId);
    } catch (error) {
      // Fail closed: never raise without the warning because the links could not be read.
      console.error(
        JSON.stringify({
          level: 'error',
          module: 'JD-APP',
          msg: 'linked repository read failed',
          // The name only: driver messages can echo hosts or credentials.
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      return { error: PRIVACY_FAILED };
    }
    if (names.length > 0) {
      const project = await viewer.projects.getProject(viewer.workspaceId, projectId);
      if (!project) return { error: NOT_FOUND };
      // An unknown stored class counts as the lowest, so raising from it asks.
      if (CLASS_RANK[parsed.data]! > (CLASS_RANK[project.privacyClass] ?? -1)) {
        return {
          needsConfirm: true,
          repository: names[0]!,
          repositories: names,
          error: linkedRepoNotice(names, parsed.data),
        };
      }
    }
  }
  const row = await viewer.projects.setPrivacyClass(viewer.workspaceId, projectId, parsed.data);
  if (!row) return { error: NOT_FOUND };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects');
  return { privacyClass: parsed.data };
}
