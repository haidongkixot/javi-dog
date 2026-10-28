// Composed schema for migrations and typed queries (ADR-0005). Each module owns its
// tables and exports them from its public index; add new modules here.
import { identityTables } from '@javis-dog/identity';
import { projectTables } from '@javis-dog/projects';
import { budgetTables } from '@javis-dog/resilience';
import { eventTables } from './events.ts';

export const schema = { ...projectTables, ...identityTables, ...eventTables, ...budgetTables };
export const { workspaces, projects, ingestTokens } = projectTables;
// drizzle-kit discovers tables from named exports only.
export const { users, sessions, accounts, verifications, workspaceMembers, invitations } =
  identityTables;
export const { events, ingestRateWindows } = eventTables;
export const { projectBudgets, budgetAlerts } = budgetTables;
