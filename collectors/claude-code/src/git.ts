import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

// Git checks shared by the self-report registration (JD-C01, ADR-0017 §5) and the Codex hooks
// installer: every answer is tracked, untracked or unknown, and unknown is never "untracked"
// (S5d code review M3, S5e F3).

export interface GitResult {
  /** Exit status; null when git could not start or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when git could not run (ENOENT: git missing; ETIMEDOUT: no answer in time). */
  error?: Error & { code?: string };
  signal?: string | null;
}

/** Runs `git <args>` (tests inject one, as `SystemProxyProbe` is injected). */
export type GitRunner = (args: string[]) => GitResult;

const GIT_TIMEOUT_MS = 5_000;

/**
 * The real runner: `spawnSync('git', args)` without a shell, a 5 s timeout and git's messages
 * in English (they are matched below). Output stays in memory.
 */
export const runGit: GitRunner = (args) => {
  const run = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: '' },
  });
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    ...(run.error && { error: run.error }),
    signal: run.signal,
  };
};

/** `tracked`, `untracked`, or `unknown`: git could not tell (missing, failed, killed). */
export type GitTracking = 'tracked' | 'untracked' | 'unknown';

/**
 * Does git track `file` (a path inside `projectDir`)? (Code review M3: a failure is never
 * "untracked".) First `git rev-parse --is-inside-work-tree`: outside any repository (exit 128
 * with "not a git repository") or not inside a work tree ("false") → `untracked`. Then `git
 * ls-files --error-unmatch -- <file>`: exit 0 → `tracked`, exit 1 → `untracked`. Anything else
 * (git missing, a timeout, a signal, exit 128 inside a work tree such as dubious ownership) →
 * `unknown`.
 */
export const gitTracking = (
  projectDir: string,
  file: string,
  git: GitRunner = runGit,
): GitTracking => {
  const inside = git(['-C', projectDir, 'rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.signal) return 'unknown';
  if (inside.status === 128 && /not a git repository/i.test(inside.stderr)) return 'untracked';
  if (inside.status !== 0) return 'unknown';
  const answer = inside.stdout.trim();
  if (answer === 'false') return 'untracked';
  if (answer !== 'true') return 'unknown';
  const listed = git([
    '-C',
    projectDir,
    'ls-files',
    '--error-unmatch',
    '--',
    relative(projectDir, file),
  ]);
  if (listed.error || listed.signal) return 'unknown';
  if (listed.status === 0) return 'tracked';
  if (listed.status === 1) return 'untracked';
  return 'unknown';
};
