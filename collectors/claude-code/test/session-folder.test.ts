import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_FILE_MAX_BYTES, readSessionFolder } from '../src/session-folder.ts';

// ADR-0018 §4 reading rules (review M4, G13): the session folder is read without spawning git;
// `.git` and HEAD only as small regular files; hostile entries never hang and never yield a
// branch. Temp directories only.
let root: string;
const posix = process.platform !== 'win32';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'javi-folder-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh `<root>/<name>` folder with a `.git` directory whose HEAD is `head`. */
const repoWithHead = async (name: string, head: string | null) => {
  const dir = join(root, name);
  await mkdir(join(dir, '.git'), { recursive: true });
  if (head !== null) await writeFile(join(dir, '.git', 'HEAD'), head);
  return dir;
};

/** Fails the test instead of hanging when a read blocks (FIFO, device). */
const within = <T>(promise: Promise<T>, ms = 3_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`readSessionFolder did not return in ${ms} ms`)), ms),
    ),
  ]);

describe('readSessionFolder', () => {
  it('reads repo and branch from a .git directory, from the session folder or below it', async () => {
    const dir = await repoWithHead('shop-web', 'ref: refs/heads/feature/login\n');
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    expect(await readSessionFolder(dir)).toEqual({
      cwd: dir,
      repo: 'shop-web',
      branch: 'feature/login',
    });
    const nested = join(dir, 'src', 'deep');
    // cwd stays exactly as given; repo is the work-tree root's name.
    expect(await readSessionFolder(nested)).toEqual({
      cwd: nested,
      repo: 'shop-web',
      branch: 'feature/login',
    });
  });

  it('gives no branch for a detached HEAD, a non-heads ref or a HEAD with CRLF only on the ref', async () => {
    const detached = await repoWithHead('detached', `${'a'.repeat(40)}\n`);
    expect(await readSessionFolder(detached)).toEqual({ cwd: detached, repo: 'detached' });
    const tag = await repoWithHead('tagref', 'ref: refs/tags/v1\n');
    expect(await readSessionFolder(tag)).toEqual({ cwd: tag, repo: 'tagref' });
    const crlf = await repoWithHead('crlf', 'ref: refs/heads/main\r\n');
    expect(await readSessionFolder(crlf)).toEqual({ cwd: crlf, repo: 'crlf', branch: 'main' });
  });

  it('outside git: repo is the session folder name, no branch', async () => {
    // A folder outside the temp root's ancestors is not guaranteed to be git-free, so check the
    // walk on a folder whose ancestors have no .git (tmpdir normally has none).
    const plain = join(root, 'plain', 'notes');
    await mkdir(plain, { recursive: true });
    const result = await readSessionFolder(plain);
    expect(result?.cwd).toBe(plain);
    expect(result?.branch).toBeUndefined();
    expect(result?.repo).toBe('notes');
  });

  it('refuses a missing, empty, relative or non-string cwd (no cwd_hash, no names)', async () => {
    for (const cwd of [undefined, null, '', 'relative/dir', 42, { path: '/x' }, '/a\u0000b']) {
      expect(await readSessionFolder(cwd)).toBeNull();
    }
  });

  it('does not read a HEAD over 1 KiB', async () => {
    const big = await repoWithHead(
      'bighead',
      `ref: refs/heads/main\n${'x'.repeat(GIT_FILE_MAX_BYTES)}`,
    );
    expect(await readSessionFolder(big)).toEqual({ cwd: big, repo: 'bighead' });
    const exact = await repoWithHead(
      'exacthead',
      `ref: refs/heads/main\n`.padEnd(GIT_FILE_MAX_BYTES, ' '),
    );
    expect((await readSessionFolder(exact))?.branch).toBe('main');
  });

  it.runIf(posix)('does not follow a symlinked HEAD or a symlinked .git', async () => {
    const target = join(root, 'elsewhere-HEAD');
    await writeFile(target, 'ref: refs/heads/secret\n');
    const dir = await repoWithHead('symhead', null);
    await symlink(target, join(dir, '.git', 'HEAD'));
    expect(await readSessionFolder(dir)).toEqual({ cwd: dir, repo: 'symhead' });

    const realGit = await repoWithHead('real-git-dir', 'ref: refs/heads/main\n');
    const linked = join(root, 'symgit');
    await mkdir(linked);
    await symlink(join(realGit, '.git'), join(linked, '.git'));
    expect(await readSessionFolder(linked)).toEqual({ cwd: linked, repo: 'symgit' });
  });

  it.runIf(posix)('never hangs on a FIFO as HEAD or as .git (timeout 3 s)', async () => {
    const dir = await repoWithHead('fifohead', null);
    execFileSync('mkfifo', [join(dir, '.git', 'HEAD')]);
    expect(await within(readSessionFolder(dir))).toEqual({ cwd: dir, repo: 'fifohead' });

    const fifoGit = join(root, 'fifogit');
    await mkdir(fifoGit);
    execFileSync('mkfifo', [join(fifoGit, '.git')]);
    expect(await within(readSessionFolder(fifoGit))).toEqual({ cwd: fifoGit, repo: 'fifogit' });
  });

  it('follows one gitdir: level of a .git file (linked worktree): repo is the worktree folder', async () => {
    const main = await repoWithHead('mainrepo', 'ref: refs/heads/main\n');
    const wtGitDir = join(main, '.git', 'worktrees', 'hotfix-wt');
    await mkdir(wtGitDir, { recursive: true });
    await writeFile(join(wtGitDir, 'HEAD'), 'ref: refs/heads/hotfix\n');
    const worktree = join(root, 'hotfix-wt');
    await mkdir(join(worktree, 'pkg'), { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${wtGitDir}\n`);
    expect(await readSessionFolder(join(worktree, 'pkg'))).toEqual({
      cwd: join(worktree, 'pkg'),
      repo: 'hotfix-wt',
      branch: 'hotfix',
    });
    // A relative gitdir (submodule style) resolves against the work-tree root.
    const sub = join(main, 'vendor', 'lib');
    const subGitDir = join(main, '.git', 'modules', 'lib');
    await mkdir(sub, { recursive: true });
    await mkdir(subGitDir, { recursive: true });
    await writeFile(join(subGitDir, 'HEAD'), 'ref: refs/heads/stable\n');
    await writeFile(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');
    expect(await readSessionFolder(sub)).toEqual({ cwd: sub, repo: 'lib', branch: 'stable' });
  });

  it('a gitdir: that names a file, /dev/zero, a missing path, or a chain is not followed', async () => {
    const fileTarget = join(root, 'not-a-dir');
    await writeFile(fileTarget, 'ref: refs/heads/main\n');
    const cases: Array<[string, string]> = [
      ['gd-file', `gitdir: ${fileTarget}\n`],
      ['gd-missing', `gitdir: ${join(root, 'nope')}\n`],
      ['gd-garbage', 'not a gitdir line\n'],
      ['gd-big', `gitdir: ${root}\n${'x'.repeat(GIT_FILE_MAX_BYTES)}`],
    ];
    if (posix) cases.push(['gd-zero', 'gitdir: /dev/zero\n']);
    // A second level: the gitdir target is a directory whose only content is another .git file.
    const chainTarget = join(root, 'chain-target');
    await mkdir(chainTarget);
    await writeFile(join(chainTarget, 'HEAD'), 'gitdir: /somewhere\n');
    cases.push(['gd-chain', `gitdir: ${chainTarget}\n`]);
    for (const [name, text] of cases) {
      const dir = join(root, name);
      await mkdir(dir);
      await writeFile(join(dir, '.git'), text);
      expect(await within(readSessionFolder(dir)), name).toEqual({ cwd: dir, repo: name });
    }
  });

  it.runIf(posix)(
    'a HEAD that is a device (/dev/zero via symlink) or a directory is not read',
    async () => {
      const dir = await repoWithHead('devhead', null);
      await symlink('/dev/zero', join(dir, '.git', 'HEAD'));
      expect(await within(readSessionFolder(dir))).toEqual({ cwd: dir, repo: 'devhead' });
      const dirHead = await repoWithHead('dirhead', null);
      await mkdir(join(dirHead, '.git', 'HEAD'));
      expect(await readSessionFolder(dirHead)).toEqual({ cwd: dirHead, repo: 'dirhead' });
    },
  );

  it('keeps an NFD branch name as stored (hashing applies NFC, see identity tests)', async () => {
    const nfd = 'café';
    const dir = await repoWithHead('nfdrepo', `ref: refs/heads/${nfd}\n`);
    expect((await readSessionFolder(dir))?.branch).toBe(nfd);
  });
});
