'use client';

import { useActionState } from 'react';
import { platforms } from '@javis-dog/projects';
import { createProjectAction, type CreateProjectState } from '@/app/projects/actions';

const platformLabels: Record<(typeof platforms)[number], string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  cursor: 'Cursor',
  github: 'GitHub',
  'custom-jgr': 'Custom (JGR)',
};

const input =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted';

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="mt-1 text-xs text-danger">
      {message}
    </p>
  ) : null;
}

export function CreateProjectForm() {
  const [state, action, pending] = useActionState<CreateProjectState, FormData>(
    createProjectAction,
    {},
  );
  const e = state.errors ?? {};
  return (
    <form action={action} className="grid gap-4 px-5 pt-4 pb-5" noValidate>
      <div>
        <label htmlFor="project-name" className="text-xs font-bold text-ink">
          Project name
        </label>
        <input
          id="project-name"
          name="name"
          required
          maxLength={80}
          className={input}
          aria-invalid={Boolean(e.name)}
          aria-describedby={e.name ? 'project-name-error' : undefined}
        />
        <FieldError id="project-name-error" message={e.name} />
      </div>
      <fieldset aria-describedby={e.platforms ? 'platforms-error' : undefined}>
        <legend className="text-xs font-bold text-ink">Coding environments</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {platforms.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="platforms" value={p} />
              {platformLabels[p]}
            </label>
          ))}
        </div>
        <FieldError id="platforms-error" message={e.platforms} />
      </fieldset>
      <div>
        <label htmlFor="project-description" className="text-xs font-bold text-ink">
          Description <span className="font-normal text-muted">(optional)</span>
        </label>
        <input id="project-description" name="description" maxLength={280} className={input} />
        <FieldError id="project-description-error" message={e.description} />
      </div>
      <div>
        <label htmlFor="project-repo" className="text-xs font-bold text-ink">
          GitHub repository URL <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="project-repo"
          name="repositoryUrl"
          type="url"
          placeholder="https://github.com/owner/repo"
          className={input}
        />
        <FieldError id="project-repo-error" message={e.repositoryUrl} />
      </div>
      <p className="text-xs text-muted">
        Privacy class <strong className="text-ink">L0</strong> — operational metadata only. No
        prompts, code or secrets.
      </p>
      <FieldError id="form-error" message={e.form} />
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary disabled:opacity-60"
        >
          {pending ? 'Creating…' : 'Create project'}
        </button>
        {state.createdId ? (
          <p role="status" className="mt-2 text-xs text-ok">
            Project created.
          </p>
        ) : null}
      </div>
    </form>
  );
}
