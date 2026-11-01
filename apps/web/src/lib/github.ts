import type { Db } from '@javis-dog/event-store';
import {
  createGithubRepository,
  githubWebhookSecretsState,
  type WorkspaceInstallation,
} from '@javis-dog/github-bridge';
import { getDb } from './auth';
import { canManageProject } from './permissions';

// Server-only GitHub App helpers for JD-APP (ADR-0019 §4, §8; design review D0 H1, M4, M5).
// Env values are read here, on the server, and only booleans or derived state leave this module:
// the webhook secret's value never does, and the owner's GitHub id is used only for comparison.

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The webhook handler's own secret rule (JD-M10 `githubWebhookSecretsState`, review L-1): unset or
 * whitespace-only is absent; surrounding whitespace on either secret is a configuration error,
 * which the webhook answers with 503. Both read as "not set up".
 */
const webhookConfigured = (env: Env) =>
  githubWebhookSecretsState({
    current: env.GITHUB_APP_WEBHOOK_SECRET,
    previous: env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS,
  }) === 'configured';

/** GitHub numeric ids: digits only, positive, safe integers. Anything else is `null`. */
export const parseGithubId = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^[1-9]\d{0,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
};

/** GitHub App slugs: letters, digits and single hyphens (the install URL is built from it). */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i;

export interface GithubAppConfig {
  /**
   * `GITHUB_APP_WEBHOOK_SECRET` is set, so signed deliveries can be verified (ADR-0019 §3). With
   * only the previous secret the webhook answers 503 (QA G13), and so it does for a secret with
   * leading or trailing whitespace (review L-1): both count as not set up.
   */
  configured: boolean;
  /** `GITHUB_APP_SLUG` (public identifier), or `null` when unset or malformed. */
  slug: string | null;
  /** `GITHUB_APP_OWNER_ID`: the GitHub account id that owns the private app (D0 H1). */
  ownerAccountId: number | null;
}

export const githubAppConfig = (env: Env = process.env): GithubAppConfig => {
  const slug = env.GITHUB_APP_SLUG?.trim() ?? '';
  return {
    configured: webhookConfigured(env),
    slug: SLUG.test(slug) ? slug : null,
    ownerAccountId: parseGithubId(env.GITHUB_APP_OWNER_ID ?? ''),
  };
};

/** GitHub's install page for an app. */
export const githubInstallUrl = (slug: string) =>
  `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/**
 * The install link, only for the deployment's owner (D0 H1: a private app installs only on the
 * account that created it, so no link is shown that cannot work): the secret and slug are set and
 * the viewer's linked GitHub account id equals `GITHUB_APP_OWNER_ID`. Otherwise `null`.
 */
export const ownerInstallUrl = (
  config: GithubAppConfig,
  githubAccountId: number | null,
): string | null =>
  config.configured &&
  config.slug !== null &&
  config.ownerAccountId !== null &&
  githubAccountId === config.ownerAccountId
    ? githubInstallUrl(config.slug)
    : null;

/**
 * The GitHub account id linked to a user through Better Auth sign-in (`accounts`, provider
 * `github`), or `null` when the user never signed in with GitHub or unlinked it.
 */
export const viewerGithubAccountId = async (db: Db, userId: string): Promise<number | null> => {
  const row = await db.query.accounts.findFirst({
    columns: { accountId: true },
    where: (a, { and, eq }) => and(eq(a.userId, userId), eq(a.providerId, 'github')),
  });
  return row ? parseGithubId(row.accountId) : null;
};

/** The JD-M10 repository on the shared handle. */
export const githubRepository = (db: Db) => createGithubRepository(db);

/** A verified delivery older than this no longer counts as "Connected" (review M-2). */
export const GITHUB_STALE_AFTER_MS = 7 * 86_400_000;

/**
 * The honest status label (ADR-0019 §8, D0 M4, review M-2). "Connected" needs a verified delivery
 * from the last 7 days for an unsuspended installation this workspace claimed; nothing here ever
 * says "live" or "secure".
 */
export type GithubStatus =
  /** The webhook secret is not configured on this deployment. */
  | { kind: 'not_set_up' }
  /** Set up, but this workspace has no claim and the viewer is not the app's owner (D0 H1). */
  | { kind: 'owner_only' }
  /** Set up; no claim yet (owner) or a claim without a verified delivery. */
  | { kind: 'waiting'; claimed: boolean }
  /** Every installation this workspace claimed is suspended on GitHub. */
  | { kind: 'suspended' }
  /** The newest verified delivery (unsuspended installations), `at`, is from the last 7 days. */
  | { kind: 'connected'; at: Date }
  /** The newest verified delivery, `at`, is older than 7 days: never shown as connected. */
  | { kind: 'stale'; at: Date }
  /** Reading the installations failed. */
  | { kind: 'unavailable' };

export const githubStatus = (input: {
  configured: boolean;
  isAppOwner: boolean;
  installations: ReadonlyArray<
    Pick<WorkspaceInstallation, 'suspendedAt' | 'lastVerifiedDeliveryAt'>
  >;
  /** Server time for the 7-day rule; defaults to now. */
  now?: Date;
}): GithubStatus => {
  const { configured, isAppOwner, installations, now = new Date() } = input;
  if (!configured) return { kind: 'not_set_up' };
  if (installations.length === 0)
    return isAppOwner ? { kind: 'waiting', claimed: false } : { kind: 'owner_only' };
  // A suspended installation's deliveries are dropped, so its old evidence does not count.
  const active = installations.filter((i) => i.suspendedAt === null);
  if (active.length === 0) return { kind: 'suspended' };
  const newest = active
    .map((i) => i.lastVerifiedDeliveryAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (!newest) return { kind: 'waiting', claimed: true };
  return now.getTime() - newest.getTime() > GITHUB_STALE_AFTER_MS
    ? { kind: 'stale', at: newest }
    : { kind: 'connected', at: newest };
};

/**
 * The status for one project's card (review M-2): the workspace status, narrowed to the
 * installations holding a repository linked to that project. `'not_linked'` when the workspace has
 * verified deliveries but none can be for this project, so the card never claims it is connected.
 */
export const projectGithubStatus = (
  overview: Pick<GithubOverview, 'status' | 'installations' | 'isAppOwner' | 'checkedAt'>,
  projectId: string,
): GithubStatus | { kind: 'not_linked' } => {
  const { status } = overview;
  if (status.kind !== 'connected' && status.kind !== 'stale') return status;
  const linked = overview.installations.filter((i) =>
    i.repositories.some((r) => r.projectId === projectId),
  );
  if (linked.length === 0) return { kind: 'not_linked' };
  return githubStatus({
    configured: true,
    isAppOwner: overview.isAppOwner,
    installations: linked,
    now: overview.checkedAt,
  });
};

export interface GithubOverview {
  status: GithubStatus;
  /** Owner-only install link (see `ownerInstallUrl`). */
  installUrl: string | null;
  /** The viewer's linked GitHub account is the app owner's. */
  isAppOwner: boolean;
  signedIn: boolean;
  /** The viewer has a GitHub account linked (needed to claim; D0 M5 re-verification). */
  githubLinked: boolean;
  /** Owner or admin of the viewer's workspace (`canManageProject`). */
  canManage: boolean;
  /** Installations claimed by the viewer's workspace, with repository names (members only). */
  /**
   * The workspace's claimed installations. `reverifiable` is false when the viewer's linked GitHub
   * account is missing or is not the installation's account (D0 M5: the claim stays).
   */
  installations: Array<WorkspaceInstallation & { reverifiable: boolean }>;
  /** Unclaimed installations of the viewer's own GitHub account (owners and admins only). */
  claimable: Array<{ installationId: number; accountType: 'User' | 'Organization' }>;
  /** Server time the status was computed at (the 7-day rule). */
  checkedAt: Date;
}

const logFailure = (error: unknown) =>
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg: 'github status read failed',
      // The name only: driver messages can echo hosts or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );

/** The viewer fields this module needs (a `Viewer` from lib/viewer satisfies it). */
export interface GithubViewer {
  user: { id: string };
  workspaceId: string;
  role: string | null | undefined;
}

/**
 * Everything the GitHub surfaces show for a viewer. The workspace comes from the viewer (session +
 * membership), never from request input; repository names are read only for installations that
 * workspace claimed.
 */
export const loadGithubOverview = async (
  viewer: GithubViewer | null,
  env: Env = process.env,
  now: Date = new Date(),
): Promise<GithubOverview> => {
  const config = githubAppConfig(env);
  const canManage = canManageProject(viewer?.role);
  const base: GithubOverview = {
    status: githubStatus({ configured: config.configured, isAppOwner: false, installations: [] }),
    checkedAt: now,
    installUrl: null,
    isAppOwner: false,
    signedIn: viewer !== null,
    githubLinked: false,
    canManage: viewer !== null && canManage,
    installations: [],
    claimable: [],
  };
  const db = viewer ? getDb() : null;
  if (!viewer || !db) return base;
  try {
    const repo = githubRepository(db);
    const [githubAccountId, installations] = await Promise.all([
      viewerGithubAccountId(db, viewer.user.id),
      repo.workspaceInstallations(viewer.workspaceId),
    ]);
    const isAppOwner = githubAccountId !== null && githubAccountId === config.ownerAccountId;
    const claimable =
      canManage && githubAccountId !== null
        ? await repo.claimableInstallations(githubAccountId)
        : [];
    return {
      ...base,
      status: githubStatus({ configured: config.configured, isAppOwner, installations, now }),
      installUrl: ownerInstallUrl(config, githubAccountId),
      isAppOwner,
      githubLinked: githubAccountId !== null,
      installations: installations.map((i) => ({
        ...i,
        reverifiable: githubAccountId !== null && i.accountId === githubAccountId,
      })),
      claimable,
    };
  } catch (error) {
    logFailure(error);
    return { ...base, status: config.configured ? { kind: 'unavailable' } : base.status };
  }
};
