/**
 * Workspace roles that may change a project: create it, issue or revoke its ingest tokens and
 * set its budget (ADR-0006 roles, ADR-0014 budgets, S5a review L1). Members read only. The role
 * always comes from the viewer's membership row, never from request input.
 */
export const canManageProject = (role: string | null | undefined): boolean =>
  role === 'owner' || role === 'admin';
