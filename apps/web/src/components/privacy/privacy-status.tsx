'use client';

import { useEffect, useState } from 'react';
import { CHECKED_EVENT, markChecked, newestChecked } from '@/lib/privacy/checked';
import { LABEL_L2_NOT_CHECKED, labelL2Checked } from '@/lib/privacy/copy';
import { resolveIdentity, type L2EventRef } from '@/lib/privacy/identity';
import { useKeyStore } from './key-context';

/**
 * The L2 label (ADR-0018 §9): "not checked yet" until this browser decrypted an L2 event of the
 * project with the right AAD; then the scoped wording, naming the kid of the newest event it
 * decrypted (G14). The checked state is remembered per project and kid in localStorage.
 */
export function PrivacyStatus({
  projectId,
  identities,
}: {
  projectId: string;
  /** This project's L2 events (identity events, or the canary), each with its receive time. */
  identities: Array<L2EventRef & { at: string }>;
}) {
  const { store, version } = useKeyStore();
  // Server and first client render agree: "not checked yet" until the browser says otherwise.
  const [checked, setChecked] = useState<{ kid: string; at: string } | null>(null);

  useEffect(() => {
    const update = () => setChecked(newestChecked(projectId));
    update();
    window.addEventListener(CHECKED_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(CHECKED_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [projectId]);

  useEffect(() => {
    if (!store) return;
    let live = true;
    const keys = store.keysFor(projectId);
    if (keys.size === 0) return;
    for (const identity of identities) {
      void resolveIdentity(identity, keys).then((view) => {
        if (live && view.kind === 'names') markChecked(projectId, view.kid, identity.at);
      });
    }
    return () => {
      live = false;
    };
  }, [store, version, projectId, identities]);

  return (
    <p role="status" className="text-sm font-bold text-ink">
      {checked ? labelL2Checked(checked.kid) : LABEL_L2_NOT_CHECKED}
    </p>
  );
}
