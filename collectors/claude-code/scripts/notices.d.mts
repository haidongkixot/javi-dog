// Types for scripts/notices.mjs (imported by the tests).
export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string;
}

export declare const thirdPartyPackages: (
  metafile: { inputs: Record<string, unknown> },
  absWorkingDir: string,
) => Promise<BundledPackage[]>;
export declare const renderNotices: (packages: BundledPackage[]) => string;
