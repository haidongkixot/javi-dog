// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: { data: null as unknown, isPending: false } }));
const signInSocial = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => session.value,
    signIn: { social: signInSocial },
    signOut,
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }), usePathname: () => '/' }));

const { AccountMenu } = await import('@/components/account-menu');
const { SignInButtons } = await import('@/components/sign-in-buttons');
const { getAuth, resetAuthForTests, signInProviders } = await import('@/lib/auth');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetAuthForTests();
});

describe('AccountMenu', () => {
  beforeEach(() => {
    session.value = { data: null, isPending: false };
  });

  it('says it is checking while the session loads (no false signed-out state)', () => {
    session.value = { data: null, isPending: true };
    render(<AccountMenu />);
    expect(screen.getByText('Checking sign-in…')).toBeTruthy();
  });

  it('offers sign-in when signed out', () => {
    render(<AccountMenu />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });

  it('shows the user and signs out', async () => {
    session.value = { data: { user: { name: 'Ada', email: 'ada@example.com' } }, isPending: false };
    render(<AccountMenu />);
    expect(screen.getByText('Ada')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalled();
  });
});

describe('SignInButtons', () => {
  it('starts the provider flow with /projects as the return page', async () => {
    signInSocial.mockResolvedValue({ error: null });
    render(<SignInButtons providers={['github', 'google']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(signInSocial).toHaveBeenCalledWith({ provider: 'google', callbackURL: '/projects' });
  });

  it('explains a failed start instead of hanging', async () => {
    signInSocial.mockResolvedValue({ error: { message: 'boom' } });
    render(<SignInButtons providers={['github']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Sign-in didn’t start');
  });
});

describe('server auth configuration', () => {
  it('is disabled without DATABASE_URL, and /api/auth answers 503', async () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(getAuth()).toBeNull();
    expect(signInProviders()).toEqual([]);
    const route = await import('@/app/api/auth/[...all]/route');
    const res = await route.GET(new Request('http://localhost/api/auth/get-session'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_not_configured' });
  });

  it('is disabled when the secret is too short', () => {
    expect(
      getAuth({
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        BETTER_AUTH_SECRET: 'short',
        BETTER_AUTH_URL: 'http://localhost:3000',
      }),
    ).toBeNull();
  });

  it('offers exactly the providers that are fully configured', () => {
    const env = {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      BETTER_AUTH_SECRET: 'x'.repeat(44),
      BETTER_AUTH_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GITHUB_CLIENT_ID: 'id-only',
    };
    expect(signInProviders(env)).toEqual(['google']);
  });
});

describe('/sign-in error codes', () => {
  it.each([
    ['access_denied', 'Sign-in was cancelled at the provider. You can try again.'],
    ['state_mismatch', 'Sign-in didn’t finish (state_mismatch). Please try again.'],
    ['<b>x</b>', 'Sign-in didn’t finish (bxb). Please try again.'],
  ])('shows a readable message for %s', async (error, message) => {
    vi.stubEnv('DATABASE_URL', '');
    const { default: SignInPage } = await import('@/app/sign-in/page');
    render(await SignInPage({ searchParams: Promise.resolve({ error }) }));
    expect(screen.getByRole('alert').textContent).toBe(message);
  });
});
