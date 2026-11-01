// User-facing results of the GitHub actions (ADR-0019 §4). Kept out of `actions.ts`: a
// 'use server' module may export async functions only.

export const CLAIM_MESSAGES = {
  claimed: 'Installation claimed. You can now link its repositories to projects.',
  already_yours: 'This workspace already holds this installation.',
  claimed_elsewhere:
    'Another workspace has already claimed this installation. It can be claimed again once that workspace releases it.',
  not_found:
    'We have no record of that installation. GitHub sends it right after the app is installed; reload in a minute.',
  organization:
    'Organization installations can’t be claimed yet. Javi’s Dog can only verify installations on your personal GitHub account for now.',
  account_mismatch:
    'This installation belongs to a different GitHub account than the one you signed in with.',
  no_github_account:
    'Sign in with GitHub first. A claim checks that the installation belongs to your GitHub account.',
} as const;

export const LINK_CONFIRM_REQUIRED =
  'This project uses L1 or L2. Confirm that Javi’s Dog may store which repository it is linked to.';
