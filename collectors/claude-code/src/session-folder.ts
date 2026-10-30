import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// The session folder of an L1/L2 project (ADR-0018 §4, review M4, G13). Read only for the
// `x.javi.thread.identity` event of a project with a stored recovery key; L0 projects never
// read it. git is never spawned here: `.git` and `HEAD` are read as small regular files.

/** `.git` files and `HEAD` are read only when they are regular files of at most 1 KiB. */
export const GIT_FILE_MAX_BYTES = 1024;
/** Upper bound on the directories walked from the session folder to the root. */
const MAX_LEVELS = 256;
/** Longest `cwd` accepted from a hook payload. */
const MAX_CWD_CHARS = 4096;
const BRANCH_REF = /^ref: refs\/heads\/(.+)$/;
const GITDIR = /^gitdir: (.+)$/;
// Windows has neither flag; there, the lstat checks and the fstat after open still apply.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export interface SessionFolder {
  /** The hook payload's `cwd`, exactly as given (hashed after NFC as `cwd_hash`). */
  cwd: string;
  /** Basename of the git work-tree root (a linked worktree: its own folder), else of `cwd`. */
  repo?: string;
  /** From `HEAD` when it is `ref: refs/heads/<branch>`; absent for a detached HEAD. */
  branch?: string;
}

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? '';

/**
 * The text of a small regular file, or null for anything else: a FIFO, a device, a socket, a
 * symlink, a directory, a file over 1 KiB, invalid UTF-8, or any error. `lstat` comes first;
 * the open uses O_NOFOLLOW and O_NONBLOCK (POSIX) and the descriptor is checked again with
 * fstat, so a file swapped for a FIFO between the two calls is neither waited on nor read.
 */
export const readSmallRegularFile = async (path: string): Promise<string | null> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > GIT_FILE_MAX_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const again = await handle.stat();
      if (!again.isFile() || again.size > GIT_FILE_MAX_BYTES) return null;
      const buffer = Buffer.alloc(GIT_FILE_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > GIT_FILE_MAX_BYTES) return null;
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/** The branch named by `<gitDir>/HEAD`, or undefined (detached, unreadable, hostile). */
const branchOf = async (gitDir: string): Promise<string | undefined> => {
  const head = await readSmallRegularFile(join(gitDir, 'HEAD'));
  if (head === null) return undefined;
  return BRANCH_REF.exec(firstLine(head))?.[1];
};

/**
 * The git directory behind a `.git` entry: the directory itself, or one `gitdir:` level of a
 * `.git` file (worktree, submodule) that must be a directory (not followed through a symlink).
 * Anything else (symlink, FIFO, device, oversized file, a `gitdir:` that names a file) → null.
 */
const gitDirOf = async (dotGit: string, workTree: string): Promise<string | null> => {
  const info = await lstat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) return null;
  const text = await readSmallRegularFile(dotGit);
  if (text === null) return null;
  const match = GITDIR.exec(firstLine(text));
  if (!match?.[1]) return null;
  const target = resolve(workTree, match[1]);
  const targetInfo = await lstat(target).catch(() => null);
  return targetInfo?.isDirectory() ? target : null;
};

/** True when `dir/.git` exists in any form (lstat: a symlink or FIFO counts as found). */
const hasDotGit = async (dir: string) =>
  lstat(join(dir, '.git')).then(
    () => true,
    () => false,
  );

/**
 * Reads the session folder of a hook payload (G13): `cwd` must be a non-empty absolute path;
 * otherwise null (no `cwd_hash`, no repo, no branch). Walks up from `cwd` to the first folder
 * with a `.git` entry: that folder is the work-tree root and names the repo; its branch comes
 * from `HEAD` under the strict reading rules (review M4). Outside git, the repo is the
 * basename of `cwd`. Never throws, never spawns a process.
 */
export const readSessionFolder = async (cwd: unknown): Promise<SessionFolder | null> => {
  if (
    typeof cwd !== 'string' ||
    cwd.length === 0 ||
    cwd.length > MAX_CWD_CHARS ||
    cwd.includes('\u0000') ||
    !isAbsolute(cwd)
  ) {
    return null;
  }
  try {
    const start = resolve(cwd);
    let dir = start;
    for (let level = 0; level < MAX_LEVELS; level++) {
      if (await hasDotGit(dir)) {
        const repo = basename(dir);
        const gitDir = await gitDirOf(join(dir, '.git'), dir);
        const branch = gitDir ? await branchOf(gitDir) : undefined;
        return { cwd, ...(repo && { repo }), ...(branch && { branch }) };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const repo = basename(start);
    return { cwd, ...(repo && { repo }) };
  } catch {
    return { cwd };
  }
};
