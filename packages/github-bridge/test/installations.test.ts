import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  installationChange,
  type InstallationDelivery,
  type InstallationRepositoriesDelivery,
} from '../src/index.ts';
import {
  ACCOUNT_ID,
  INSTALLATION_ID,
  installationPayload,
  installationRepositoriesPayload,
  REPO,
} from './fixtures.ts';

// TEST_PLAN §S5g row "Installations" (pure part; the SQL side lives in event-store/test).

const installation = {
  installationId: INSTALLATION_ID,
  accountId: ACCOUNT_ID,
  accountType: 'User',
};

const inst = (action: string, over = {}) =>
  classifyDelivery(installationPayload(action, over), 'installation') as InstallationDelivery;

describe('installationChange', () => {
  it('created → upsert the installation and its repositories', () => {
    expect(installationChange(inst('created'))).toEqual({
      op: 'upsert',
      installation,
      suspended: null,
      upsertRepositories: [{ repoId: REPO.id, fullName: REPO.full_name }],
      removeRepositoryIds: [],
    });
  });

  it('organization installations are kept (claims refuse them later)', () => {
    expect(installationChange(inst('created', { accountType: 'Organization' }))).toMatchObject({
      installation: { accountType: 'Organization' },
    });
  });

  it('deleted → delete', () => {
    expect(installationChange(inst('deleted'))).toEqual({
      op: 'delete',
      installationId: INSTALLATION_ID,
    });
  });

  it('suspend / unsuspend / new_permissions_accepted touch only the installation', () => {
    expect(installationChange(inst('suspend'))).toMatchObject({
      suspended: true,
      upsertRepositories: [],
    });
    expect(installationChange(inst('unsuspend'))).toMatchObject({
      suspended: false,
      upsertRepositories: [],
    });
    expect(installationChange(inst('new_permissions_accepted'))).toMatchObject({
      suspended: null,
      upsertRepositories: [],
    });
  });

  it('installation_repositories → upsert added, remove removed', () => {
    const c = classifyDelivery(
      installationRepositoriesPayload(
        'removed',
        [[1, 'a/b']],
        [
          [2, 'a/c'],
          [3, 'a/d'],
        ],
      ),
      'installation_repositories',
    ) as InstallationRepositoriesDelivery;
    expect(installationChange(c)).toEqual({
      op: 'upsert',
      installation,
      suspended: null,
      upsertRepositories: [{ repoId: 1, fullName: 'a/b' }],
      removeRepositoryIds: [2, 3],
    });
  });
});
