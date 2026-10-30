// Environment hygiene for every child process javi starts (ADR-0018 §6, review M3).

/** The variable `javi init --privacy` may read the recovery key from. */
export const PRIVACY_KEY_ENV = 'JAVI_PRIVACY_KEY';

/**
 * A copy of `env` for a child process (detached flush, receiver, git, shell probes, OS proxy
 * probes): everything except `JAVI_PRIVACY_KEY`. Children never need the recovery key; the hook
 * reads it from the project's credentials file. Always pass the result as an explicit `env`,
 * never rely on inheritance.
 */
export const childEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy[PRIVACY_KEY_ENV];
  return copy;
};

/**
 * Reads `JAVI_PRIVACY_KEY` once and deletes it from `env` (and from `process.env`), so nothing
 * started later can inherit it. Returns the value, or undefined when it was not set.
 */
export const takePrivacyKeyEnv = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = env[PRIVACY_KEY_ENV];
  delete env[PRIVACY_KEY_ENV];
  delete process.env[PRIVACY_KEY_ENV];
  return value;
};
