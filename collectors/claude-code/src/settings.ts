import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ATTENTION_NOTIFICATIONS, HOOK_EVENTS } from './mapping.ts';
import { writeJsonPrivate } from './state.ts';

// Registers `javi hook` in a project's `.claude/settings.local.json` (personal, not committed).
// Merges with existing settings: other keys and other hooks are left untouched, and
// re-running `javi init` replaces only our own entries (ADR-0010).
//
// Exec form (`command` = node executable, `args` = argv): no shell on any platform, so Git
// Bash vs PowerShell quoting on Windows never matters (code.claude.com/docs/en/hooks).

/** Every hook we write carries this marker in its args, so uninstall finds exactly ours. */
export const HOOK_MARKER = 'javi-collector';

/** SessionEnd runs synchronously (async hooks can be cancelled at teardown); seconds. */
export const SESSION_END_TIMEOUT_S = 5;

type HookCommand = {
  type: string;
  command?: string;
  args?: unknown;
  [k: string]: unknown;
};
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export const settingsPath = (projectDir: string) =>
  join(projectDir, '.claude', 'settings.local.json');

/** The hook entry for one event. Recording is local; delivery runs in a detached process. */
export const hookEntry = (
  event: string,
  nodePath: string,
  cliPath: string,
  projectRef: string,
): HookGroup => {
  const hook: HookCommand = {
    type: 'command',
    command: nodePath,
    // --no-warnings: Node can print warnings at startup (for example with
    // NODE_USE_ENV_PROXY=1) before javi runs; a hook must stay silent.
    args: ['--no-warnings', cliPath, 'hook', '--project', projectRef, '--source', HOOK_MARKER],
    ...(event === 'SessionEnd' ? { timeout: SESSION_END_TIMEOUT_S } : { async: true }),
  };
  // Notification hooks only for "waiting for a human" types (fewer process starts).
  return event === 'Notification'
    ? { matcher: [...ATTENTION_NOTIFICATIONS].join('|'), hooks: [hook] }
    : { hooks: [hook] };
};

const ours = (h: HookCommand) =>
  (Array.isArray(h.args) && h.args.includes(HOOK_MARKER)) ||
  (typeof h.command === 'string' && h.command.includes(HOOK_MARKER));

const read = async (path: string): Promise<Settings> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Never overwrite a file we cannot parse: the user may have structure in it.
    throw new Error(`Cannot parse ${path}: fix or remove it, then re-run javi init.`, {
      cause: e,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object: fix it, then re-run javi init.`);
  }
  return parsed as Settings;
};

/** Removes our entries; drops groups and events that become empty. */
const withoutOurs = (settings: Settings): Settings => {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const rest = { ...settings };
  delete rest.hooks;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
};

export const installHooks = async (
  projectDir: string,
  nodePath: string,
  cliPath: string,
  projectRef: string,
) => {
  const path = settingsPath(projectDir);
  const settings = withoutOurs(await read(path));
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), hookEntry(event, nodePath, cliPath, projectRef)];
  }
  await mkdir(dirname(path), { recursive: true });
  await writeJsonPrivate(path, { ...settings, hooks });
  return path;
};

/**
 * True when the project's `.claude/settings.local.json` holds a javi hook for `projectRef`.
 * A missing or unreadable file counts as none.
 */
export const claudeHooksInstalled = async (
  projectDir: string,
  projectRef: string,
): Promise<boolean> => {
  const settings = await read(settingsPath(projectDir)).catch(() => ({}) as Settings);
  return Object.values(settings.hooks ?? {}).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((g) =>
        (Array.isArray(g?.hooks) ? g.hooks : []).some((h) => {
          if (!h || !ours(h) || !Array.isArray(h.args)) return false;
          const i = h.args.indexOf('--project');
          return i >= 0 && h.args[i + 1] === projectRef;
        }),
      ),
  );
};

export const uninstallHooks = async (projectDir: string) => {
  const path = settingsPath(projectDir);
  const settings = await read(path);
  if (!settings.hooks) return { path, removed: false };
  await writeJsonPrivate(path, withoutOurs(settings));
  return { path, removed: true };
};
