import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace modules ship TypeScript source (ADR-0001).
  transpilePackages: [
    '@javis-dog/ui',
    '@javis-dog/analytics',
    '@javis-dog/event-store',
    '@javis-dog/identity',
    '@javis-dog/ingest',
    '@javis-dog/jgr-spec',
    '@javis-dog/notify',
    '@javis-dog/projects',
    '@javis-dog/realtime',
    '@javis-dog/resilience',
  ],
  poweredByHeader: false,
};

export default nextConfig;
