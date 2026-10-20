'use client';

import { usePathname } from 'next/navigation';
import { titleFor } from './nav';

export function Topbar() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b border-line bg-surface/85 px-8 backdrop-blur-md max-[850px]:px-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-muted">
        <span>Workspace</span>
        <span aria-hidden>›</span>
        <strong className="font-bold text-ink" aria-current="page">
          {titleFor(pathname)}
        </strong>
      </nav>
      <p className="flex items-center gap-2 text-xs text-muted">
        <span aria-hidden className="size-2 rounded-full bg-decorative" />
        Preview build · no backend
      </p>
    </header>
  );
}
