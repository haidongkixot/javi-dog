// Types for scripts/npm.mjs (imported by the tests).
export interface NpmOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export interface NpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

export declare const quoteWinArg: (arg: string) => string;
export declare const npmCliPath: (options?: NpmOptions) => string | undefined;
export declare const npmInvocation: (args: string[], options?: NpmOptions) => NpmInvocation;
