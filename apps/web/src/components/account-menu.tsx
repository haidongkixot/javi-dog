'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { forgetKeysOnSignOut } from '@/lib/privacy/browser';

export function AccountMenu() {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();

  if (isPending) {
    return <p className="text-xs text-muted">Checking sign-in…</p>;
  }
  if (!data) {
    return (
      <Link
        href="/sign-in"
        className="rounded-control bg-primary px-3 py-2 text-xs font-bold text-on-primary"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-muted">
        Signed in as{' '}
        <strong className="font-bold text-ink">{data.user.name || data.user.email}</strong>
      </span>
      <button
        type="button"
        onClick={async () => {
          // ADR-0018 §8: signing out forgets every privacy key here, on this device and in
          // other tabs, before the session ends.
          await forgetKeysOnSignOut('sign-out');
          await authClient.signOut();
          router.refresh();
        }}
        className="rounded-control border border-line px-3 py-2 font-bold text-ink hover:bg-surface-subtle"
      >
        Sign out
      </button>
    </div>
  );
}
