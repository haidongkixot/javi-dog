// User-facing results of the GitHub actions (ADR-0019 §4). Kept out of `actions.ts`: a
// 'use server' module may export async functions only.

export const CLAIM_MESSAGES = {
  claimed: 'Installation claimed. You can now link its repositories to projects.',
  already_yours: 'This workspace already holds this installation.',
  claimed_elsewhere:
    'Another workspace has already claimed this installation. It can be claimed again once that workspace releases it.',
  organization:
    'Organization installations aren’t supported yet. Install the app on your personal GitHub account instead.',
  // One answer for an unknown id and for another account's installation (review L-2).
  account_mismatch:
    'Your GitHub account has no installation with that id. If you just installed the app, reload in a minute: GitHub’s signed notice may still be on its way.',
  no_github_account:
    'Sign in with GitHub first. A claim checks that the installation belongs to your GitHub account.',
} as const;

export const LINK_CONFIRM_REQUIRED =
  'This project uses L1 or L2. Confirm that Javi’s Dog may store which repository it is linked to.';
