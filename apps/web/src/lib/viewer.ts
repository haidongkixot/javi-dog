import { headers } from 'next/headers';
import { createProjectRepository } from '@javis-dog/projects';
import { resolveWorkspace } from '@javis-dog/identity';
import { getAuth, getDb } from './auth';

/**
 * The signed-in user and the workspace they may act on, or `null` when signed out.
 * The workspace comes from the session plus a membership check — never from request input.
 */
export const getViewer = async () => {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return null;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  const { workspaceId, role } = await resolveWorkspace(db, session.user.id, active);
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    workspaceId,
    role,
    projects: createProjectRepository(db),
  };
};

export type Viewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reject malformed ids before they reach Postgres (which would raise instead of returning nothing). */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
