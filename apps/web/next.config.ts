import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace modules ship TypeScript source (ADR-0001).
  transpilePackages: ['@javis-dog/ui'],
  poweredByHeader: false,
};

export default nextConfig;
