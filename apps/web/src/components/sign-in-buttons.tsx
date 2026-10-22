'use client';

import { useState } from 'react';
import type { SocialProvider } from '@javis-dog/identity';
import { authClient } from '@/lib/auth-client';

const labels: Record<SocialProvider, string> = {
  github: 'Continue with GitHub',
  google: 'Continue with Google',
};

export function SignInButtons({ providers }: { providers: SocialProvider[] }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [failed, setFailed] = useState(false);

  const start = async (provider: SocialProvider) => {
    setPending(provider);
    setFailed(false);
    const { error } = await authClient.signIn.social({ provider, callbackURL: '/projects' });
    if (error) {
      setPending(null);
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => (
        <button
          key={provider}
          type="button"
          onClick={() => start(provider)}
          disabled={pending !== null}
          className="rounded-control border border-line bg-surface px-4 py-3 text-sm font-bold text-ink hover:bg-surface-subtle disabled:cursor-wait disabled:opacity-60"
        >
          {pending === provider ? 'Opening sign-in…' : labels[provider]}
        </button>
      ))}
      {failed && (
        <p role="alert" className="text-xs text-danger">
          Sign-in didn’t start. Check your connection and try again.
        </p>
      )}
    </div>
  );
}
