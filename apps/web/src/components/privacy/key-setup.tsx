'use client';

import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  deriveProjectKeys,
  encodeRecoveryKey,
  generateProjectSecret,
  parseRecoveryKey,
} from '@javis-dog/crypto';
import { changePrivacyClassAction } from '@/app/projects/actions';
import { clearChecked } from '@/lib/privacy/checked';
import {
  COLLECTOR_GUIDANCE,
  COPY_IS_NOT_SAVING,
  LOST_KEY_WARNING,
  PASTE_MISMATCH,
} from '@/lib/privacy/copy';
import { KeyInput } from './key-input';
import { useKeyStore } from './key-context';

type Raise = 'L1' | 'L2';
type Step =
  | { step: 'intro' }
  // Review L9: the key text is never React state; it lives only in the shown DOM node.
  | { step: 'show' }
  | { step: 'confirm' }
  | { step: 'saving' }
  // ADR-0019 Changes "S5h": the project has a linked GitHub repository; the server changed
  // nothing and waits for an explicit confirmation. The derived keys wait in a ref.
  | { step: 'linked'; repositories: string[]; pending: boolean }
  | { step: 'done'; kid: string; privacyClass: Raise; changed: boolean };

type DerivedKeys = Awaited<ReturnType<typeof deriveProjectKeys>>;

const CHANGE_FAILED = 'The privacy class could not be changed. Try again in a moment.';

/** "a/b", "a/b and c/d", "a/b, c/d and e/f". */
const namesText = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The linked-repository warning (ADR-0019 Changes "S5h", ADR-0018 §7): L1 and L2 keep repository
 * names away from Javi's Dog, but a linked repository's name stays stored with the project.
 */
const linkedRepoWarning = (names: string[], privacyClass: Raise) =>
  names.length === 1
    ? `This project is linked to GitHub repository ${names[0]}. Javi’s Dog will keep knowing that name, which ${privacyClass} otherwise hides. Unlink it on the project’s GitHub card if you want it hidden.`
    : `This project is linked to GitHub repositories ${namesText(names)}. Javi’s Dog will keep knowing those names, which ${privacyClass} otherwise hides. Unlink them on the project’s GitHub card if you want them hidden.`;

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

/**
 * Review L3: how long the download's blob URL stays valid. Revoking it at once can cancel a
 * download the browser has not started yet (a slow "Save as" dialog); 40 s covers that and still
 * drops the URL soon after.
 */
const DOWNLOAD_URL_LIFETIME_MS = 40_000;

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
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), DOWNLOAD_URL_LIFETIME_MS);
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
  // Shown after a cancelled linked-repository confirmation: what did (not) happen.
  const [notice, setNotice] = useState<string | null>(null);
  // The secret lives in a ref (never in rendered state) until the paste-back succeeds.
  const secret = useRef<Uint8Array | null>(null);
  // Keys derived from the confirmed secret while the linked-repository confirmation is open.
  const pendingKeys = useRef<DerivedKeys | null>(null);
  /** A confirmed retry threw: the server may or may not have changed the class. */
  const outcomeUnknown = useRef(false);
  const pasted = useRef<HTMLInputElement | null>(null);
  // Review L9: the node that shows the key. The text is written into it directly (never through
  // React state or props) and wiped when the node is hidden or unmounted.
  const keyNode = useRef<HTMLElement | null>(null);
  const attachKeyNode = useCallback((node: HTMLElement | null) => {
    if (keyNode.current && keyNode.current !== node) keyNode.current.textContent = '';
    keyNode.current = node;
  }, []);
  const shownKey = () => keyNode.current?.textContent ?? '';

  const discard = () => {
    secret.current?.fill(0);
    secret.current = null;
    pendingKeys.current = null;
    if (pasted.current) pasted.current.value = '';
  };

  /** The class is on (or unchanged for a rotation): load the key in this tab and say so. */
  const finish = (keys: DerivedKeys, changed: boolean) => {
    // Review L5: the "checked" flag described the old class; it is earned again under this one.
    if (changed) clearChecked(projectId);
    store?.add(projectId, keys.kid, keys.l2Key);
    discard();
    setState({ step: 'done', kid: keys.kid, privacyClass: target, changed });
  };

  const generate = async () => {
    discard();
    setError(null);
    setNotice(null);
    setCopied(false);
    const fresh = generateProjectSecret();
    secret.current = fresh;
    const text = await encodeRecoveryKey(fresh);
    // Render the (empty) node now, then put the text into it: React never holds the key.
    flushSync(() => setState({ step: 'show' }));
    if (keyNode.current) keyNode.current.textContent = text;
  };

  const hideKey = () => {
    if (keyNode.current) keyNode.current.textContent = '';
    setError(null);
    setState({ step: 'confirm' });
  };

  const confirm = async () => {
    const expected = secret.current;
    if (!expected || state.step !== 'confirm') return;
    setError(null);
    // Review L9: read the pasted key once and empty the field on every outcome.
    const typed = pasted.current?.value ?? '';
    if (pasted.current) pasted.current.value = '';
    const parsed = await parseRecoveryKey(typed);
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
        error: CHANGE_FAILED,
      }));
      if ('needsConfirm' in result) {
        // Nothing changed on the server: ask, and keep the derived keys until the answer.
        pendingKeys.current = keys;
        setState({ step: 'linked', repositories: result.repositories, pending: false });
        return;
      }
      if ('error' in result) {
        setState({ step: 'confirm' });
        setError(result.error);
        return;
      }
    }
    finish(keys, changed);
  };

  /** Retries with the explicit confirmation the server checks (ADR-0019 Changes "S5h"). */
  const confirmLinked = async () => {
    const keys = pendingKeys.current;
    if (!keys || state.step !== 'linked' || state.pending) return;
    setError(null);
    setState({ ...state, pending: true });
    const result = await changePrivacyClassAction(projectId, target, {
      confirmLinkedRepo: true,
    }).catch(() => {
      // The server may have changed the class before the answer was lost (S5h review L1).
      outcomeUnknown.current = true;
      return { error: CHANGE_FAILED };
    });
    if ('error' in result || !('privacyClass' in result)) {
      setState({ ...state, pending: false });
      setError('error' in result ? result.error : CHANGE_FAILED);
      return;
    }
    finish(keys, true);
  };

  /** Leaves the class as it was; the confirmed key is dropped, so a new one is needed. */
  const cancelLinked = () => {
    discard();
    setError(null);
    setState({ step: 'intro' });
    setNotice(
      outcomeUnknown.current
        ? `We could not confirm whether the class changed. Reload the page to see the project's class, and keep the recovery key you just saved until you have checked.`
        : `Nothing changed: this project stays on ${currentClass}. The recovery key you just saved will not be used.`,
    );
    outcomeUnknown.current = false;
  };

  return (
    <section aria-labelledby="key-setup-title" className="grid gap-3">
      <h3 id="key-setup-title" className="text-sm font-bold text-ink">
        {rotation ? 'Generate a new recovery key' : 'Turn on L1 or L2'}
      </h3>

      {state.step === 'intro' && notice ? (
        <p role="status" className="text-xs text-ink">
          {notice}
        </p>
      ) : null}

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
        <div
          data-key-panel=""
          className="grid gap-3 rounded-control border border-line bg-surface-subtle p-3"
        >
          <p className="text-xs font-bold text-ink">
            Your recovery key. It is shown once and never sent to Javi’s Dog.
          </p>
          {/* No children: `generate` writes the key text into this node (review L9). */}
          <code
            ref={attachKeyNode}
            data-recovery-key=""
            className="block font-mono text-sm tracking-wide break-all text-ink select-all"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonSecondary}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shownKey());
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
              onClick={() => downloadKey(shownKey(), slug)}
            >
              Download as a file
            </button>
            <button type="button" className={buttonPrimary} onClick={hideKey}>
              I saved it, hide the key
            </button>
          </div>
          <p className="text-xs text-muted">{COPY_IS_NOT_SAVING}</p>
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

      {state.step === 'linked' ? (
        <div
          role="group"
          aria-label="Linked GitHub repository"
          className="grid gap-3 rounded-control border border-line bg-warn-bg p-3"
        >
          <p id="key-setup-linked-warning" className="text-xs text-ink">
            {linkedRepoWarning(state.repositories, target)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              disabled={state.pending}
              aria-describedby="key-setup-linked-warning"
              onClick={() => void confirmLinked()}
            >
              {state.pending
                ? 'Turning on…'
                : `Turn on ${target} and keep the ${state.repositories.length === 1 ? 'link' : 'links'}`}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={state.pending}
              onClick={cancelLinked}
            >
              Cancel, stay on {currentClass}
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
