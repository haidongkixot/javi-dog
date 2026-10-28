import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { npmInvocation, quoteWinArg } from '../scripts/npm.mjs';
import { renderNotices, thirdPartyPackages } from '../scripts/notices.mjs';

// S3f review findings 6 and 7: the pure parts of scripts/pack.mjs. The Windows branches run
// here with fake paths only; they are UNVERIFIED on a real Windows machine.
describe('npmInvocation', () => {
  const args = ['install', '--prefix', 'C:\\Users\\Ann Lee\\Temp\\prefix', 'a&b.tgz'];

  it('runs plain npm without a shell outside Windows', () => {
    expect(npmInvocation(args, { platform: 'linux' })).toEqual({
      command: 'npm',
      args,
      shell: false,
    });
  });

  it("on Windows runs npm's JS entry with this Node, no shell, when it exists", () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe';
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const result = npmInvocation(args, {
      platform: 'win32',
      execPath,
      env: {},
      exists: (p) => p === cli,
    });
    expect(result).toEqual({ command: execPath, args: [cli, ...args], shell: false });
  });

  it('prefers npm_execpath when it is npm-cli.js (run via npm), not pnpm', () => {
    const viaNpm = 'D:\\npm\\bin\\npm-cli.js';
    const opts = { platform: 'win32' as const, execPath: 'C:\\n\\node.exe', exists: () => true };
    expect(npmInvocation(['pack'], { ...opts, env: { npm_execpath: viaNpm } }).args).toEqual([
      viaNpm,
      'pack',
    ]);
    expect(
      npmInvocation(['pack'], { ...opts, env: { npm_execpath: 'D:\\pnpm\\bin\\pnpm.cjs' } })
        .args[0],
    ).toBe('C:\\n\\node_modules\\npm\\bin\\npm-cli.js');
  });

  it('falls back to the shell on Windows with every risky argument quoted', () => {
    const result = npmInvocation(args, {
      platform: 'win32',
      execPath: 'C:\\n\\node.exe',
      env: {},
      exists: () => false,
    });
    expect(result).toEqual({
      command: 'npm',
      args: ['install', '--prefix', '"C:\\Users\\Ann Lee\\Temp\\prefix"', '"a&b.tgz"'],
      shell: true,
    });
  });

  it('quotes for cmd.exe: spaces, metacharacters, embedded quotes, empty', () => {
    expect(quoteWinArg('plain-arg')).toBe('plain-arg');
    expect(quoteWinArg('C:\\a b\\x.tgz')).toBe('"C:\\a b\\x.tgz"');
    expect(quoteWinArg('a|b')).toBe('"a|b"');
    expect(quoteWinArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWinArg('')).toBe('""');
  });
});

describe('thirdPartyPackages', () => {
  let temp: string;
  const pkg = async (dir: string, name: string, licence?: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.2.3', license: 'MIT' }),
    );
    if (licence !== undefined) await writeFile(join(dir, 'LICENSE'), licence);
  };

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'javi-notices-'));
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('lists packages from metafile inputs under node_modules (scoped too), not workspace code', async () => {
    await pkg(join(temp, 'node_modules', '.pnpm', 'x@1', 'node_modules', 'zz'), 'zz', 'ZZ text');
    await pkg(join(temp, 'node_modules', '@s', 'aa'), '@s/aa', 'AA text ```');
    await pkg(join(temp, 'node_modules', '@javis-dog', 'jgr-sdk'), '@javis-dog/jgr-sdk');
    const metafile = {
      inputs: {
        'node_modules/.pnpm/x@1/node_modules/zz/lib/index.js': {},
        'node_modules/.pnpm/x@1/node_modules/zz/lib/other.js': {},
        'node_modules/@s/aa/index.mjs': {},
        'node_modules/@javis-dog/jgr-sdk/src/index.ts': {},
        'src/cli.ts': {},
        '../../packages/jgr-spec/src/index.ts': {},
      },
    };
    const packages = await thirdPartyPackages(metafile, temp);
    expect(packages.map((p) => `${p.name}@${p.version}:${p.text}`)).toEqual([
      '@s/aa@1.2.3:AA text ```',
      'zz@1.2.3:ZZ text',
    ]);
    const md = renderNotices(packages);
    expect(md).toContain('## @s/aa@1.2.3');
    expect(md).toContain('````text\nAA text ```\n````');
    expect(md).toContain('## zz@1.2.3\n\nLicence: MIT\n\n```text\nZZ text\n```');
  });

  it('fails when a bundled package has no licence file', async () => {
    await pkg(join(temp, 'node_modules', 'nolicence'), 'nolicence');
    await expect(
      thirdPartyPackages({ inputs: { 'node_modules/nolicence/index.js': {} } }, temp),
    ).rejects.toThrow('No licence file found for the bundled package nolicence@1.2.3.');
  });
});
