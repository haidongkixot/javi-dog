import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SELF_REPORT } from '@javis-dog/collector-adapters';
import { parse as parseToml } from 'smol-toml';
import { writeTarget } from './claude-env.ts';
import { CODEX_BLOCK_END } from './codex-config.ts';
import {
  appendTo,
  applySplice,
  codexProjectConfigPath,
  lineIndent,
  pretty,
  removeAt,
  spans,
  type JsonNode,
} from './codex-hooks.ts';
import { geminiProjectSettingsPath, isPlainObject } from './gemini-settings.ts';
import { jsonEqual } from './gemini-telemetry.ts';
import type { Platform } from './platform.ts';
import { settingsPath } from './settings.ts';
import { writeJsonPrivate, writeTextAtomic } from './state.ts';

// Agent self-report registration (ADR-0017 §5, JD-C01). `javi init --self-report` adds an MCP
// server named `javi` to the platform's project file:
//
// - Claude Code: `.mcp.json` `mcpServers.javi`;
// - Gemini CLI: `.gemini/settings.json` `mcpServers.javi`;
// - Codex CLI: the project's `.codex/config.toml` `[mcp_servers.javi]`, inside a javi marker
//   block (the S5c `[otel]` block pattern, but in the project file).
//
// The entry runs `<node> --no-warnings ~/.javi/bin/javi-mcp.mjs --platform <p> --project <ref>`:
// an unversioned launcher javi init rewrites, so an upgrade never changes the registered
// command (S5c launcher lesson). It holds no secret and no environment variables. JSON files
// are edited in place: every byte outside javi's entry stays as it was, and uninstall removes
// exactly what install added. A file that does not parse, a git-tracked file (unless
// `--allow-tracked-config`) and a `javi` server javi did not write are refused before anything
// is written.

/** File name of the unversioned launcher in `<JAVI_HOME>/bin`. */
export const MCP_LAUNCHER_NAME = 'javi-mcp.mjs';
/** Start marker of javi's block in `.codex/config.toml`; the end marker is S5c's `# <<< javi`. */
export const SELF_REPORT_BLOCK_START = '# >>> javi self-report (do not edit)';
/** The two allow rules `--allow-self-report` adds for Claude Code (ADR-0017 §5). */
export const CLAUDE_SELF_REPORT_ALLOW = SELF_REPORT.tools.map(
  (tool) => `mcp__${SELF_REPORT.serverName}__${tool}`,
);
/** Gemini's `includeTools` for javi's entry under `--allow-self-report`. */
export const GEMINI_SELF_REPORT_TOOLS = [...SELF_REPORT.tools];

export const mcpLauncherPath = (home: string) => join(home, 'bin', MCP_LAUNCHER_NAME);

/**
 * The launcher: pins `JAVI_HOME` (as the Codex hook launcher does), puts the installed javi in
 * `argv[1]` with the `mcp` command after it, and imports it. It prints nothing itself.
 */
export const mcpLauncherScript = (cliPath: string, home: string) => {
  for (const word of [cliPath, home]) {
    if (!word || /[\0\r\n]/.test(word)) {
      throw new Error(
        'javi cannot write its self-report launcher: the path of javi or JAVI_HOME contains a line break. Move it and re-run javi init.',
      );
    }
  }
  return [
    '// Written by javi init --self-report: MCP clients start javi mcp through this file, so a',
    '// javi upgrade never changes the registered command. It prints nothing itself.',
    "import { pathToFileURL } from 'node:url';",
    `process.env.JAVI_HOME = ${JSON.stringify(home)};`,
    `const cli = ${JSON.stringify(cliPath)};`,
    "process.argv.splice(1, 1, cli, 'mcp');",
    'await import(pathToFileURL(cli).href);',
    '',
  ].join('\n');
};

/** Writes (or refreshes) `<home>/bin/javi-mcp.mjs` atomically; returns its path. */
export const installMcpLauncher = async (home: string, cliPath: string) => {
  const path = mcpLauncherPath(home);
  await mkdir(join(home, 'bin'), { recursive: true, mode: 0o700 });
  await chmod(join(home, 'bin'), 0o700).catch(() => {});
  const script = mcpLauncherScript(cliPath, home);
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== script) await writeTextAtomic(path, script, 0o644);
  return path;
};

export interface McpEntry {
  command: string;
  args: string[];
  trust?: true;
  includeTools?: string[];
}

/** The registered server entry (Gemini's carries `trust` and `includeTools` when pre-approved). */
export const mcpEntry = (
  platform: Platform,
  nodePath: string,
  launcher: string,
  projectRef: string,
  preApproved = false,
): McpEntry => ({
  command: nodePath,
  args: ['--no-warnings', launcher, '--platform', platform, '--project', projectRef],
  ...(platform === 'gemini-cli' &&
    preApproved && { trust: true as const, includeTools: [...GEMINI_SELF_REPORT_TOOLS] }),
});

/** The project file a platform's MCP registration goes into. */
export const registrationPath = (platform: Platform, projectDir: string) =>
  platform === 'gemini-cli'
    ? geminiProjectSettingsPath(projectDir)
    : platform === 'codex-cli'
      ? codexProjectConfigPath(projectDir)
      : join(projectDir, '.mcp.json');

/** An entry javi wrote: its args name javi's launcher. */
export const isJaviEntry = (value: unknown): value is McpEntry =>
  isPlainObject(value) &&
  Array.isArray(value.args) &&
  value.args.some(
    (a) =>
      typeof a === 'string' &&
      (a.endsWith(`/${MCP_LAUNCHER_NAME}`) || a.endsWith(`\\${MCP_LAUNCHER_NAME}`)),
  );

/** `--project <ref>` from a javi entry's args. */
export const entryProject = (entry: McpEntry): string | null => {
  const i = entry.args.indexOf('--project');
  const ref = i >= 0 ? entry.args[i + 1] : undefined;
  return typeof ref === 'string' ? ref : null;
};

/** What one `git` run returned (the shape of `spawnSync`'s result, output as text). */
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

/** True unless git says `file` is untracked: a check that cannot answer counts as tracked. */
export const gitTracked = (projectDir: string, file: string, git: GitRunner = runGit) =>
  gitTracking(projectDir, file, git) !== 'untracked';

// --- Loading ---

type JsonObject = Record<string, unknown>;
type LoadedJson =
  | { kind: 'missing' }
  | { kind: 'unparsable' }
  | { kind: 'ok'; text: string; value: JsonObject; mode: number };

const loadJson = async (path: string): Promise<LoadedJson> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return { kind: 'unparsable' };
    return { kind: 'ok', text, value, mode: (await stat(path)).mode & 0o777 };
  } catch {
    return { kind: 'unparsable' };
  }
};

const loadText = async (path: string): Promise<{ text: string; mode: number } | null> => {
  try {
    const text = await readFile(path, 'utf8');
    return { text, mode: (await stat(path)).mode & 0o777 };
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
};

const tryToml = (text: string): JsonObject | null => {
  try {
    return parseToml(text) as JsonObject;
  } catch {
    return null;
  }
};

// --- JSON registration (`.mcp.json`, `.gemini/settings.json`) ---

const serversOf = (value: JsonObject): unknown =>
  Object.hasOwn(value, 'mcpServers') ? value.mcpServers : undefined;

/** `text` with `mcpServers.javi` set to `entry`, every other byte kept. */
const withJsonEntry = (text: string, entry: McpEntry): string => {
  const root = spans(text) as Extract<JsonNode, { kind: 'object' }>;
  const servers = root.members.filter((m) => m.key === 'mcpServers').at(-1);
  if (!servers) {
    return applySplice(
      text,
      appendTo(text, root, root.members, (ind) => `"mcpServers": ${pretty({ javi: entry }, ind)}`),
    );
  }
  const node = servers.value as Extract<JsonNode, { kind: 'object' }>;
  const javi = node.members.filter((m) => m.key === 'javi').at(-1);
  if (javi) {
    return applySplice(text, {
      from: javi.value.start,
      to: javi.value.end,
      text: pretty(entry, lineIndent(text, javi.start)),
    });
  }
  return applySplice(
    text,
    appendTo(text, node, node.members, (ind) => `"javi": ${pretty(entry, ind)}`),
  );
};

/**
 * `text` without `mcpServers.javi`; with `dropContainer`, an `mcpServers` left empty goes too
 * (javi added it). Every other byte is kept.
 */
const withoutJsonEntry = (text: string, dropContainer: boolean): string => {
  let next = text;
  for (let round = 0; round < 16; round++) {
    const root = spans(next) as Extract<JsonNode, { kind: 'object' }>;
    const servers = root.members.filter((m) => m.key === 'mcpServers').at(-1);
    if (!servers || servers.value.kind !== 'object') return next;
    const node = servers.value;
    const i = node.members.findIndex((m) => m.key === 'javi');
    if (i < 0) return next;
    next =
      node.members.length === 1 && dropContainer
        ? applySplice(next, removeAt(root, root.members, root.members.indexOf(servers)))
        : applySplice(next, removeAt(node, node.members, i));
  }
  return next;
};

// --- Codex `.codex/config.toml` block ---

/** A TOML basic string (JSON escapes are TOML escapes; DEL must be escaped in TOML). */
const tomlString = (value: string) => JSON.stringify(value).replaceAll('\u007f', '\\u007F');

/** javi's marked block for `.codex/config.toml`, ending in a newline. */
export const codexMcpBlock = (entry: McpEntry) =>
  [
    SELF_REPORT_BLOCK_START,
    '[mcp_servers.javi]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    CODEX_BLOCK_END,
    '',
  ].join('\n');

/** [from, to) of javi's self-report block (start marker line through its end marker line). */
const findCodexBlock = (text: string): { from: number; to: number } | null => {
  let from = -1;
  for (let i = text.indexOf(SELF_REPORT_BLOCK_START); i >= 0;) {
    const after = i + SELF_REPORT_BLOCK_START.length;
    if ((i === 0 || text[i - 1] === '\n') && /^\r?\n/.test(text.slice(after, after + 2))) {
      from = i;
      break;
    }
    i = text.indexOf(SELF_REPORT_BLOCK_START, i + 1);
  }
  if (from < 0) return null;
  for (let i = text.indexOf(CODEX_BLOCK_END, from); i >= 0;) {
    const after = i + CODEX_BLOCK_END.length;
    const rest = text.startsWith('\r\n', after) ? 2 : text.startsWith('\n', after) ? 1 : 0;
    if (text[i - 1] === '\n' && (rest > 0 || after === text.length)) {
      return { from, to: after + rest };
    }
    i = text.indexOf(CODEX_BLOCK_END, i + 1);
  }
  return null;
};

const codexJaviTable = (parsed: JsonObject | null): unknown => {
  const servers = parsed && Object.hasOwn(parsed, 'mcp_servers') ? parsed.mcp_servers : undefined;
  return isPlainObject(servers) && Object.hasOwn(servers, 'javi') ? servers.javi : undefined;
};

// --- Claude Code pre-approval (`.claude/settings.local.json` `permissions.allow`) ---

type AllowShape =
  | { kind: 'ok'; settings: JsonObject; allow: unknown[] | null; permissions: boolean }
  | { kind: 'unparsable' };

const loadAllow = async (projectDir: string): Promise<AllowShape> => {
  const loaded = await loadJson(settingsPath(projectDir));
  if (loaded.kind === 'unparsable') return { kind: 'unparsable' };
  const settings = loaded.kind === 'ok' ? loaded.value : {};
  if (!Object.hasOwn(settings, 'permissions')) {
    return { kind: 'ok', settings, allow: null, permissions: false };
  }
  const permissions = settings.permissions;
  if (!isPlainObject(permissions)) return { kind: 'unparsable' };
  if (!Object.hasOwn(permissions, 'allow')) {
    return { kind: 'ok', settings, allow: null, permissions: true };
  }
  return Array.isArray(permissions.allow)
    ? { kind: 'ok', settings, allow: permissions.allow, permissions: true }
    : { kind: 'unparsable' };
};

// --- Public operations ---

/** What javi keeps in its state about one registration (for uninstall and `javi mcp`). */
export interface SelfReportRegistration {
  platform: Platform;
  project: string;
  /** The project folder (`--dir`), where the platform's hooks live. */
  dir: string;
  /** The registration file. */
  file: string;
  /** javi created the file: uninstall deletes it when nothing else is left. */
  created: boolean;
  /** JSON files: javi added `mcpServers`, so uninstall removes it when javi's entry was alone. */
  container: boolean;
  /** Codex: what javi put before its block ('' or line breaks). */
  separator: string;
  /** Claude Code: the `permissions.allow` entries javi added (`--allow-self-report`). */
  allow: string[];
  /** Claude Code: javi created `permissions` (`'permissions'`) or only its `allow` (`'allow'`). */
  allowCreated: 'permissions' | 'allow' | null;
}

export type SelfReportCheck = { ok: true } | { ok: false; message: string };

const refusal = (message: string): SelfReportCheck => ({ ok: false, message });
const NOTHING = 'Nothing was changed: no token saved, no hooks registered.';

/**
 * Before `init --self-report` writes anything: refuses a git-tracked registration file (unless
 * `allowTracked`), a file that does not parse, an `mcpServers` that is not an object, a `javi`
 * server javi did not write and, with `allowSelfReport` on Claude Code, a
 * `.claude/settings.local.json` whose `permissions.allow` is not a list.
 */
export const checkSelfReport = async (opts: {
  platform: Platform;
  projectDir: string;
  allowTracked: boolean;
  allowSelfReport: boolean;
  /** Runs git for the tracked check (default: the real `git`). */
  git?: GitRunner;
}): Promise<SelfReportCheck> => {
  const { platform, projectDir } = opts;
  const file = registrationPath(platform, projectDir);
  const command = `javi init --self-report${platform === 'claude-code' ? '' : ` --platform ${platform}`}`;
  const tracking = opts.allowTracked ? 'untracked' : gitTracking(projectDir, file, opts.git);
  if (tracking === 'tracked') {
    return refusal(
      `${command} refused: ${file} is tracked by git, and javi's entry holds paths on this machine (Node.js and ~/.javi) that would break for everyone else who uses the repository. ${NOTHING} Untrack the file, or re-run with --allow-tracked-config to write it anyway.`,
    );
  }
  if (tracking === 'unknown') {
    return refusal(
      `${command} refused: javi could not check whether git tracks ${file} (git is missing, failed or did not answer in time), and javi's entry holds paths on this machine that must not be committed. ${NOTHING} Make sure git status works in ${projectDir}, or re-run with --allow-tracked-config to write the file anyway.`,
    );
  }
  if (platform === 'codex-cli') {
    const loaded = await loadText(file);
    if (loaded) {
      const found = findCodexBlock(loaded.text);
      const user = found
        ? loaded.text.slice(0, found.from) + loaded.text.slice(found.to)
        : loaded.text;
      const parsed = tryToml(user);
      if (!parsed) {
        return refusal(
          `${command} refused: ${file} does not parse as TOML, and javi does not edit a file it cannot read. ${NOTHING}`,
        );
      }
      if (codexJaviTable(parsed) !== undefined) {
        return refusal(
          `${command} refused: ${file} already has an MCP server named javi that javi did not write. ${NOTHING} Rename or remove it, then re-run.`,
        );
      }
      // The block javi would append must parse as javi's table (an inline `mcp_servers = {…}`
      // cannot be extended by a `[mcp_servers.javi]` header).
      const probe = { command: 'node', args: ['--no-warnings', `/${MCP_LAUNCHER_NAME}`] };
      const next = `${user}${user === '' ? '' : '\n\n'}${codexMcpBlock(probe)}`;
      if (!jsonEqual(codexJaviTable(tryToml(next)), probe)) {
        return refusal(
          `${command} refused: ${file} cannot take a [mcp_servers.javi] table (is mcp_servers an inline table?). ${NOTHING}`,
        );
      }
    }
  } else {
    const loaded = await loadJson(file);
    if (loaded.kind === 'unparsable') {
      return refusal(
        `${command} refused: ${file} is not a plain JSON object javi can read (javi does not edit files with comments or another shape). ${NOTHING}`,
      );
    }
    if (loaded.kind === 'ok') {
      const servers = serversOf(loaded.value);
      if (servers !== undefined && !isPlainObject(servers)) {
        return refusal(`${command} refused: "mcpServers" in ${file} is not an object. ${NOTHING}`);
      }
      if (isPlainObject(servers) && Object.hasOwn(servers, 'javi') && !isJaviEntry(servers.javi)) {
        return refusal(
          `${command} refused: ${file} already has an MCP server named javi that javi did not write. ${NOTHING} Rename or remove it, then re-run.`,
        );
      }
    }
  }
  if (platform === 'claude-code' && opts.allowSelfReport) {
    if ((await loadAllow(projectDir)).kind !== 'ok') {
      return refusal(
        `${command} --allow-self-report refused: ${settingsPath(projectDir)} has no "permissions.allow" list javi can read. ${NOTHING}`,
      );
    }
  }
  return { ok: true };
};

export interface RegisterResult {
  file: string;
  /** The registration file changed (false: javi's entry was already exactly there). */
  changed: boolean;
  record: SelfReportRegistration;
  /** Claude Code: allow entries added / removed by this run. */
  allowAdded: string[];
  allowRemoved: string[];
}

/**
 * Adds (or refreshes) javi's MCP entry and, on Claude Code, adds or removes javi's two allow
 * rules (`preApprove`). Run `checkSelfReport` first; throws for a file that changed meanwhile.
 * `previous` is the registration javi recorded earlier for this file, if any.
 */
export const registerSelfReport = async (opts: {
  platform: Platform;
  projectDir: string;
  projectRef: string;
  nodePath: string;
  launcher: string;
  preApprove: boolean;
  previous: SelfReportRegistration | null;
}): Promise<RegisterResult> => {
  const { platform, projectDir, projectRef, previous } = opts;
  const file = registrationPath(platform, projectDir);
  const entry = mcpEntry(platform, opts.nodePath, opts.launcher, projectRef, opts.preApprove);
  const unreadable = () =>
    new Error(`Cannot register javi's MCP server in ${file}: the file changed. Nothing written.`);
  let changed = false;
  let created = false;
  let container = false;
  let separator = '';

  if (platform === 'codex-cli') {
    const block = codexMcpBlock(entry);
    const loaded = await loadText(file);
    const text = loaded?.text ?? '';
    const found = findCodexBlock(text);
    let next: string;
    if (found) {
      next = text.slice(0, found.from) + block + text.slice(found.to);
      created = previous?.created ?? false;
      separator = previous?.separator ?? '';
    } else {
      separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      next = `${text}${separator}${block}`;
      created = loaded === null;
    }
    const check = tryToml(next);
    if (!check || !jsonEqual(codexJaviTable(check), { command: entry.command, args: entry.args })) {
      throw new Error(
        `Cannot register javi's MCP server in ${file}: [mcp_servers.javi] cannot be added to this file (is mcp_servers an inline table?). Nothing written.`,
      );
    }
    if (next !== text) {
      if (loaded) await writeTextAtomic(await writeTarget(file), next, loaded.mode);
      else {
        await mkdir(join(projectDir, '.codex'), { recursive: true });
        await writeTextAtomic(file, next, 0o644);
      }
      changed = true;
    }
  } else {
    const loaded = await loadJson(file);
    if (loaded.kind === 'unparsable') throw unreadable();
    if (loaded.kind === 'missing') {
      if (platform === 'gemini-cli') await mkdir(join(projectDir, '.gemini'), { recursive: true });
      await writeTextAtomic(
        file,
        `${JSON.stringify({ mcpServers: { javi: entry } }, null, 2)}\n`,
        0o644,
      );
      created = true;
      container = true;
      changed = true;
    } else {
      const servers = serversOf(loaded.value);
      if (servers !== undefined && !isPlainObject(servers)) throw unreadable();
      const existing = isPlainObject(servers) ? servers.javi : undefined;
      if (existing !== undefined && !isJaviEntry(existing)) throw unreadable();
      const ours = existing !== undefined && previous !== null;
      created = ours ? previous.created : false;
      container = ours ? previous.container : servers === undefined;
      if (!jsonEqual(existing, entry)) {
        const next = withJsonEntry(loaded.text, entry);
        const parsed = JSON.parse(next) as JsonObject;
        const javi = (serversOf(parsed) as JsonObject | undefined)?.javi;
        if (!jsonEqual(javi, entry)) throw unreadable();
        await writeTextAtomic(await writeTarget(file), next, loaded.mode);
        changed = true;
      }
    }
  }

  // Claude Code pre-approval: exactly javi's two rules; javi remembers which ones it added.
  let allow: string[] = [];
  let allowCreated: SelfReportRegistration['allowCreated'] = previous?.allowCreated ?? null;
  const allowAdded: string[] = [];
  const allowRemoved: string[] = [];
  if (platform === 'claude-code') {
    const shape = await loadAllow(projectDir);
    if (shape.kind !== 'ok') {
      if (opts.preApprove) throw new Error(`Cannot read ${settingsPath(projectDir)}.`);
    } else {
      const ownedBefore = previous?.allow ?? [];
      const list = [...(shape.allow ?? [])];
      if (opts.preApprove) {
        for (const rule of CLAUDE_SELF_REPORT_ALLOW) {
          if (!list.includes(rule)) {
            list.push(rule);
            allowAdded.push(rule);
            allow.push(rule);
          } else if (ownedBefore.includes(rule)) allow.push(rule);
        }
        if (allowAdded.length && shape.allow === null && allowCreated === null) {
          allowCreated = shape.permissions ? 'allow' : 'permissions';
        }
      } else {
        for (const rule of ownedBefore) {
          const i = list.indexOf(rule);
          if (i >= 0) {
            list.splice(i, 1);
            allowRemoved.push(rule);
          }
        }
        allow = [];
      }
      if (allowAdded.length || allowRemoved.length) {
        await writeAllow(projectDir, shape.settings, list, allowCreated);
        if (!opts.preApprove) allowCreated = null;
      }
    }
  }
  return {
    file,
    changed,
    allowAdded,
    allowRemoved,
    record: {
      platform,
      project: projectRef,
      dir: projectDir,
      file,
      created,
      container,
      separator,
      allow,
      allowCreated: allow.length ? allowCreated : null,
    },
  };
};

/** Writes `permissions.allow` = `list`, dropping containers javi created once they are empty. */
const writeAllow = async (
  projectDir: string,
  settings: JsonObject,
  list: unknown[],
  created: SelfReportRegistration['allowCreated'],
) => {
  const permissions = isPlainObject(settings.permissions) ? { ...settings.permissions } : {};
  if (list.length || created === null) permissions.allow = list;
  else delete permissions.allow;
  const next = { ...settings };
  if (Object.keys(permissions).length || created !== 'permissions') next.permissions = permissions;
  else delete next.permissions;
  const path = settingsPath(projectDir);
  await mkdir(join(projectDir, '.claude'), { recursive: true });
  await writeJsonPrivate(await writeTarget(path), next);
};

export interface UnregisterResult {
  file: string;
  /**
   * `removed`: javi's entry is gone, everything else kept; `deleted`: javi had created the file
   * and nothing else was left, so the file is gone; `absent`: no entry of javi's for this
   * project; `changed` (Codex): javi's block was edited, so the file was left as it is.
   */
  outcome: 'removed' | 'deleted' | 'absent' | 'changed';
  /** Claude Code allow entries removed. */
  allowRemoved: string[];
  /**
   * The file could not be read as a plain JSON object, but javi never recorded a registration
   * in it (code review M2): treated as `absent`, and the caller warns once.
   */
  unreadable: boolean;
}

/**
 * Removes javi's MCP entry for `projectRef` (never a `javi` server javi did not write, nor one
 * registered for another project), then the allow rules javi recorded. Throws for a file that
 * does not parse when javi recorded a registration in it (nothing removed); without such a
 * record the file is not javi's business, so it counts as `absent` with `unreadable` set.
 */
export const unregisterSelfReport = async (opts: {
  platform: Platform;
  projectDir: string;
  projectRef: string;
  record: SelfReportRegistration | null;
}): Promise<UnregisterResult> => {
  const { platform, projectDir, projectRef, record } = opts;
  const file = registrationPath(platform, projectDir);
  let outcome: UnregisterResult['outcome'] = 'absent';
  let unreadable = false;
  if (platform === 'codex-cli') {
    const loaded = await loadText(file);
    const found = loaded ? findCodexBlock(loaded.text) : null;
    if (loaded && found) {
      const table = codexJaviTable(tryToml(loaded.text.slice(found.from, found.to)));
      if (!isJaviEntry(table)) outcome = 'changed';
      else if (entryProject(table) === projectRef) {
        const { text } = loaded;
        const separator = record?.separator ?? '';
        const from =
          separator && text.slice(0, found.from).endsWith(separator)
            ? found.from - separator.length
            : found.from;
        const next = text.slice(0, from) + text.slice(found.to);
        const target = await writeTarget(file);
        if (record?.created && next.trim() === '') {
          await rm(target, { force: true });
          outcome = 'deleted';
        } else {
          await writeTextAtomic(target, next, loaded.mode);
          outcome = 'removed';
        }
      }
    }
  } else {
    const loaded = await loadJson(file);
    if (loaded.kind === 'unparsable' && record === null) unreadable = true;
    else if (loaded.kind === 'unparsable') {
      throw new Error(
        `Cannot read ${file} as a plain JSON object: javi's MCP entry was not removed and nothing else was changed. Fix it, then re-run javi uninstall.`,
      );
    }
    if (loaded.kind === 'ok') {
      const servers = serversOf(loaded.value);
      const entry = isPlainObject(servers) ? servers.javi : undefined;
      if (isJaviEntry(entry) && entryProject(entry) === projectRef) {
        const next = withoutJsonEntry(loaded.text, record?.container ?? false);
        const target = await writeTarget(file);
        if (record?.created && jsonEqual(JSON.parse(next), {})) {
          await rm(target, { force: true });
          outcome = 'deleted';
        } else {
          await writeTextAtomic(target, next, loaded.mode);
          outcome = 'removed';
        }
      }
    }
  }
  const allowRemoved: string[] = [];
  if (platform === 'claude-code' && record?.project === projectRef && record.allow.length) {
    const shape = await loadAllow(projectDir);
    if (shape.kind === 'ok' && shape.allow) {
      const list = [...shape.allow];
      for (const rule of record.allow) {
        const i = list.indexOf(rule);
        if (i >= 0) {
          list.splice(i, 1);
          allowRemoved.push(rule);
        }
      }
      if (allowRemoved.length) {
        await writeAllow(projectDir, shape.settings, list, record.allowCreated);
      }
    }
  }
  return { file, outcome, allowRemoved, unreadable };
};

export interface SelfReportStatus {
  file: string;
  /** javi's entry in the file, or null. */
  entry: McpEntry | null;
  /** The project the entry is registered for. */
  project: string | null;
  /** Pre-approved: Claude Code allow rules / Gemini trust; null for Codex (nothing to write). */
  preApproved: boolean | null;
  /** The registered Node.js path exists. */
  nodeExists: boolean;
  /** The registered launcher exists. */
  launcherExists: boolean;
  /** The registration file could not be read. */
  unreadable: boolean;
}

/** What `javi status` reports about self-report for one platform and project folder. */
export const readSelfReport = async (
  platform: Platform,
  projectDir: string,
): Promise<SelfReportStatus> => {
  const file = registrationPath(platform, projectDir);
  let entry: McpEntry | null = null;
  let unreadable = false;
  if (platform === 'codex-cli') {
    const loaded = await loadText(file).catch(() => null);
    const found = loaded ? findCodexBlock(loaded.text) : null;
    if (loaded && found) {
      const table = codexJaviTable(tryToml(loaded.text.slice(found.from, found.to)));
      if (isJaviEntry(table)) entry = table;
    }
    if (loaded && !tryToml(loaded.text)) unreadable = true;
  } else {
    const loaded = await loadJson(file).catch(() => ({ kind: 'unparsable' }) as const);
    if (loaded.kind === 'unparsable') unreadable = true;
    if (loaded.kind === 'ok') {
      const servers = serversOf(loaded.value);
      const javi = isPlainObject(servers) ? servers.javi : undefined;
      if (isJaviEntry(javi)) entry = javi;
    }
  }
  let preApproved: boolean | null = null;
  if (platform === 'claude-code') {
    const shape = await loadAllow(projectDir).catch(() => ({ kind: 'unparsable' }) as const);
    preApproved =
      shape.kind === 'ok' && CLAUDE_SELF_REPORT_ALLOW.every((r) => shape.allow?.includes(r));
  } else if (platform === 'gemini-cli') {
    preApproved =
      entry !== null &&
      entry.trust === true &&
      jsonEqual(entry.includeTools, GEMINI_SELF_REPORT_TOOLS);
  }
  const launcher = entry?.args[1];
  return {
    file,
    entry,
    project: entry ? entryProject(entry) : null,
    preApproved,
    nodeExists: entry !== null && typeof entry.command === 'string' && existsSync(entry.command),
    launcherExists: typeof launcher === 'string' && existsSync(launcher),
    unreadable,
  };
};
