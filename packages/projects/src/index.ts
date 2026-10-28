// JD-M04 public contract. Import from '@javis-dog/projects' only (ADR-0001).
export {
  normalizeProjectInput,
  normalizeWorkspaceInput,
  Platform,
  platforms,
  PrivacyClass,
  Project,
  ProjectInput,
  toSlug,
  WorkspaceInput,
} from './schema.ts';
export { ingestTokens, projects, projectTables, workspaces } from './db/tables.ts';
export {
  displayPrefix,
  generateIngestToken,
  hashIngestToken,
  INGEST_TOKEN_PREFIX,
  parseIngestToken,
} from './tokens.ts';
export {
  createProjectRepository,
  MAX_ACTIVE_TOKENS_PER_PROJECT,
  MAX_PROJECTS_PER_WORKSPACE,
  MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY,
  ProjectRepositoryError,
  type ProjectRepository,
  type ProjectRepositoryErrorCode,
  type ProjectsDb,
} from './repository.ts';
