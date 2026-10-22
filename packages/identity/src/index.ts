// JD-M03 public contract. Import from '@javis-dog/identity' only (ADR-0001).
export {
  AuthConfigError,
  authLog,
  configuredProviders,
  createAuth,
  redact,
  type Auth,
  type AuthEnv,
  type OnUserCreated,
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
export {
  ensurePersonalWorkspace,
  personalWorkspaceName,
  resolveWorkspace,
  type WorkspaceRole,
} from './workspace.ts';
