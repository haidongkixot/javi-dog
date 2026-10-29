import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GEMINI_HOOK_EVENTS } from '@javis-dog/collector-adapters';
import { writeTarget } from './claude-env.ts';
import { HOOK_MARKER } from './settings.ts';
import { writeJsonPrivate } from './state.ts';

// Gemini CLI settings files (ADR-0016 §2–§3). Gemini reads `settings.json` from the project
// (`.gemini/settings.json`, trusted folders only) and the user (`~/.gemini/settings.json`), and
// strips comments before parsing. javi only edits files that are plain JSON objects: a file it
// cannot parse is never rewritten.
//
// Hooks are shell commands (`bash -c` on macOS/Linux, PowerShell on Windows; Gemini
// hookRunner.ts), so the command string quotes every path. It never holds the ingest token.

/** Gemini waits for synchronous hooks; this caps how long one javi hook may hold a turn (ms). */
export const GEMINI_HOOK_TIMEOUT_MS = 5_000;
const BACKUP_SUFFIX = '.javi-backup';

type JsonObject = Record<string, unknown>;
export const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `.gemini/settings.json` of a project. */
export const geminiProjectSettingsPath = (projectDir: string) =>
  join(projectDir, '.gemini', 'settings.json');

/** `~/.gemini/settings.json` for a home directory. */
export const geminiUserSettingsPath = (home: string) => join(home, '.gemini', 'settings.json');

/**
 * The home Gemini CLI resolves `~/.gemini` against: `GEMINI_CLI_HOME` when set (Gemini
 * `packages/core/src/utils/paths.ts`), else the OS home. Tests point `JAVI_GEMINI_HOME` at a
 * temp dir (like `JAVI_CLAUDE_HOME`), which wins over both.
 */
export const geminiHome = (env: NodeJS.ProcessEnv) =>
  env.JAVI_GEMINI_HOME?.trim() || env.GEMINI_CLI_HOME?.trim() || homedir();

export type LoadedSettings =
  | { kind: 'missing' }
  | { kind: 'unparsable' }
  | { kind: 'not_object' }
  | { kind: 'ok'; text: string; settings: JsonObject; mode: number };

/** Reads a settings file; never throws for content problems, only for I/O errors. */
export const loadSettings = async (path: string): Promise<LoadedSettings> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unparsable' };
  }
  if (!isPlainObject(parsed)) return { kind: 'not_object' };
  const mode = (await stat(path)).mode & 0o777;
  return { kind: 'ok', text, settings: parsed, mode };
};

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Serialization javi writes (and hashes): 2-space JSON plus a final newline. */
export const settingsText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Writes the settings atomically (temp file + rename) through a symlink, keeping the file's
 * mode (new files: `mode`). Returns the SHA-256 of the written text.
 */
export const writeSettingsFile = async (path: string, value: unknown, mode: number) => {
  await writeJsonPrivate(await writeTarget(path), value, mode);
  return sha256(settingsText(value));
};

/** `settings.json.javi-backup` next to a settings file. */
export const backupPath = (path: string) => `${path}${BACKUP_SUFFIX}`;

/**
 * `settings.json.javi-backup` once: the first backup is the user's original, never replaced.
 * `created` is false when an earlier backup was already there (and kept as it is).
 */
export const backupOnce = async (
  path: string,
  text: string,
): Promise<{ path: string; created: boolean }> => {
  const backup = backupPath(path);
  try {
    await writeFile(backup, text, { mode: 0o600, flag: 'wx' });
    return { path: backup, created: true };
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e;
    return { path: backup, created: false };
  }
};

// --- Project hooks (ADR-0016 §2) ---

/** Gemini expands these in a hook command, even inside quotes (hookRunner.ts expandCommand). */
const EXPANDED =
  /\$(?:GEMINI_PROJECT_DIR|GEMINI_CWD|GEMINI_PLANS_DIR|GEMINI_SESSION_ID|CLAUDE_PROJECT_DIR)/;

const posixQuote = (arg: string) =>
  /^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (arg: string) => `'${arg.replaceAll("'", "''")}'`;

/**
 * The shell command for one hook: `<node> <javi> hook --platform gemini-cli --project <ref>
 * --source javi-collector`. POSIX shells get single-quoted words; PowerShell (Windows) gets
 * the call operator and single-quoted strings. Throws for a path Gemini or a shell would
 * rewrite (`$GEMINI_…` placeholders, NUL, line breaks).
 */
export const geminiHookCommand = (
  nodePath: string,
  cliPath: string,
  projectRef: string,
  os: NodeJS.Platform = process.platform,
): string => {
  const words = [
    nodePath,
    cliPath,
    'hook',
    '--platform',
    'gemini-cli',
    '--project',
    projectRef,
    '--source',
    HOOK_MARKER,
  ];
  for (const word of words) {
    if (!word || EXPANDED.test(word) || /[\0\r\n]/.test(word)) {
      throw new Error(
        'javi cannot register Gemini CLI hooks from this location: its path contains characters Gemini would rewrite ($GEMINI_…, line breaks). Move javi or Node.js and re-run javi init.',
      );
    }
  }
  return os === 'win32'
    ? `& ${words.map(powershellQuote).join(' ')}`
    : words.map(posixQuote).join(' ');
};

type HookCommand = { type?: unknown; name?: unknown; command?: unknown; [k: string]: unknown };

/** The hook group for one event: no matcher (all tools, all notification types). */
export const geminiHookEntry = (command: string) => ({
  hooks: [{ name: HOOK_MARKER, type: 'command', command, timeout: GEMINI_HOOK_TIMEOUT_MS }],
});

const ours = (hook: unknown) =>
  isPlainObject(hook) &&
  ((hook as HookCommand).name === HOOK_MARKER ||
    (typeof (hook as HookCommand).command === 'string' &&
      ((hook as HookCommand).command as string).includes(HOOK_MARKER)));

/**
 * Removes javi's hooks. Everything javi did not write (other keys, other hooks, shapes it does
 * not understand) is kept as it is; only groups and events javi emptied are dropped.
 */
const withoutOurs = (hooks: JsonObject): { hooks: JsonObject; removed: number } => {
  const next: JsonObject = {};
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const remaining = group.hooks.filter((h) => !ours(h));
      removed += group.hooks.length - remaining.length;
      if (remaining.length === group.hooks.length) kept.push(group);
      else if (remaining.length) kept.push({ ...group, hooks: remaining });
    }
    if (kept.length || !groups.length) next[event] = kept;
  }
  return { hooks: next, removed };
};

const unreadable = (path: string, command: string) =>
  new Error(
    `Cannot read ${path} as a plain JSON object (javi does not edit files with comments or another shape): nothing was changed. Fix it, then re-run ${command}.`,
  );

export interface InstallGeminiResult {
  path: string;
  /** `settings.json.javi-backup` next to the file, or null when there was no file. */
  backup: string | null;
  /** The project settings carry their own `telemetry` block (it overrides the user's). */
  projectTelemetry: boolean;
}

/** Registers javi for every `GEMINI_HOOK_EVENTS` event; re-running replaces only ours. */
export const installGeminiHooks = async (
  projectDir: string,
  nodePath: string,
  cliPath: string,
  projectRef: string,
): Promise<InstallGeminiResult> => {
  const path = geminiProjectSettingsPath(projectDir);
  const command = geminiHookCommand(nodePath, cliPath, projectRef);
  const loaded = await loadSettings(path);
  if (loaded.kind === 'unparsable' || loaded.kind === 'not_object') {
    throw unreadable(path, 'javi init --platform gemini-cli');
  }
  const settings = loaded.kind === 'ok' ? loaded.settings : {};
  if (Object.hasOwn(settings, 'hooks') && !isPlainObject(settings.hooks)) {
    throw unreadable(path, 'javi init --platform gemini-cli');
  }
  const { hooks } = withoutOurs(isPlainObject(settings.hooks) ? settings.hooks : {});
  for (const event of GEMINI_HOOK_EVENTS) {
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing)) throw unreadable(path, 'javi init --platform gemini-cli');
    hooks[event] = [...(existing as unknown[]), geminiHookEntry(command)];
  }
  let backup: string | null = null;
  if (loaded.kind === 'ok') backup = (await backupOnce(path, loaded.text)).path;
  else await mkdir(dirname(path), { recursive: true });
  await writeSettingsFile(path, { ...settings, hooks }, loaded.kind === 'ok' ? loaded.mode : 0o644);
  return { path, backup, projectTelemetry: Object.hasOwn(settings, 'telemetry') };
};

/** Removes only javi's entries; `removed` is false when there were none (file unchanged). */
export const uninstallGeminiHooks = async (projectDir: string) => {
  const path = geminiProjectSettingsPath(projectDir);
  const loaded = await loadSettings(path);
  if (loaded.kind === 'missing') return { path, removed: false };
  if (loaded.kind !== 'ok') throw unreadable(path, 'javi uninstall --platform gemini-cli');
  if (!isPlainObject(loaded.settings.hooks)) return { path, removed: false };
  const { hooks, removed } = withoutOurs(loaded.settings.hooks);
  if (!removed) return { path, removed: false };
  const next = { ...loaded.settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  await writeSettingsFile(path, next, loaded.mode);
  return { path, removed: true };
};

/** True when a javi hook command names `--project <projectRef>` (POSIX or PowerShell form). */
const forProject = (hook: unknown, projectRef: string) => {
  const command = isPlainObject(hook) ? (hook as HookCommand).command : undefined;
  return (
    typeof command === 'string' &&
    (command.includes(` --project ${posixQuote(projectRef)} `) ||
      command.includes(` '--project' ${powershellQuote(projectRef)} `))
  );
};

/**
 * True when the project's `.gemini/settings.json` holds at least one javi hook (with
 * `projectRef`: one registered for that project).
 */
export const geminiHooksInstalled = async (
  projectDir: string,
  projectRef?: string,
): Promise<boolean> => {
  const loaded = await loadSettings(geminiProjectSettingsPath(projectDir)).catch(() => null);
  if (loaded?.kind !== 'ok' || !isPlainObject(loaded.settings.hooks)) return false;
  if (projectRef === undefined) return withoutOurs(loaded.settings.hooks).removed > 0;
  return Object.values(loaded.settings.hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isPlainObject(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some((h) => ours(h) && forProject(h, projectRef)),
      ),
  );
};
