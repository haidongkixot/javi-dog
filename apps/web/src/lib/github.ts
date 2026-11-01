import type { Db } from '@javis-dog/event-store';
import { createGithubRepository, type WorkspaceInstallation } from '@javis-dog/github-bridge';
import { getDb } from './auth';
import { canManageProject } from './permissions';

// Server-only GitHub App helpers for JD-APP (ADR-0019 §4, §8; design review D0 H1, M4, M5).
// Env values are read here, on the server, and only booleans or derived state leave this module:
// the webhook secret's value never does, and the owner's GitHub id is used only for comparison.

type Env = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined) => typeof value === 'string' && value.trim() !== '';

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
   * only the previous secret the webhook answers 503 (QA G13), so that counts as not set up.
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
    configured: present(env.GITHUB_APP_WEBHOOK_SECRET),
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

/**
 * The honest status label (ADR-0019 §8, D0 M4). "Connected" needs a recorded verified delivery
 * for an installation this workspace claimed; nothing here ever says "live" or "secure".
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
  /** A verified delivery was recorded; `at` is the newest one. */
  | { kind: 'connected'; at: Date }
  /** Reading the installations failed. */
  | { kind: 'unavailable' };

export const githubStatus = (input: {
  configured: boolean;
  isAppOwner: boolean;
  installations: ReadonlyArray<
    Pick<WorkspaceInstallation, 'suspendedAt' | 'lastVerifiedDeliveryAt'>
  >;
}): GithubStatus => {
  const { configured, isAppOwner, installations } = input;
  if (!configured) return { kind: 'not_set_up' };
  if (installations.length === 0)
    return isAppOwner ? { kind: 'waiting', claimed: false } : { kind: 'owner_only' };
  if (installations.every((i) => i.suspendedAt !== null)) return { kind: 'suspended' };
  const newest = installations
    .map((i) => i.lastVerifiedDeliveryAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return newest ? { kind: 'connected', at: newest } : { kind: 'waiting', claimed: true };
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
): Promise<GithubOverview> => {
  const config = githubAppConfig(env);
  const canManage = canManageProject(viewer?.role);
  const base: GithubOverview = {
    status: githubStatus({ configured: config.configured, isAppOwner: false, installations: [] }),
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
      status: githubStatus({ configured: config.configured, isAppOwner, installations }),
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
