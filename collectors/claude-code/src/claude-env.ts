// Opt-in edit of Claude Code's user settings `env` (`~/.claude/settings.json`) to export
// metrics to the local receiver (ADR-0011). Never takes over an existing telemetry setup.

/** Keys `javi usage on` writes; anything else starting with `OTEL_` counts as foreign. */
export const USAGE_ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
] as const;

export const DEFAULT_USAGE_PORT = 4319;

/** `~/.claude/settings.json` for a home directory. */
export const claudeUserSettingsPath = (home: string): string => {
  void home;
  throw new Error('not implemented (S3e U2)');
};

/** The env values for a port and local secret. */
export const usageEnv = (port: number, secret: string): Record<string, string> => {
  void port;
  void secret;
  throw new Error('not implemented (S3e U2)');
};

export type EnableResult =
  | { ok: true; path: string; backup: string | null; written: Record<string, string> }
  | { ok: false; reason: 'unparsable' | 'not_object' | 'conflict'; keys?: string[] };

/**
 * Backs the file up once (`settings.json.javi-backup`), then merges `usageEnv` into `env`.
 * Refuses, changing nothing, when the file cannot be parsed, is not an object, or when any
 * `CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_*` key is already set — in the file with a value
 * javi did not write (`previous`), or in `shellEnv`.
 */
export const enableUsageEnv = async (opts: {
  path: string;
  port: number;
  secret: string;
  shellEnv: NodeJS.ProcessEnv;
  previous?: Record<string, string>;
}): Promise<EnableResult> => {
  void opts;
  throw new Error('not implemented (S3e U2)');
};

/** Removes the keys in `written` whose value is unchanged; returns the removed keys. */
export const disableUsageEnv = async (opts: {
  path: string;
  written: Record<string, string>;
}): Promise<{ path: string; removed: string[] }> => {
  void opts;
  throw new Error('not implemented (S3e U2)');
};
