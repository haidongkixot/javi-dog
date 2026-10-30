'use client';

import { useEffect, useState } from 'react';
import type { ThreadIdentity } from '@javis-dog/realtime';
import { LABEL_NO_KEY_PREFIX, LABEL_OTHER_KID, LABEL_UNVERIFIABLE } from '@/lib/privacy/copy';
import { markChecked } from '@/lib/privacy/checked';
import { initialIdentityView, resolveIdentity, type IdentityView } from '@/lib/privacy/identity';
import { useKeyStore } from './key-context';

/**
 * `repo · branch` of a thread, decrypted in this browser (ADR-0018 §8), or the label that says
 * why it is not shown. Names are rendered as text only, with bidi controls removed. Renders
 * nothing for a thread without encrypted names (L0, L1).
 */
export function ThreadIdentityLabel({
  projectId,
  identity,
  className = 'block truncate text-xs text-muted',
}: {
  projectId: string;
  identity: ThreadIdentity | null;
  className?: string;
}) {
  const { store, version } = useKeyStore();
  // The same first state on the server and in the browser: "Encrypted (key …)" or nothing.
  const [view, setView] = useState<IdentityView>(() => initialIdentityView(identity));

  useEffect(() => {
    let live = true;
    const keys = store?.keysFor(projectId) ?? new Map<string, CryptoKey>();
    void resolveIdentity(identity, keys).then((next) => {
      if (!live) return;
      setView(next);
      // ADR-0018 §9: an AAD-verified decryption in this browser flips the project label.
      if (next.kind === 'names' && identity) markChecked(projectId, next.kid, identity.at);
    });
    return () => {
      live = false;
    };
  }, [store, version, projectId, identity]);

  switch (view.kind) {
    case 'none':
      return null;
    case 'names': {
      const text = [view.repo, view.branch].filter(Boolean).join(' · ');
      return text ? (
        <span className={`${className} font-mono`} data-identity="names">
          {text}
        </span>
      ) : null;
    }
    case 'no-key':
      return (
        <span className={className} data-identity="no-key">
          {LABEL_NO_KEY_PREFIX}
          <code className="font-mono">{view.kid}</code>)
        </span>
      );
    case 'other-kid':
      return (
        <span className={className} data-identity="other-kid">
          {LABEL_OTHER_KID}
        </span>
      );
    case 'unverifiable':
      return (
        <span className={className} data-identity="unverifiable">
          {LABEL_UNVERIFIABLE}
        </span>
      );
  }
}
