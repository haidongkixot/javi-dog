// Composed schema for migrations and typed queries (ADR-0005). Each module owns its
// tables and exports them from its public index; add new modules here.
import { projectTables } from '@javis-dog/projects';

export const schema = { ...projectTables };
export const { workspaces, projects, ingestTokens } = projectTables;
