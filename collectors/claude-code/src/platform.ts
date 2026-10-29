// Agent platforms `javi` collects from (ADR-0016 §1). Claude Code is the default, so every
// command without `--platform` behaves exactly as before.

export const PLATFORMS = ['claude-code', 'gemini-cli'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const DEFAULT_PLATFORM: Platform = 'claude-code';

/** Display names for CLI output. */
export const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  'claude-code': 'Claude Code',
  'gemini-cli': 'Gemini CLI',
};

export const isPlatform = (value: unknown): value is Platform =>
  typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/**
 * `--platform <name>` from argv: the default when absent, `null` when present but missing a
 * value or naming an unknown platform.
 */
export const platformFlag = (argv: readonly string[]): Platform | null => {
  const i = argv.indexOf('--platform');
  if (i < 0) return DEFAULT_PLATFORM;
  const value = argv[i + 1];
  return isPlatform(value) ? value : null;
};
