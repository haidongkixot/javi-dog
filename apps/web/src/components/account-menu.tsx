'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useKeyStore } from '@/components/privacy/key-context';
import { authClient } from '@/lib/auth-client';
import { forgetKeysOnSignOut } from '@/lib/privacy/browser';

export function AccountMenu() {
  const { data, isPending, error } = authClient.useSession();
  const router = useRouter();
  const { store } = useKeyStore();
  const signedIn = data != null;
  const userId = data?.user.id ?? null;

  // Review M2: privacy keys follow the session user. Signed in: bind the tab's keys to this user
  // (another user's remembered keys are deleted, never loaded). Checked and signed out: forget
  // every key. A pending or failed session check (offline) changes nothing.
  useEffect(() => {
    if (isPending || !store) return;
    if (signedIn) {
      if (userId) store.setUser(userId);
    } else if (!error) {
      void forgetKeysOnSignOut('session-ended', store);
    }
  }, [isPending, signedIn, userId, error, store]);

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
          // other tabs, before the session ends (the wait is bounded, review L6).
          await forgetKeysOnSignOut('sign-out', store);
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
