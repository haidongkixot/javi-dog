import { createProjectRepository, toSlug, type ProjectsDb } from '@javis-dog/projects';
import { asc, eq } from 'drizzle-orm';
import { users, workspaceMembers } from './db/tables.ts';

/** Role names of Better Auth's organization plugin, used as workspace roles (ADR-0006). */
export type WorkspaceRole = 'owner' | 'admin' | 'member';

const suffix = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0');

/** "Ada Lovelace" → "Ada's workspace"; falls back to "My workspace". */
export const personalWorkspaceName = (userName: string) => {
  const first = userName.trim().split(/\s+/)[0]?.slice(0, 40) ?? '';
  return first.length >= 1 ? `${first}'s workspace` : 'My workspace';
};

/**
 * Returns the user's first workspace, creating a personal one (role `owner`) when the user
 * has none. Called on every new session, so a failed first attempt heals on the next sign-in.
 */
export const ensurePersonalWorkspace = async (db: ProjectsDb, userId: string) => {
  const [existing] = await db
    .select({ workspaceId: workspaceMembers.organizationId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (existing) return existing.workspaceId;

  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const name = personalWorkspaceName(user?.name ?? '');
  const base = toSlug(user?.name ?? '').slice(0, 40) || 'workspace';
  const workspace = await createProjectRepository(db).createWorkspace({
    name,
    slug: `${base}-${suffix()}`,
  });
  await db.insert(workspaceMembers).values({
    organizationId: workspace.id,
    userId,
    role: 'owner' satisfies WorkspaceRole,
  });
  return workspace.id;
};
