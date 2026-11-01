// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubOverview, GithubStatus } from '@/lib/github';

// S5g — Integrations status labels and the owner-only install link (TEST_PLAN §S5g row
// "Integrations status"; ADR-0019 §8, design review D0 H1, M4, L2). Pure logic and component
// tests; no database (the PGlite paths are in github-claim-pages.test.tsx). Screenshot budget 0.

const state = vi.hoisted(() => ({ viewer: null as unknown }));
vi.mock('@/lib/auth', () => ({ getDb: () => null, getAuth: () => null }));
vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const lib = await import('@/lib/github');
const { GithubStatusLine, githubStatusLabel, OWNER_ONLY_TEXT } =
  await import('@/components/github/status');
const { GithubSetupCard, SELECT_REPOSITORIES_TEXT } =
  await import('@/components/github/setup-card');
const { GithubDirectoryStatus } = await import('@/components/github/directory-status');
const { default: IntegrationsPage } = await import('@/app/integrations/page');

const FAKE_SECRET = 'fake-webhook-secret-for-tests-only';

beforeEach(() => {
  state.viewer = null;
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', '');
  vi.stubEnv('GITHUB_APP_SLUG', '');
  vi.stubEnv('GITHUB_APP_OWNER_ID', '');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const AT = new Date('2026-10-30T08:15:00.000Z');
/** Server time for the status (the 7-day staleness rule, M-2). */
const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;
const inst = (over: { suspendedAt?: Date | null; lastVerifiedDeliveryAt?: Date | null } = {}) => ({
  suspendedAt: null,
  lastVerifiedDeliveryAt: null,
  ...over,
});

describe('githubStatus (label logic)', () => {
  it.each<[string, Parameters<typeof lib.githubStatus>[0], GithubStatus]>([
    [
      'no secret → not set up, whatever else is true',
      {
        configured: false,
        isAppOwner: true,
        installations: [inst({ lastVerifiedDeliveryAt: AT })],
      },
      { kind: 'not_set_up' },
    ],
    [
      'set up, no claim, not the owner → owner only',
      { configured: true, isAppOwner: false, installations: [] },
      { kind: 'owner_only' },
    ],
    [
      'set up, no claim, the owner → waiting (unclaimed)',
      { configured: true, isAppOwner: true, installations: [] },
      { kind: 'waiting', claimed: false },
    ],
    [
      'claimed, no verified delivery → waiting (claimed)',
      { configured: true, isAppOwner: false, installations: [inst()], now: NOW },
      { kind: 'waiting', claimed: true },
    ],
    [
      'claimed with a verified delivery → connected at that time',
      {
        configured: true,
        isAppOwner: false,
        installations: [inst({ lastVerifiedDeliveryAt: AT })],
        now: NOW,
      },
      { kind: 'connected', at: AT },
    ],
    [
      'the newest delivery across claimed installations wins',
      {
        configured: true,
        isAppOwner: false,
        installations: [
          inst({ lastVerifiedDeliveryAt: new Date('2026-10-01T00:00:00Z') }),
          inst({ lastVerifiedDeliveryAt: AT }),
          inst(),
        ],
        now: NOW,
      },
      { kind: 'connected', at: AT },
    ],
    [
      'a suspended installation’s delivery does not count: suspended with one + active without → waiting',
      {
        configured: true,
        isAppOwner: true,
        installations: [inst({ suspendedAt: AT, lastVerifiedDeliveryAt: AT }), inst()],
        now: NOW,
      },
      { kind: 'waiting', claimed: true },
    ],
    [
      'the newest delivery is taken over unsuspended installations only',
      {
        configured: true,
        isAppOwner: true,
        installations: [
          inst({ suspendedAt: AT, lastVerifiedDeliveryAt: AT }),
          inst({ lastVerifiedDeliveryAt: new Date(NOW.getTime() - 9 * DAY) }),
        ],
        now: NOW,
      },
      { kind: 'stale', at: new Date(NOW.getTime() - 9 * DAY) },
    ],
    [
      'a verified delivery 8 days old → stale, not connected',
      {
        configured: true,
        isAppOwner: false,
        installations: [inst({ lastVerifiedDeliveryAt: new Date(NOW.getTime() - 8 * DAY) })],
        now: NOW,
      },
      { kind: 'stale', at: new Date(NOW.getTime() - 8 * DAY) },
    ],
    [
      'exactly 7 days old is still connected (stale means older than 7 days)',
      {
        configured: true,
        isAppOwner: false,
        installations: [inst({ lastVerifiedDeliveryAt: new Date(NOW.getTime() - 7 * DAY) })],
        now: NOW,
      },
      { kind: 'connected', at: new Date(NOW.getTime() - 7 * DAY) },
    ],
    [
      'every claimed installation suspended → suspended',
      {
        configured: true,
        isAppOwner: true,
        installations: [inst({ suspendedAt: AT, lastVerifiedDeliveryAt: AT })],
      },
      { kind: 'suspended' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(lib.githubStatus(input)).toEqual(expected);
  });
});

describe('config and the owner-only install link (D0 H1)', () => {
  it('reads presence, slug and owner id; the secret value is not part of the config', () => {
    const config = lib.githubAppConfig({
      GITHUB_APP_WEBHOOK_SECRET: FAKE_SECRET,
      GITHUB_APP_SLUG: 'javis-dog-test-app',
      GITHUB_APP_OWNER_ID: '1001',
    });
    expect(config).toEqual({ configured: true, slug: 'javis-dog-test-app', ownerAccountId: 1001 });
    expect(JSON.stringify(config)).not.toContain(FAKE_SECRET);
  });

  it('only the previous secret counts as not set up (QA G13)', () => {
    expect(
      lib.githubAppConfig({ GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: FAKE_SECRET }).configured,
    ).toBe(false);
    expect(lib.githubAppConfig({ GITHUB_APP_WEBHOOK_SECRET: '   ' }).configured).toBe(false);
  });

  it('a secret with surrounding whitespace is not set up, as the webhook answers 503 (L-1)', () => {
    expect(lib.githubAppConfig({ GITHUB_APP_WEBHOOK_SECRET: 'abc\n' }).configured).toBe(false);
    expect(lib.githubAppConfig({ GITHUB_APP_WEBHOOK_SECRET: ` ${FAKE_SECRET}` }).configured).toBe(
      false,
    );
    expect(
      lib.githubAppConfig({
        GITHUB_APP_WEBHOOK_SECRET: FAKE_SECRET,
        GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: 'old\n',
      }).configured,
    ).toBe(false);
    // A whitespace-only previous secret is ignored, as the webhook ignores it.
    expect(
      lib.githubAppConfig({
        GITHUB_APP_WEBHOOK_SECRET: FAKE_SECRET,
        GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: '  ',
      }).configured,
    ).toBe(true);
  });

  it('“abc\\n” as the secret: the setup card says not set up', () => {
    const configured = lib.githubAppConfig({ GITHUB_APP_WEBHOOK_SECRET: 'abc\n' }).configured;
    const status = lib.githubStatus({ configured, isAppOwner: true, installations: [] });
    render(<GithubSetupCard overview={overview({ status })} backFromGithub={false} />);
    expect(document.body.textContent).toContain('GitHub: not set up');
  });

  it.each(['../evil', 'a b', 'x/y', '-lead', 'trail-', ''])(
    'a malformed slug %j is dropped',
    (slug) => {
      expect(lib.githubAppConfig({ GITHUB_APP_SLUG: slug }).slug).toBeNull();
    },
  );

  it.each(['', 'abc', '0', '-5', '1e3', '12.5', '99999999999999999999'])(
    'a malformed owner id %j is dropped',
    (id) => {
      expect(lib.githubAppConfig({ GITHUB_APP_OWNER_ID: id }).ownerAccountId).toBeNull();
    },
  );

  const full = { configured: true, slug: 'javis-dog-test-app', ownerAccountId: 1001 };
  it.each<[string, Parameters<typeof lib.ownerInstallUrl>[0], number | null, string | null]>([
    [
      'owner, fully set up',
      full,
      1001,
      'https://github.com/apps/javis-dog-test-app/installations/new',
    ],
    ['another GitHub account', full, 2002, null],
    ['no GitHub account', full, null, null],
    ['no secret', { ...full, configured: false }, 1001, null],
    ['no slug', { ...full, slug: null }, 1001, null],
    ['no owner id configured', { ...full, ownerAccountId: null }, 1001, null],
  ])('%s', (_name, config, githubId, expected) => {
    expect(lib.ownerInstallUrl(config, githubId)).toBe(expected);
  });
});

describe('status line copy (ADR-0019 §8, D0 M4)', () => {
  const all: GithubStatus[] = [
    { kind: 'not_set_up' },
    { kind: 'owner_only' },
    { kind: 'waiting', claimed: false },
    { kind: 'waiting', claimed: true },
    { kind: 'suspended' },
    { kind: 'connected', at: AT },
    { kind: 'stale', at: AT },
    { kind: 'unavailable' },
  ];

  it('not set up', () => {
    render(<GithubStatusLine status={{ kind: 'not_set_up' }} />);
    expect(screen.getByText('GitHub: not set up')).toBeTruthy();
  });

  it('waiting for the first delivery', () => {
    render(<GithubStatusLine status={{ kind: 'waiting', claimed: true }} />);
    expect(screen.getByText('Waiting for the first delivery')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Connected');
  });

  it('connected always carries the time of the last verified delivery', () => {
    render(<GithubStatusLine status={{ kind: 'connected', at: AT }} />);
    expect(screen.getByText('Connected')).toBeTruthy();
    const time = document.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(AT.toISOString());
    expect(time?.textContent).toContain('08:15 UTC');
    expect(document.body.textContent).toContain('Last verified delivery from GitHub');
  });

  it('stale: “No verified delivery since <UTC time>” in the warn tone, with a hint, never “Connected” (M-2)', () => {
    render(<GithubStatusLine status={{ kind: 'stale', at: AT }} />);
    const { label, tone, detail } = githubStatusLabel({ kind: 'stale', at: AT });
    expect(tone).toBe('warn');
    expect(label).toBe('No verified delivery since');
    expect(detail).toMatch(/webhook secret/);
    expect(detail).toMatch(/Recent Deliveries/);
    const pill = screen.getByText(/No verified delivery since/);
    const time = pill.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(AT.toISOString());
    expect(time?.textContent).toContain('08:15 UTC');
    expect(document.body.textContent).not.toMatch(/connected|\blive\b/i);
  });

  it('owner only names the scope plainly', () => {
    render(<GithubStatusLine status={{ kind: 'owner_only' }} />);
    expect(document.body.textContent).toContain(OWNER_ONLY_TEXT);
  });

  it.each(all)('never says live, secure or encrypted (%o)', (status) => {
    const { label, detail } = githubStatusLabel(status);
    expect(`${label} ${detail}`).not.toMatch(/\blive\b|\bsecure\b|encrypt/i);
    if (status.kind !== 'connected') expect(label).not.toMatch(/connected/i);
  });
});

const overview = (over: Partial<GithubOverview> = {}): GithubOverview => ({
  status: { kind: 'owner_only' },
  installUrl: null,
  isAppOwner: false,
  signedIn: true,
  githubLinked: true,
  canManage: true,
  installations: [],
  claimable: [],
  checkedAt: NOW,
  ...over,
});

describe('setup card', () => {
  it('the owner gets the install link and the “Only select repositories” advice (D0 L2)', () => {
    const url = 'https://github.com/apps/javis-dog-test-app/installations/new';
    render(
      <GithubSetupCard
        overview={overview({
          status: { kind: 'waiting', claimed: false },
          installUrl: url,
          isAppOwner: true,
        })}
        backFromGithub={false}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'Install the app on GitHub' }).getAttribute('href'),
    ).toBe(url);
    expect(document.body.textContent).toContain(SELECT_REPOSITORIES_TEXT);
  });

  it('anyone else gets the owner-only notice and no link', () => {
    render(<GithubSetupCard overview={overview()} backFromGithub={false} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).toContain(OWNER_ONLY_TEXT);
  });

  it('not set up: no link and no owner notice, only what is missing', () => {
    render(
      <GithubSetupCard overview={overview({ status: { kind: 'not_set_up' } })} backFromGithub />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).toContain('GitHub: not set up');
    expect(document.body.textContent).not.toContain('Back from GitHub');
  });
});

describe('/integrations GitHub row', () => {
  it.each<[string, Record<string, string>, string]>([
    ['no secret', {}, 'GitHub: not set up'],
    ['set up, signed out', { GITHUB_APP_WEBHOOK_SECRET: FAKE_SECRET }, 'Owner only'],
  ])('%s → %s', async (_name, env, label) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    render(await GithubDirectoryStatus());
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GitHub setup' }).getAttribute('href')).toBe(
      '/integrations/github',
    );
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
  });

  it('a failing viewer lookup shows "Status unavailable", not a crash', async () => {
    state.viewer = Promise.reject(new Error('db down'));
    render(await GithubDirectoryStatus());
    expect(screen.getByText('Status unavailable')).toBeTruthy();
  });

  it('the directory drops "Commits" and streams the status into the GitHub row', async () => {
    // The page keeps a synchronous shell (the existing page test renders it directly); the GitHub
    // status is an async server component inside Suspense. React's test renderer warns about it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      render(<IntegrationsPage />);
    });
    const directory = screen.getByRole('region', { name: 'Integration directory' });
    const row = within(directory).getByText('GitHub').closest('li')!;
    expect(row.textContent).toContain('Pull requests and CI for any tool');
    expect(directory.textContent).not.toMatch(/commits/i);
    expect(await within(row).findByText('GitHub: not set up')).toBeTruthy();
    expect(row.textContent).not.toContain('Planned');
  });
});
