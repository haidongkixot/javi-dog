import type { IconName } from '@javis-dog/ui/components';

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** The question this space answers (BRAND_GUIDE §8). */
  question: string;
  badge?: string;
};

export const workspaceNav: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: 'overview', question: 'What is happening now?' },
  { href: '/projects', label: 'Projects', icon: 'projects', question: 'Where is risk building?' },
  { href: '/agents', label: 'Live agents', icon: 'agents', question: 'Why is this thread stuck?' },
  {
    href: '/token-network',
    label: 'Token network',
    icon: 'network',
    question: 'How might capacity be coordinated?',
    badge: 'Concept only',
  },
];

export const controlPlaneNav: readonly NavItem[] = [
  {
    href: '/integrations',
    label: 'JGR & Integrations',
    icon: 'shield',
    question: 'Can I trust the incoming signal?',
  },
];

export const allNav = [...workspaceNav, ...controlPlaneNav];

const otherTitles: Record<string, string> = { '/sign-in': 'Sign in' };

export const titleFor = (pathname: string): string =>
  allNav.find((item) => item.href === pathname)?.label ?? otherTitles[pathname] ?? 'Overview';
