'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandTile, cx, Icon } from '@javis-dog/ui/components';
import { controlPlaneNav, workspaceNav, type NavItem } from './nav';

function NavGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: readonly NavItem[];
  pathname: string;
}) {
  return (
    <div>
      <p className="mb-2 px-3 text-[11px] font-extrabold tracking-[0.14em] text-sidebar-label max-[850px]:sr-only">
        {label}
      </p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = item.href === pathname;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={item.question}
                className={cx(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-colors max-[850px]:justify-center',
                  active
                    ? 'bg-sidebar-active text-sidebar-text-active shadow-[inset_3px_0_var(--jd-sidebar-marker)]'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active',
                )}
              >
                <Icon name={item.icon} className="size-[17px] flex-none" />
                <span className="max-[850px]:sr-only">{item.label}</span>
                {item.badge ? (
                  <span className="ml-auto rounded-md bg-sidebar-hover px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap text-yellow max-[850px]:sr-only">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen flex-col gap-6 bg-sidebar px-4 pt-6 pb-5 text-sidebar-text-active max-[850px]:px-2">
      <Link
        href="/"
        className="flex items-center gap-2.5 px-2 max-[850px]:justify-center max-[850px]:px-0"
      >
        <BrandTile size={40} />
        <span className="max-[850px]:sr-only">
          <span className="block text-lg font-extrabold tracking-tight">Javi&apos;s Dog</span>
          <span className="block text-[11px] font-bold tracking-[0.15em] text-sidebar-text">
            AGENT OBSERVABILITY
          </span>
        </span>
      </Link>

      <nav aria-label="Primary" className="flex flex-col gap-6">
        <NavGroup label="WORKSPACE" items={workspaceNav} pathname={pathname} />
        <NavGroup label="CONTROL PLANE" items={controlPlaneNav} pathname={pathname} />
      </nav>

      <div className="mt-auto rounded-2xl border border-sidebar-border bg-sidebar-hover p-3.5 max-[850px]:hidden">
        <p className="flex items-center gap-2 text-xs font-bold">
          <span aria-hidden className="size-2 rounded-full bg-sidebar-label" />
          Pack health
          <span className="ml-auto text-sidebar-text">Not connected</span>
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-sidebar-text">
          No coding tool is sending signals yet.
        </p>
      </div>
    </aside>
  );
}
