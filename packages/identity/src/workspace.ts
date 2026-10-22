import { createProjectRepository, toSlug, type ProjectsDb } from '@javis-dog/projects';
import { and, asc, eq } from 'drizzle-orm';
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

/**
 * The workspace a request may act on (ADR-0006): the session's active workspace if the user
 * is a member of it, otherwise the user's first workspace. Never trust a workspace id from input.
 */
export const resolveWorkspace = async (
  db: ProjectsDb,
  userId: string,
  activeWorkspaceId: string | null | undefined,
) => {
  if (activeWorkspaceId) {
    const [member] = await db
      .select({ workspaceId: workspaceMembers.organizationId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.organizationId, activeWorkspaceId),
        ),
      );
    if (member) return { workspaceId: member.workspaceId, role: member.role as WorkspaceRole };
  }
  const workspaceId = await ensurePersonalWorkspace(db, userId);
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.organizationId, workspaceId)),
    );
  return { workspaceId, role: (member?.role ?? 'member') as WorkspaceRole };
};
