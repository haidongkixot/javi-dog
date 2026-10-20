import '@fontsource-variable/inter';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { palette } from '@javis-dog/ui';

export const metadata: Metadata = {
  title: {
    default: "Javi's Dog — Agent observability, made clear",
    template: "%s · Javi's Dog",
  },
  description:
    'Every agent. One clear signal. A privacy-aware observability companion for vibe coders.',
};

export const viewport: Viewport = {
  themeColor: palette.packNight,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
