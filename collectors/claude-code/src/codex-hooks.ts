import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { CODEX_HOOK_EVENTS } from '@javis-dog/collector-adapters';
import { parse as parseToml } from 'smol-toml';
import { childEnv } from './child-env.ts';
import { writeTarget } from './claude-env.ts';
import { gitTracking, runGit, type GitRunner, type GitTracking } from './git.ts';
import { isPlainObject } from './gemini-settings.ts';
import { jsonEqual } from './gemini-telemetry.ts';
import { HOOK_MARKER } from './settings.ts';
import { writeTextAtomic } from './state.ts';

// Codex CLI project hooks (ADR-0016 Changes "S5c design" C1 and "S5c design review" H4, H5, M3,
// Low). Codex runs a hook command in a shell and trusts each handler by its **position**
// (`<hooks.json path>:<event>:<group index>:<handler index>`) plus a hash of the handler. So
// javi only ever appends its own groups to `.codex/hooks.json`, keeps the user's groups where
// they are (and their text as it is wherever possible), and calls one stable, unversioned
// launcher (`~/.javi/bin/javi-hook`) so a javi upgrade never changes the hook command.

/** Codex hook timeouts are in seconds; SessionEnd (and Interrupt) are capped at 3 by Codex. */
export const CODEX_HOOK_TIMEOUT_S = 5;
export const CODEX_SESSION_END_TIMEOUT_S = 3;

/** Launcher paths go into hook commands unquoted (H4): only these characters are allowed. */
const SAFE_POSIX_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_WINDOWS_PATH = /^[A-Za-z0-9._/\\:-]+$/;

export const codexHooksPath = (projectDir: string) => join(projectDir, '.codex', 'hooks.json');
export const codexProjectConfigPath = (projectDir: string) =>
  join(projectDir, '.codex', 'config.toml');

/** `<JAVI_HOME>/bin/javi-hook` and `javi-hook.cmd` (on Windows with Windows separators). */
export const codexLauncherPaths = (home: string, os: NodeJS.Platform = process.platform) => {
  const join2 = os === 'win32' ? win32.join : join;
  return { posix: join2(home, 'bin', 'javi-hook'), windows: join2(home, 'bin', 'javi-hook.cmd') };
};

const posixQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher scripts for a node executable and javi entry point (H4): they pin `JAVI_HOME` to
 * the folder they live in, so hooks find the same state whatever Codex's environment holds.
 * Throws for paths a script cannot carry (line breaks, NUL; `"` in the Windows script).
 */
export const codexLauncherScripts = (nodePath: string, cliPath: string, home: string) => {
  for (const word of [nodePath, cliPath, home]) {
    if (!word || /[\0\r\n]/.test(word)) {
      throw new Error(
        'javi cannot write its Codex hook launcher: the path of Node.js, javi or JAVI_HOME contains a line break. Move it and re-run javi init.',
      );
    }
  }
  const header = 'Written by javi init --platform codex-cli; Codex hooks run this file.';
  const posix = [
    '#!/bin/sh',
    `# ${header}`,
    `JAVI_HOME=${posixQuote(home)}`,
    'export JAVI_HOME',
    `exec ${posixQuote(nodePath)} --no-warnings ${posixQuote(cliPath)} hook "$@"`,
    '',
  ].join('\n');
  const windowsWords = [nodePath, cliPath, home];
  let windows: string | null = null;
  if (!windowsWords.some((w) => w.includes('"'))) {
    // `%` is doubled: a batch file would otherwise expand it.
    const esc = (w: string) => w.replaceAll('%', '%%');
    windows = [
      '@echo off',
      `rem ${header}`,
      'setlocal',
      `set "JAVI_HOME=${esc(home)}"`,
      `"${esc(nodePath)}" --no-warnings "${esc(cliPath)}" hook %*`,
      '',
    ].join('\r\n');
  }
  return { posix, windows };
};

/** Why a launcher path cannot go into a hook command unquoted, or null when it can. */
export const unsafeLauncherPath = (path: string, os: NodeJS.Platform = process.platform) =>
  (os === 'win32' ? SAFE_WINDOWS_PATH : SAFE_POSIX_PATH).test(path) ? null : path;

/**
 * Writes `javi-hook` (0755) and `javi-hook.cmd` atomically. Refuses (throws, writing nothing)
 * when a launcher path holds spaces or shell metacharacters (H4), naming the path.
 */
export const installCodexLauncher = async (
  home: string,
  nodePath: string,
  cliPath: string,
  os: NodeJS.Platform = process.platform,
) => {
  const paths = codexLauncherPaths(home, os);
  const bad =
    os === 'win32'
      ? unsafeLauncherPath(paths.windows, 'win32')
      : unsafeLauncherPath(paths.posix, os);
  if (bad) {
    throw new Error(
      `javi cannot register Codex CLI hooks: the launcher path ${bad} has spaces or shell metacharacters, and Codex runs hook commands in a shell. Set JAVI_HOME to a folder whose path has only letters, digits and . _ - /, then re-run javi init. Nothing was changed.`,
    );
  }
  const scripts = codexLauncherScripts(nodePath, cliPath, home);
  if (scripts.windows === null && os === 'win32') {
    throw new Error(
      'javi cannot write its Codex hook launcher: the path of Node.js or javi contains a double quote. Nothing was changed.',
    );
  }
  await mkdir(join(home, 'bin'), { recursive: true, mode: 0o700 });
  await chmod(join(home, 'bin'), 0o700).catch(() => {});
  await writeTextAtomic(paths.posix, scripts.posix, 0o755);
  await chmod(paths.posix, 0o755);
  // On macOS/Linux the .cmd twin is never run; it is only skipped for a path with `"`.
  if (scripts.windows !== null) await writeTextAtomic(paths.windows, scripts.windows, 0o755);
  return paths;
};

/** `--platform codex-cli --project <slug> --source javi-collector` after the launcher. */
export const codexHookArgs = (projectRef: string) =>
  `--platform codex-cli --project ${projectRef} --source ${HOOK_MARKER}`;

/** One javi group for an event (C1): unquoted launcher calls, timeout in seconds. */
export const codexHookGroup = (
  event: string,
  launchers: { posix: string; windows: string },
  projectRef: string,
) => ({
  hooks: [
    {
      type: 'command',
      command: `${launchers.posix} ${codexHookArgs(projectRef)}`,
      commandWindows: `${launchers.windows} ${codexHookArgs(projectRef)}`,
      timeout: event === 'SessionEnd' ? CODEX_SESSION_END_TIMEOUT_S : CODEX_HOOK_TIMEOUT_S,
    },
  ],
});

const ourHook = (hook: unknown) =>
  isPlainObject(hook) &&
  typeof hook.command === 'string' &&
  hook.command.includes(`--source ${HOOK_MARKER}`);

/** A group javi wrote: every handler in it is javi's (a user's mixed group is never ours). */
export const isCodexJaviGroup = (group: unknown) =>
  isPlainObject(group) &&
  Array.isArray(group.hooks) &&
  group.hooks.length > 0 &&
  group.hooks.every(ourHook);

// --- A JSON text with positions, for edits that keep the user's bytes ---

export type JsonNode =
  | { kind: 'object'; start: number; end: number; members: JsonMember[] }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'scalar'; start: number; end: number };
export interface JsonMember {
  key: string;
  start: number;
  end: number;
  value: JsonNode;
}

/** Spans of a text that `JSON.parse` accepted. */
export const spans = (text: string): JsonNode => {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i += 1;
  };
  const string = () => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return { start, end: i };
  };
  const value = (): JsonNode => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i += 1;
      const members: JsonMember[] = [];
      ws();
      if (text[i] === '}') {
        i += 1;
        return { kind: 'object', start, end: i, members };
      }
      for (;;) {
        ws();
        const k = string();
        ws();
        i += 1; // :
        const v = value();
        members.push({
          key: JSON.parse(text.slice(k.start, k.end)) as string,
          start: k.start,
          end: v.end,
          value: v,
        });
        ws();
        if (text[i] === ',') i += 1;
        else {
          i += 1; // }
          return { kind: 'object', start, end: i, members };
        }
      }
    }
    if (c === '[') {
      i += 1;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return { kind: 'array', start, end: i, items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') i += 1;
        else {
          i += 1; // ]
          return { kind: 'array', start, end: i, items };
        }
      }
    }
    if (c === '"') return { kind: 'scalar', ...string() };
    while (i < text.length && !' \t\n\r,]}'.includes(text[i]!)) i += 1;
    return { kind: 'scalar', start, end: i };
  };
  return value();
};

/** Leading whitespace of the line holding `pos`, when `pos` is the line's first token. */
export const tokenIndent = (text: string, pos: number): string | null => {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lead = text.slice(lineStart, pos);
  return /^[ \t]*$/.test(lead) ? lead : null;
};
export const lineIndent = (text: string, pos: number) => {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
};
const reindent = (json: string, indent: string) => json.split('\n').join(`\n${indent}`);
/** Pretty JSON indented to `indent`; `null`: compact, for a container written on one line. */
export const pretty = (value: unknown, indent: string | null) =>
  indent === null ? JSON.stringify(value) : reindent(JSON.stringify(value, null, 2), indent);

export type Splice = { from: number; to: number; text: string };
export const applySplice = (text: string, s: Splice) =>
  text.slice(0, s.from) + s.text + text.slice(s.to);

/** Removes element `i` of a container's elements (array items or object members). */
export const removeAt = (
  container: { start: number; end: number },
  elems: Array<{ start: number; end: number }>,
  i: number,
): Splice => {
  if (elems.length === 1) return { from: container.start + 1, to: container.end - 1, text: '' };
  if (i < elems.length - 1) return { from: elems[i]!.start, to: elems[i + 1]!.start, text: '' };
  return { from: elems[i - 1]!.end, to: elems[i]!.end, text: '' };
};

/** Appends `json(indent)` as the last element of a container. */
export const appendTo = (
  text: string,
  container: { start: number; end: number },
  elems: Array<{ start: number; end: number }>,
  json: (indent: string | null) => string,
): Splice => {
  const last = elems[elems.length - 1];
  if (last) {
    const indent = tokenIndent(text, last.start);
    return indent === null
      ? { from: last.end, to: last.end, text: `, ${json(null)}` }
      : { from: last.end, to: last.end, text: `,\n${indent}${json(indent)}` };
  }
  const base = lineIndent(text, container.start);
  const inner = `${base}  `;
  return {
    from: container.start + 1,
    to: container.end - 1,
    text: `\n${inner}${json(inner)}\n${base}`,
  };
};

/**
 * The next text edit that brings `text` closer to `target` (a JSON object with the same
 * members, javi's groups changed), or null when none is left. Works on objects/arrays only.
 */
const nextEdit = (text: string, target: Record<string, unknown>): Splice | null => {
  const root = spans(text);
  if (root.kind !== 'object') return null;
  const current = JSON.parse(text) as Record<string, unknown>;
  const hooksTarget = target.hooks as Record<string, unknown[]> | undefined;
  const hooksMember = root.members.find((m) => m.key === 'hooks');
  if (!hooksTarget) {
    if (!hooksMember) return null;
    return removeAt(root, root.members, root.members.indexOf(hooksMember));
  }
  if (!hooksMember) {
    return appendTo(text, root, root.members, (ind) => `"hooks": ${pretty(hooksTarget, ind)}`);
  }
  const hooksNode = hooksMember.value;
  if (hooksNode.kind !== 'object') return null;
  const hooksCurrent = current.hooks as Record<string, unknown>;
  // Events javi emptied are removed; events javi needs are added at the end.
  for (const [mi, member] of hooksNode.members.entries()) {
    if (!Object.hasOwn(hooksTarget, member.key)) return removeAt(hooksNode, hooksNode.members, mi);
  }
  for (const [event, groups] of Object.entries(hooksTarget)) {
    const member = hooksNode.members.find((m) => m.key === event);
    if (!member) {
      return appendTo(
        text,
        hooksNode,
        hooksNode.members,
        (ind) => `${JSON.stringify(event)}: ${pretty(groups, ind)}`,
      );
    }
    const array = member.value;
    const now = hooksCurrent[event] as unknown[];
    if (array.kind !== 'array' || jsonEqual(now, groups)) continue;
    // Same length: replace the first differing group in place. Longer: remove the first group
    // that is not in the target at its position. Shorter: append the missing tail.
    if (now.length === groups.length) {
      const i = now.findIndex((g, k) => !jsonEqual(g, groups[k]));
      const item = array.items[i]!;
      return {
        from: item.start,
        to: item.end,
        text: pretty(groups[i], lineIndent(text, item.start)),
      };
    }
    if (now.length > groups.length) {
      // Only javi's groups are ever removed: the one whose removal lines up most groups.
      let best = -1;
      let bestScore = -1;
      now.forEach((g, i) => {
        if (!isCodexJaviGroup(g)) return;
        const rest = now.filter((_, k) => k !== i);
        const score = rest.filter((r, k) => jsonEqual(r, groups[k])).length;
        if (score >= bestScore) [best, bestScore] = [i, score];
      });
      if (best < 0) return null;
      return removeAt(array, array.items, best);
    }
    return appendTo(text, array, array.items, (ind) => pretty(groups[now.length], ind));
  }
  return null;
};

/** `text` edited towards `target`, or the plain serialization when an edit would not get there. */
const editedText = (text: string, target: Record<string, unknown>): string => {
  let next = text;
  for (let round = 0; round < 200; round++) {
    const edit = nextEdit(next, target);
    if (!edit) break;
    next = applySplice(next, edit);
  }
  try {
    if (jsonEqual(JSON.parse(next), target)) return next;
  } catch {
    // fall through to the plain serialization
  }
  return `${JSON.stringify(target, null, 2)}\n`;
};

type Loaded =
  | { kind: 'missing' }
  | { kind: 'ok'; text: string; file: Record<string, unknown>; hooks: Record<string, unknown[]> };

const unreadable = (path: string, command: string) =>
  new Error(
    `Cannot read ${path} as Codex hooks (a JSON object whose "hooks" maps events to lists): nothing was changed. Fix it, then re-run ${command}.`,
  );

const load = async (path: string, command: string): Promise<Loaded> => {
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
    throw unreadable(path, command);
  }
  if (!isPlainObject(parsed)) throw unreadable(path, command);
  if (Object.hasOwn(parsed, 'hooks') && !isPlainObject(parsed.hooks)) {
    throw unreadable(path, command);
  }
  const hooks = (isPlainObject(parsed.hooks) ? parsed.hooks : {}) as Record<string, unknown[]>;
  if (Object.values(hooks).some((groups) => !Array.isArray(groups))) {
    throw unreadable(path, command);
  }
  return { kind: 'ok', text, file: parsed, hooks };
};

/** User groups that move up because javi's groups before them were removed (M3). */
export interface CodexShift {
  event: string;
  /** How many of the user's groups in that event change position. */
  groups: number;
}

/** User groups after each removed index in `groups` (the ones whose position changes). */
const shiftsOf = (groups: unknown[], removed: number[]) => {
  if (!removed.length) return 0;
  const first = Math.min(...removed);
  return groups.filter((g, i) => i > first && !removed.includes(i) && !isCodexJaviGroup(g)).length;
};

/**
 * What `.codex/hooks.json` was before javi's first init (S5c code review L5), kept in javi's
 * state so uninstall restores the user's file instead of guessing: `created` (javi created the
 * file), the hook `events` the user's file already had (also empty ones) and whether it had a
 * `hooks` key at all. Event names only, never commands.
 */
export interface CodexHooksOrigin {
  created: boolean;
  events: string[];
  hooksKey: boolean;
}

const isOrigin = (value: unknown): value is CodexHooksOrigin =>
  isPlainObject(value) &&
  typeof value.created === 'boolean' &&
  typeof value.hooksKey === 'boolean' &&
  Array.isArray(value.events) &&
  value.events.every((e) => typeof e === 'string');

export interface InstallCodexResult {
  path: string;
  /** The file before javi's first init (to save in javi's state for uninstall). */
  origin: CodexHooksOrigin;
  /** Events where javi's group was appended (new), kept as it was, or updated in place. */
  appended: string[];
  kept: string[];
  updated: string[];
  /** User groups that shift because duplicate javi groups were removed (normally none). */
  shifts: CodexShift[];
}

/**
 * Appends one javi group per `CODEX_HOOK_EVENTS` event to `.codex/hooks.json` (created when
 * missing). A javi group already there stays at its position (updated in place when its
 * command changed); the user's groups keep their order and, wherever possible, their text.
 * A file that does not parse is refused untouched (throws). Never writes trust state.
 */
export const installCodexHooks = async (
  projectDir: string,
  launchers: { posix: string; windows: string },
  projectRef: string,
  /** The origin saved at an earlier init, if any: kept while javi's groups are in the file. */
  previous?: CodexHooksOrigin | null,
): Promise<InstallCodexResult> => {
  const path = codexHooksPath(projectDir);
  const loaded = await load(path, 'javi init --platform codex-cli');
  const hooks: Record<string, unknown[]> = loaded.kind === 'ok' ? { ...loaded.hooks } : {};
  const javiThere = Object.values(hooks).some((groups) => groups.some(isCodexJaviGroup));
  let origin: CodexHooksOrigin;
  if (loaded.kind === 'missing') origin = { created: true, events: [], hooksKey: false };
  else if (!javiThere) {
    origin = {
      created: false,
      events: Object.keys(loaded.hooks),
      hooksKey: Object.hasOwn(loaded.file, 'hooks'),
    };
  } else if (isOrigin(previous)) origin = previous;
  else {
    // javi's groups are there but the record is lost: the safe guess (never deleted later).
    origin = {
      created: false,
      events: Object.keys(hooks).filter((e) => hooks[e]!.some((g) => !isCodexJaviGroup(g))),
      hooksKey: true,
    };
  }
  const result: InstallCodexResult = {
    path,
    origin,
    appended: [],
    kept: [],
    updated: [],
    shifts: [],
  };
  for (const event of CODEX_HOOK_EVENTS) {
    const desired = codexHookGroup(event, launchers, projectRef);
    const groups = [...(hooks[event] ?? [])];
    const ours = groups.flatMap((g, i) => (isCodexJaviGroup(g) ? [i] : []));
    if (!ours.length) {
      groups.push(desired);
      result.appended.push(event);
    } else {
      const [first, ...extra] = ours;
      if (jsonEqual(groups[first!], desired)) result.kept.push(event);
      else result.updated.push(event);
      const shifted = shiftsOf(groups, extra);
      if (shifted) result.shifts.push({ event, groups: shifted });
      groups[first!] = desired;
      for (const i of extra.reverse()) groups.splice(i, 1);
    }
    hooks[event] = groups;
  }
  if (loaded.kind === 'missing') {
    await mkdir(join(projectDir, '.codex'), { recursive: true });
    await writeTextAtomic(path, `${JSON.stringify({ hooks }, null, 2)}\n`, 0o644);
    return result;
  }
  const target = { ...loaded.file, hooks };
  if (jsonEqual(loaded.file, target)) return result;
  const next = editedText(loaded.text, target);
  await writeTextAtomic(await writeTarget(path), next, (await stat(path)).mode & 0o777);
  return result;
};

export interface UninstallCodexResult {
  path: string;
  removed: number;
  /** User groups whose position changed, by event: Codex asks to review them again (M3). */
  shifts: CodexShift[];
  /** The file held nothing but javi's groups, so it was removed. */
  deleted: boolean;
}

/**
 * Removes only javi's groups; reports which of the user's groups change position. With the
 * `origin` saved at init, the user's file comes back as it was (empty events and the `hooks`
 * key included) and the file is deleted only when javi created it and nothing else is left.
 * Without one, the file is never deleted (S5c code review L5).
 */
export const uninstallCodexHooks = async (
  projectDir: string,
  origin?: CodexHooksOrigin | null,
): Promise<UninstallCodexResult> => {
  const known = isOrigin(origin) ? origin : null;
  const path = codexHooksPath(projectDir);
  const loaded = await load(path, 'javi uninstall --platform codex-cli');
  const result: UninstallCodexResult = { path, removed: 0, shifts: [], deleted: false };
  if (loaded.kind === 'missing') return result;
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(loaded.hooks)) {
    const ours = groups.flatMap((g, i) => (isCodexJaviGroup(g) ? [i] : []));
    result.removed += ours.length;
    const shifted = shiftsOf(groups, ours);
    if (shifted) result.shifts.push({ event, groups: shifted });
    const kept = groups.filter((g) => !isCodexJaviGroup(g));
    // An event javi emptied goes, unless the user's file had it; one the user left empty stays.
    if (kept.length || !ours.length || known?.events.includes(event)) hooks[event] = kept;
  }
  if (!result.removed) return result;
  const target: Record<string, unknown> = { ...loaded.file, hooks };
  if (!Object.keys(hooks).length && known && !known.hooksKey) delete target.hooks;
  if (known?.created && !Object.keys(target).length) {
    await rm(await writeTarget(path), { force: true });
    return { ...result, deleted: true };
  }
  const next = editedText(loaded.text, target);
  await writeTextAtomic(await writeTarget(path), next, (await stat(path)).mode & 0o777);
  return result;
};

/** javi's groups in `.codex/hooks.json` (for `projectRef`, when given) with their positions. */
export const codexJaviGroups = async (
  projectDir: string,
  projectRef?: string,
): Promise<Array<{ event: string; index: number }>> => {
  const loaded = await load(codexHooksPath(projectDir), 'javi status').catch(() => null);
  if (loaded?.kind !== 'ok') return [];
  const found: Array<{ event: string; index: number }> = [];
  for (const [event, groups] of Object.entries(loaded.hooks)) {
    groups.forEach((group, index) => {
      if (!isCodexJaviGroup(group)) return;
      const hooks = (group as { hooks: Array<{ command: string }> }).hooks;
      if (
        projectRef === undefined ||
        hooks.some((h) => h.command.endsWith(` --project ${projectRef} --source ${HOOK_MARKER}`))
      ) {
        found.push({ event, index });
      }
    });
  }
  return found;
};

export const codexHooksInstalled = async (projectDir: string, projectRef?: string) =>
  (await codexJaviGroups(projectDir, projectRef)).length > 0;

// --- Warnings at init (H5, Low) ---

/** True when git tracks the project's `.codex/hooks.json` (it holds the launcher path). */
/**
 * Does git track the project's `.codex/hooks.json`? `unknown` when git cannot tell (missing,
 * failed, dubious ownership): never read as "untracked" (S5e F3, like S5d code review M3).
 */
export const codexHooksTracking = (projectDir: string, git: GitRunner = runGit): GitTracking =>
  gitTracking(projectDir, codexHooksPath(projectDir), git);

/** True unless git says `.codex/hooks.json` is untracked (fails closed). */
export const codexHooksTracked = (projectDir: string, git: GitRunner = runGit) =>
  codexHooksTracking(projectDir, git) !== 'untracked';

/** True when the project's `.codex/config.toml` has a `[hooks]` table (Codex then warns). */
export const codexProjectConfigHasHooks = async (projectDir: string) => {
  const text = await readFile(codexProjectConfigPath(projectDir), 'utf8').catch(() => null);
  if (text === null) return false;
  try {
    return Object.hasOwn(parseToml(text), 'hooks');
  } catch {
    return /^\s*(?:\[\s*\[?\s*"?hooks"?\s*[\].]|"?hooks"?\s*[.=])/m.test(text);
  }
};

/**
 * POSIX only (H5): runs `$SHELL -c true` and `$SHELL -lc true` (2 s each) the way Codex starts
 * hook shells, and reports which of them printed anything or did not finish. Output is never
 * kept or shown.
 */
export const probeShellOutput = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  os: NodeJS.Platform = process.platform,
): Array<{ command: string; problem: 'stdout' | 'stderr' | 'timeout' }> => {
  if (os === 'win32') return [];
  const shell = env.SHELL?.trim() || '/bin/sh';
  const found: Array<{ command: string; problem: 'stdout' | 'stderr' | 'timeout' }> = [];
  for (const flag of ['-c', '-lc']) {
    const command = `${shell} ${flag} true`;
    const run = spawnSync(shell, [flag, 'true'], {
      env: childEnv(env),
      cwd,
      timeout: 2_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT' || run.signal) found.push({ command, problem: 'timeout' });
    else if (run.error)
      continue; // the shell cannot be started here: nothing to judge
    else if (run.stdout) found.push({ command, problem: 'stdout' });
    else if (run.stderr) found.push({ command, problem: 'stderr' });
  }
  return found;
};
