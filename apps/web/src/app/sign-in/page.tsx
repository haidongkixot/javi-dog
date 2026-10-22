import type { Metadata } from 'next';
import { Card, PageHead } from '@javis-dog/ui/components';
import { SignInButtons } from '@/components/sign-in-buttons';
import { signInProviders } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

// Better Auth sends failed OAuth callbacks here with `?error=<code>` (S2c).
const errorText = (code: string) =>
  code === 'access_denied'
    ? 'Sign-in was cancelled at the provider. You can try again.'
    : `Sign-in didn’t finish (${code.slice(0, 60)}). Please try again.`;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const code = typeof error === 'string' ? error.replace(/[^\w.-]/g, '') : '';
  const providers = signInProviders();
  return (
    <>
      <PageHead
        eyebrow="Account"
        title="Sign in to Javi's Dog."
        description="Your first sign-in creates a personal workspace for your projects."
      />
      <Card labelledBy="sign-in-title">
        <div className="mx-auto flex max-w-sm flex-col gap-4 py-4">
          <h2 id="sign-in-title" className="text-lg font-bold tracking-tight text-ink">
            Choose an account
          </h2>
          {code ? (
            <p role="alert" className="text-sm text-danger">
              {errorText(code)}
            </p>
          ) : null}
          {providers.length > 0 ? (
            <SignInButtons providers={providers} />
          ) : (
            <p role="status" className="text-sm text-muted">
              Sign-in is not configured on this deployment yet.
            </p>
          )}
          <p className="text-xs text-muted">
            We read only your name, email address and avatar from the provider. No code, prompts or
            repository contents.
          </p>
        </div>
      </Card>
    </>
  );
}
