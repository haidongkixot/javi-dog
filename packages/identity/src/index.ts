// JD-M03 public contract. Import from '@javis-dog/identity' only (ADR-0001).
export {
  AuthConfigError,
  configuredProviders,
  createAuth,
  type Auth,
  type AuthEnv,
  type SocialProvider,
} from './auth.ts';
export {
  accounts,
  identityTables,
  invitations,
  sessions,
  users,
  verifications,
  workspaceMembers,
} from './db/tables.ts';
export { ensurePersonalWorkspace, personalWorkspaceName, type WorkspaceRole } from './workspace.ts';
