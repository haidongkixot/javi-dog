'use server';

import { revalidatePath } from 'next/cache';
import { ProjectRepositoryError } from '@javis-dog/projects';
import { ZodError } from 'zod';
import { budgetDeps, budgetLimitSchema, canManageBudget } from '@/lib/budgets';
import { getViewer, isUuid } from '@/lib/viewer';

export interface CreateProjectState {
  errors?: Record<string, string>;
  createdId?: string;
}

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
      return {
        error:
          error.code === 'token_limit'
            ? 'This project already has 5 active tokens. Revoke one first.'
            : 'Project not found.',
      };
    }
    throw error;
  }
}

export async function revokeTokenAction(projectId: string, form: FormData): Promise<void> {
  const viewer = await getViewer();
  const tokenId = form.get('tokenId');
  if (!viewer || !isUuid(tokenId) || !isUuid(projectId)) return;
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
