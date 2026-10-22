import '@fontsource-variable/inter';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { palette } from '@javis-dog/ui';
import { DemoBanner } from '@javis-dog/ui/components';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';

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
      <body className="antialiased">
        <div className="grid min-h-screen grid-cols-[238px_minmax(0,1fr)] max-[1150px]:grid-cols-[210px_minmax(0,1fr)] max-[850px]:grid-cols-[65px_minmax(0,1fr)]">
          <Sidebar />
          <div className="min-w-0">
            <Topbar />
            <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-8 pt-7 pb-10 max-[1150px]:px-6 max-[850px]:px-4">
              <DemoBanner title="Preview build.">
                You can sign in and create projects; agents and providers are not connected yet.
                Values appear only after a verified JGR signal arrives.
              </DemoBanner>
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
