'use client';

import { useRef, useState } from 'react';
import {
  deriveProjectKeys,
  encodeRecoveryKey,
  generateProjectSecret,
  parseRecoveryKey,
} from '@javis-dog/crypto';
import { changePrivacyClassAction } from '@/app/projects/actions';
import { clearChecked } from '@/lib/privacy/checked';
import { COLLECTOR_GUIDANCE, LOST_KEY_WARNING, PASTE_MISMATCH } from '@/lib/privacy/copy';
import { KeyInput } from './key-input';
import { useKeyStore } from './key-context';

type Raise = 'L1' | 'L2';
type Step =
  | { step: 'intro' }
  | { step: 'show'; key: string }
  | { step: 'confirm' }
  | { step: 'saving' }
  | { step: 'done'; kid: string; privacyClass: Raise; changed: boolean };

const buttonPrimary =
  'rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary disabled:opacity-60';
const buttonSecondary =
  'rounded-control border border-line px-4 py-2.5 text-xs font-bold text-ink disabled:opacity-60';

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const CLASS_TEXT: Record<Raise, string> = {
  L2: 'L2: keyed hashes plus repo and branch names encrypted on your machine',
  L1: 'L1: keyed hashes of repo, branch and folder names only',
};

/** Offers a download of the key as a text file; no server round trip. */
const downloadKey = (key: string, slug: string) => {
  const text = `Javi's Dog recovery key for project ${slug}. Keep it private.\n${key}\n`;
  const a = document.createElement('a');
  const blobUrl =
    typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      : null;
  a.href = blobUrl ?? `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  a.download = `javis-dog-${slug}-recovery-key.txt`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
};

/**
 * Key setup (ADR-0018 §1, §7): generate in this browser → show the key once with copy and
 * download → hide it → the full key pasted back and checked here → only then the server action,
 * which receives the class and nothing else. With the class already at L2 it generates a new key
 * (rotation, §10) and changes nothing on the server.
 */
export function KeySetup({
  projectId,
  slug,
  currentClass,
}: {
  projectId: string;
  slug: string;
  currentClass: 'L0' | 'L1' | 'L2';
}) {
  const { store } = useKeyStore();
  const rotation = currentClass === 'L2';
  const targets: Raise[] = currentClass === 'L0' ? ['L2', 'L1'] : ['L2'];
  const [target, setTarget] = useState<Raise>('L2');
  const [state, setState] = useState<Step>({ step: 'intro' });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The secret lives in a ref (never in rendered state) until the paste-back succeeds.
  const secret = useRef<Uint8Array | null>(null);
  const pasted = useRef<HTMLInputElement | null>(null);

  const discard = () => {
    secret.current?.fill(0);
    secret.current = null;
    if (pasted.current) pasted.current.value = '';
  };

  const generate = async () => {
    discard();
    setError(null);
    setCopied(false);
    const fresh = generateProjectSecret();
    secret.current = fresh;
    setState({ step: 'show', key: await encodeRecoveryKey(fresh) });
  };

  const confirm = async () => {
    const expected = secret.current;
    if (!expected || state.step !== 'confirm') return;
    setError(null);
    const parsed = await parseRecoveryKey(pasted.current?.value ?? '');
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const matches = sameBytes(parsed.secret, expected);
    parsed.secret.fill(0);
    if (!matches) {
      setError(PASTE_MISMATCH);
      return;
    }
    setState({ step: 'saving' });
    let keys;
    try {
      keys = await deriveProjectKeys(expected, slug);
    } catch {
      setState({ step: 'confirm' });
      setError('This project’s slug cannot be used for a key. Nothing was changed.');
      return;
    }
    const changed = target !== currentClass;
    if (changed) {
      // The class only, never the key (ADR-0018 §1).
      const result = await changePrivacyClassAction(projectId, target).catch(() => ({
        error: 'The privacy class could not be changed. Try again in a moment.',
      }));
      if ('error' in result) {
        setState({ step: 'confirm' });
        setError(result.error);
        return;
      }
      // Review L5: the "checked" flag described the old class; it is earned again under this one.
      clearChecked(projectId);
    }
    store?.add(projectId, keys.kid, keys.l2Key);
    discard();
    setState({ step: 'done', kid: keys.kid, privacyClass: target, changed });
  };

  return (
    <section aria-labelledby="key-setup-title" className="grid gap-3">
      <h3 id="key-setup-title" className="text-sm font-bold text-ink">
        {rotation ? 'Generate a new recovery key' : 'Turn on L1 or L2'}
      </h3>

      {state.step === 'intro' ? (
        <>
          {rotation ? (
            <p className="text-xs text-muted">
              A new key gets a new key ID. Events sent with the old key stay readable only with the
              old key.
            </p>
          ) : (
            <fieldset className="grid gap-2">
              <legend className="text-xs font-bold text-ink">Privacy class</legend>
              {targets.map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs text-ink">
                  <input
                    type="radio"
                    name="privacy-target"
                    value={t}
                    checked={target === t}
                    onChange={() => setTarget(t)}
                  />
                  {CLASS_TEXT[t]}
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-xs font-bold text-ink">{LOST_KEY_WARNING}</p>
          <div>
            <button type="button" className={buttonPrimary} onClick={() => void generate()}>
              Generate recovery key
            </button>
          </div>
        </>
      ) : null}

      {state.step === 'show' ? (
        <div className="grid gap-3 rounded-control border border-line bg-surface-subtle p-3">
          <p className="text-xs font-bold text-ink">
            Your recovery key. It is shown once and never sent to Javi’s Dog.
          </p>
          <code
            data-recovery-key=""
            className="block font-mono text-sm tracking-wide break-all text-ink select-all"
          >
            {state.key}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonSecondary}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.key);
                  setCopied(true);
                } catch {
                  setError('Copying failed. Select the key and copy it, or download it.');
                }
              }}
            >
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => downloadKey(state.key, slug)}
            >
              Download as a file
            </button>
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                setError(null);
                setState({ step: 'confirm' });
              }}
            >
              I saved it, hide the key
            </button>
          </div>
        </div>
      ) : null}

      {state.step === 'confirm' || state.step === 'saving' ? (
        // Not a <form>: nothing here can post the key anywhere.
        <div className="grid gap-3">
          <p id="key-paste-hint" className="text-xs text-muted">
            Paste the full key you saved. It is checked here, in your browser.
          </p>
          <KeyInput
            id="key-paste-back"
            label="Recovery key"
            inputRef={pasted}
            onEnter={() => void confirm()}
            describedBy="key-paste-hint"
            invalid={error !== null}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              disabled={state.step === 'saving'}
              onClick={() => void confirm()}
            >
              {state.step === 'saving'
                ? 'Checking…'
                : rotation
                  ? 'Check key'
                  : `Check key and turn on ${target}`}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={state.step === 'saving'}
              onClick={() => {
                discard();
                setError(null);
                setState({ step: 'intro' });
              }}
            >
              Start over with a new key
            </button>
          </div>
        </div>
      ) : null}

      {state.step === 'done' ? (
        <div role="status" className="grid gap-2 rounded-control border border-line p-3">
          <p className="text-xs font-bold text-ink">
            {state.changed
              ? `${state.privacyClass} is on for this project.`
              : 'New recovery key confirmed.'}{' '}
            Key <code className="font-mono">{state.kid}</code> is loaded in this tab.
          </p>
          <p className="text-xs text-muted">{COLLECTOR_GUIDANCE}</p>
          <p className="font-mono text-xs text-ink">javi init --privacy {state.privacyClass}</p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
