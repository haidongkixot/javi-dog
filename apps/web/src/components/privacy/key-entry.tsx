'use client';

import { useRef, useState } from 'react';
import { deriveProjectKeys, parseRecoveryKey } from '@javis-dog/crypto';
import { CLEARING_NOTE, SAFARI_NOTE, TAB_ONLY_CLEARING_NOTE } from '@/lib/privacy/copy';
import { REMEMBER_ON_DEVICE_ENABLED } from '@/lib/privacy/remember-gate';
import { KeyInput } from './key-input';
import { useKeyStore } from './key-context';

const button =
  'rounded-control border border-line px-3 py-2 text-xs font-bold text-ink disabled:opacity-60';

/**
 * Key entry for reading L2 names (ADR-0018 §8). The key is parsed and derived in this browser,
 * imported as non-extractable keys and kept in memory for this tab. Nothing is sent to the
 * server. "Remember on this device" (keys, never the key text, in IndexedDB, only when ticked)
 * is offered only once the ADR-0018 §11 gate is released (`remember-gate.ts`, review L1); until
 * then nothing here offers or mentions remembering.
 */
export function KeyEntry({
  projectId,
  slug,
  knownKids,
}: {
  projectId: string;
  slug: string;
  /** Key IDs on this project's recent L2 events (public), for a hint only. */
  knownKids: string[];
}) {
  const { store } = useKeyStore();
  const input = useRef<HTMLInputElement | null>(null);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = store?.list(projectId) ?? [];
  // The server has no store: it renders the gate's default, which the browser matches.
  const offered = store?.rememberOffered() ?? REMEMBER_ON_DEVICE_ENABLED;
  const canRemember = offered && (store?.canRemember() ?? false);

  const applyKey = async () => {
    if (!store || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const text = input.current?.value ?? '';
    if (input.current) input.current.value = '';
    try {
      const parsed = await parseRecoveryKey(text);
      if (!parsed.ok) {
        setError(parsed.message);
        return;
      }
      let keys;
      try {
        keys = await deriveProjectKeys(parsed.secret, slug);
      } finally {
        parsed.secret.fill(0);
      }
      store.add(projectId, keys.kid, keys.l2Key);
      const stored = remember && canRemember ? await store.remember(projectId, keys.kid) : false;
      const where = stored ? 'remembered on this device' : 'loaded in this tab';
      const seen = knownKids.includes(keys.kid)
        ? ''
        : ' No event of the last 24 h uses this key yet.';
      setNotice(`Key ${keys.kid} ${where}.${seen}`);
      if (remember && canRemember && !stored) {
        setError('This browser did not store the key. It stays in this tab only.');
      }
    } catch {
      setError('This key could not be used. Nothing was stored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="key-entry-title" className="grid gap-3">
      <h3 id="key-entry-title" className="text-sm font-bold text-ink">
        Read encrypted names in this browser
      </h3>
      <p id="key-entry-hint" className="text-xs text-muted">
        {offered
          ? 'Enter the project’s recovery key. It is checked and used here, in your browser, and kept in memory for this tab unless you choose to remember it.'
          : 'Enter the project’s recovery key. It is checked and used here, in your browser, and kept in memory for this tab only.'}
      </p>
      {/* Not a <form>: the key can never be posted. */}
      <KeyInput
        id="key-entry"
        label="Recovery key"
        inputRef={input}
        onEnter={() => void applyKey()}
        describedBy="key-entry-hint"
        invalid={error !== null}
      />
      {canRemember ? (
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember on this device
        </label>
      ) : offered ? (
        <p className="text-xs text-muted">
          This browser can’t remember keys; they stay in this tab.
        </p>
      ) : null}
      <div>
        <button type="button" className={button} disabled={busy} onClick={() => void applyKey()}>
          {busy ? 'Checking…' : 'Use key'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-ink">
          {notice}
        </p>
      ) : null}

      {loaded.length > 0 ? (
        <ul
          aria-label={offered ? 'Keys on this device' : 'Keys in this tab'}
          className="grid gap-2"
        >
          {loaded.map((k) => (
            <li key={k.kid} className="flex flex-wrap items-center gap-2 text-xs text-ink">
              <span>
                Key <code className="font-mono">{k.kid}</code> ·{' '}
                {k.remembered ? 'remembered on this device' : 'this tab only'}
              </span>
              {!k.remembered && canRemember ? (
                <button
                  type="button"
                  className={button}
                  onClick={async () => {
                    const ok = await store?.remember(projectId, k.kid);
                    if (!ok)
                      setError('This browser did not store the key. It stays in this tab only.');
                  }}
                >
                  Remember on this device
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {loaded.length > 0 ? (
        <div>
          <button
            type="button"
            className={button}
            onClick={async () => {
              await store?.forgetProject(projectId);
              setNotice(
                offered
                  ? 'Keys for this project are forgotten on this device.'
                  : 'Keys for this project are forgotten in this tab.',
              );
            }}
          >
            {offered ? 'Forget on this device' : 'Forget in this tab'}
          </button>
        </div>
      ) : null}
      <p className="text-xs text-muted">
        {offered ? `${CLEARING_NOTE} ${SAFARI_NOTE}` : TAB_ONLY_CLEARING_NOTE}
      </p>
    </section>
  );
}
