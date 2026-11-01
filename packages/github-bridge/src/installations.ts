import type {
  InstallationDelivery,
  InstallationRef,
  InstallationRepositoriesDelivery,
  RepoRef,
} from './classify.ts';

/**
 * What a signed `installation` / `installation_repositories` delivery changes (ADR-0019 §4,
 * D0 H3). Applied by `createGithubRepository().applyInstallationChange`.
 */
export type InstallationChange =
  | {
      op: 'upsert';
      installation: InstallationRef;
      /** `true` suspend, `false` unsuspend, `null` leave as is. */
      suspended: boolean | null;
      /** Inserted or refreshed (`full_name`); a repository that moved installation loses its link. */
      upsertRepositories: RepoRef[];
      /** Deleted only while they still belong to this installation. */
      removeRepositoryIds: number[];
    }
  /** The installation and (by cascade) its repository rows and links go. */
  | { op: 'delete'; installationId: number };

/** Derives the change from a classified installation delivery. Pure. */
export const installationChange = (
  c: InstallationDelivery | InstallationRepositoriesDelivery,
): InstallationChange => {
  if (c.kind === 'installation_repositories') {
    return {
      op: 'upsert',
      installation: c.installation,
      suspended: null,
      upsertRepositories: c.added,
      removeRepositoryIds: c.removed.map((r) => r.repoId),
    };
  }
  if (c.action === 'deleted')
    return { op: 'delete', installationId: c.installation.installationId };
  return {
    op: 'upsert',
    installation: c.installation,
    suspended: c.action === 'suspend' ? true : c.action === 'unsuspend' ? false : null,
    upsertRepositories: c.repositories,
    removeRepositoryIds: [],
  };
};
