'use server';

import { revalidatePath } from 'next/cache';
import { ProjectRepositoryError } from '@javis-dog/projects';
import { ZodError } from 'zod';
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
