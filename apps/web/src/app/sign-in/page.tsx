import type { Metadata } from 'next';
import { Card, PageHead } from '@javis-dog/ui/components';
import { SignInButtons } from '@/components/sign-in-buttons';
import { signInProviders } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default function SignInPage() {
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
