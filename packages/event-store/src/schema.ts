// Composed schema for migrations and typed queries (ADR-0005). Each module owns its
// tables and exports them from its public index; add new modules here.
import { identityTables } from '@javis-dog/identity';
import { projectTables } from '@javis-dog/projects';

export const schema = { ...projectTables, ...identityTables };
export const { workspaces, projects, ingestTokens } = projectTables;
// drizzle-kit discovers tables from named exports only.
export const { users, sessions, accounts, verifications, workspaceMembers, invitations } =
  identityTables;
