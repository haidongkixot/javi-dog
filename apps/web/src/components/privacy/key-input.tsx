'use client';

import type { KeyboardEvent, RefObject } from 'react';

/**
 * A recovery key field (ADR-0018 §1, review M6): masked, no spellcheck, autocomplete or
 * autocapitalize, no `name`, and never inside a form that posts. It is uncontrolled, so the key
 * is not copied into React state; callers read it from the ref and clear it.
 */
export function KeyInput({
  id,
  label,
  inputRef,
  onEnter,
  describedBy,
  invalid = false,
}: {
  id: string;
  label: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onEnter: () => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-bold text-ink">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type="password"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        placeholder="JDK1-…"
        onKeyDown={onKeyDown}
        aria-invalid={invalid}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className="w-full max-w-xl rounded-control border border-line bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-muted"
      />
    </div>
  );
}
