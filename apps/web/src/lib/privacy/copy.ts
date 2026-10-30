// User-facing privacy copy (ADR-0018 §7, §8, §9 and the D0 review). The label strings are the
// ADR's exact wording; tests import them from here so a change is a deliberate, reviewed edit.
// Never "secure", "zero-knowledge" or "end-to-end" (ADR-0018 §9).

/** ADR-0018 §8: no key for that `kid` is loaded (G9: no key for this project in the tab). */
export const LABEL_NO_KEY_PREFIX = 'Encrypted (key ';
export const labelNoKey = (kid: string) => `${LABEL_NO_KEY_PREFIX}${kid})`;
/** ADR-0018 §8: keys are loaded, none with this `kid` (G9). */
export const LABEL_OTHER_KID = "Can't decrypt with the key on this device";
/** ADR-0018 §8, review M8: the right `kid`, but authentication fails (or G10). */
export const LABEL_UNVERIFIABLE = "Can't verify this encrypted data (changed or damaged)";

/** ADR-0018 §9: until this browser decrypted an L2 event of the project with the right AAD. */
export const LABEL_L2_NOT_CHECKED = 'L2 set up. No encrypted event checked yet.';
/** ADR-0018 §9: after a successful AAD-verified decryption in this browser (scoped wording). */
export const labelL2Checked = (kid: string) =>
  `Repo and branch names from javi are encrypted on your machine (key ${kid}). Javi's Dog stores them only as ciphertext and can't read them. They are decrypted here, in your browser.`;

/** ADR-0018 §9: what Javi's Dog still sees in an L1 or L2 project. */
export const STILL_SEES = [
  'Status, timing, token counts and event sizes.',
  'Which threads share a repo, branch or folder (L1 hash equality).',
  'The sender’s IP address.',
] as const;

/** ADR-0018 §9: the two limits. */
export const LIMITS = [
  'The code that decrypts is served by Javi’s Dog, so a compromised deploy could read keys.',
  'Anyone holding the key can read the names, whatever their role in the workspace.',
] as const;

/** D0 accepted Low "the role note". */
export const ROLE_NOTE =
  'Only workspace owners and admins can change the privacy class. The key is not tied to a role: anyone you give it to can read the names.';

/** ADR-0018 §1: said before a key is generated. */
export const LOST_KEY_WARNING =
  'Javi’s Dog never receives this key and can’t recover it. If you lose it, the repo and branch names sent with it can’t be read anymore.';

/** ADR-0018 §6 guidance, shown once the class is raised. */
export const COLLECTOR_GUIDANCE =
  'Run javi init --privacy yourself, in a terminal, on each machine, and paste the key at its hidden prompt. Never paste the key into an agent chat or an agent’s command: it would land in the model provider’s transcript.';

/**
 * Review L1: the clearing note while "Remember on this device" is off (`remember-gate.ts`).
 * Keys live only in the tab's memory, so it never mentions remembering.
 */
export const TAB_ONLY_CLEARING_NOTE =
  'Keys stay in this tab’s memory only: reloading or closing the tab forgets them. Signing out, here or in another tab, forgets them too, and so does any page that finds you signed out.';

/** ADR-0018 §8: Safari may evict stored keys. Shown only while remembering is offered. */
export const SAFARI_NOTE =
  'Safari may delete keys remembered on this device after 7 days without a visit.';

/**
 * Shown only while "Remember on this device" is offered (review L1); otherwise
 * `TAB_ONLY_CLEARING_NOTE`. Review M2: exactly the clearing paths the app has. The sign-out button (and the notice it
 * sends to other tabs), any signed-out page (`SignInPrompt`, `/sign-in`, the account menu with
 * no session, a 401 from the dashboard) and another account's remembered keys on hydrate.
 */
export const CLEARING_NOTE =
  'Signing out, here or in another tab, forgets every key in this browser, remembered ones included. So does any page that finds you signed out, for example after your session expires. Keys remembered under another account are deleted, never loaded.';

export const PASTE_MISMATCH = 'This is not the key shown above. Paste the full key you saved.';

/** Lowering warning (ADR-0018 §7 and D0 H1). `above` names the classes that will be refused. */
export const lowerWarning = (target: 'L0' | 'L1') => {
  const above = target === 'L0' ? 'L1 and L2' : 'L2';
  return [
    `Events already stored as ${above} stay as they are. From now on, new ${above} events for this project are rejected.`,
    'Status signals keep arriving: javi always sends them as L0. Only the identity events that carry repo and branch names are rejected, and javi status shows the code privacy_class_not_allowed.',
    // Review L4: say plainly what `javi init --privacy L0` deletes and what that costs.
    target === 'L0'
      ? 'Run javi init --privacy L0 on each machine to stop sending them. It deletes that machine’s copy of the recovery key: without another copy (your password manager or the downloaded file), repo and branch names already stored as L2 can’t be read anymore.'
      : 'Run javi init --privacy L1 on each machine to stop sending encrypted names.',
  ] as const;
};
