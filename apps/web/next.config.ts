import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace modules ship TypeScript source (ADR-0001).
  transpilePackages: [
    '@javis-dog/ui',
    '@javis-dog/event-store',
    '@javis-dog/identity',
    '@javis-dog/projects',
  ],
  poweredByHeader: false,
};

export default nextConfig;
