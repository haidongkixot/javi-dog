'use client';

import { useState } from 'react';
import { changePrivacyClassAction } from '@/app/projects/actions';
import { lowerWarning } from '@/lib/privacy/copy';

type Lower = 'L0' | 'L1';

const buttonDanger =
  'rounded-control border border-line px-4 py-2.5 text-xs font-bold text-danger disabled:opacity-60';

/**
 * Lowering the class (ADR-0018 §7, D0 H1): the warning is shown first, then one confirmation
 * calls the server action with the class only. Keys in the browser are kept: stored L2 events
 * stay readable with them.
 */
export function LowerClass({
  projectId,
  currentClass,
}: {
  projectId: string;
  currentClass: 'L1' | 'L2';
}) {
  const options: Lower[] = currentClass === 'L2' ? ['L1', 'L0'] : ['L0'];
  const [target, setTarget] = useState<Lower | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const lower = async (to: Lower) => {
    setPending(true);
    const res = await changePrivacyClassAction(projectId, to).catch(() => ({
      error: 'The privacy class could not be changed. Try again in a moment.',
    }));
    setPending(false);
    setResult(
      'error' in res
        ? { ok: false, text: res.error }
        : { ok: true, text: `Privacy class lowered to ${res.privacyClass}.` },
    );
    if (!('error' in res)) setTarget(null);
  };

  return (
    <section aria-labelledby="lower-class-title" className="grid gap-3">
      <h3 id="lower-class-title" className="text-sm font-bold text-ink">
        Lower the privacy class
      </h3>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={buttonDanger}
            aria-pressed={target === o}
            onClick={() => {
              setResult(null);
              setTarget(o);
            }}
          >
            Lower to {o}…
          </button>
        ))}
      </div>
      {target ? (
        <div role="group" aria-label={`Lower to ${target}`} className="grid gap-2">
          <ul className="grid list-disc gap-1 pl-5 text-xs text-ink">
            {lowerWarning(target).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonDanger}
              disabled={pending}
              onClick={() => void lower(target)}
            >
              {pending ? 'Lowering…' : `Lower to ${target} now`}
            </button>
            <button
              type="button"
              className="rounded-control border border-line px-4 py-2.5 text-xs font-bold text-ink"
              onClick={() => setTarget(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {result ? (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={`text-xs ${result.ok ? 'text-ok' : 'text-danger'}`}
        >
          {result.text}
        </p>
      ) : null}
    </section>
  );
}
