// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { Sidebar } = await import('@/components/sidebar');
const { allNav } = await import('@/components/nav');
const { default: OverviewPage } = await import('@/app/page');

afterEach(cleanup);

describe('navigation (BRAND_GUIDE §8)', () => {
  it('has exactly the five core spaces', () => {
    expect(allNav.map((n) => n.label)).toEqual([
      'Overview',
      'Projects',
      'Live agents',
      'Token network',
      'JGR & Integrations',
    ]);
  });

  it('marks the active space with aria-current and the token network as concept only', () => {
    pathname = '/projects';
    render(<Sidebar />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(
      within(nav)
        .getByRole('link', { name: /Projects/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(within(nav).getByRole('link', { name: /Token network/ }).textContent).toContain(
      'Concept only',
    );
  });

  it('never claims a live connection', () => {
    render(<Sidebar />);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });
});

describe('Overview (product rule 4: no mock masquerading as product)', () => {
  it('renders every KPI as "No signal yet" without sample numbers', () => {
    render(<OverviewPage />);
    expect(screen.getAllByText('No signal yet')).toHaveLength(4);
    expect(screen.queryByText(/\d+(\.\d+)?\s?(K\/s|%|M)\b/)).toBeNull();
  });
});
