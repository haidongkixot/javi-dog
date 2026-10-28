// How pack.mjs and its tests run npm (JD-C01, S3f review finding 6). On Windows `npm` is a .cmd
// file, which needs a shell, and a shell splits unquoted arguments at spaces (temp and user
// paths often have them). So on Windows run npm's JS entry with this Node when it can be found,
// and only fall back to the shell with every argument quoted. Elsewhere: plain `npm`, no shell.
// The Windows branches are UNVERIFIED on Windows (unit-tested with fake paths on Linux).
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

const CMD_META = /[\s"&|<>^()%!,;=]/;

/** Quotes one argument for cmd.exe: wrapped in "…" when it has spaces or metacharacters. */
export const quoteWinArg = (arg) => {
  if (arg === '') return '""';
  return CMD_META.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
};

/** npm's JS entry: npm_execpath when npm itself runs us, else the npm shipped next to Node. */
export const npmCliPath = ({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  exists = existsSync,
} = {}) => {
  const fromEnv = env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && exists(fromEnv)) return fromEnv;
  const path = platform === 'win32' ? win32 : posix;
  const base = path.dirname(execPath);
  const candidate =
    platform === 'win32'
      ? path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return exists(candidate) ? candidate : undefined;
};

/** The command, arguments and shell flag for one npm run on this platform. */
export const npmInvocation = (args, options = {}) => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'npm', args: [...args], shell: false };
  const cli = npmCliPath({ ...options, platform });
  if (cli) {
    return { command: options.execPath ?? process.execPath, args: [cli, ...args], shell: false };
  }
  return { command: 'npm', args: args.map(quoteWinArg), shell: true };
};
