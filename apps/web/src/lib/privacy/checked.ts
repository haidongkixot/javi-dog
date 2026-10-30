// "Checked" state per project and kid (ADR-0018 §9, D0 accepted Low): this browser decrypted an
// L2 event of the project with the right AAD at least once. Not secret: the kid is public (it is
// on every L2 event) and the time is the event's. Kept in localStorage so the label survives the
// reader's 24-hour window. Every access is guarded: storage can be missing or throw.

const PREFIX = 'jd.privacy.checked.v1.';
export const CHECKED_EVENT = 'jd-privacy-checked';
const VALID_KID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

type Checked = Record<string, string>;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** kid → ISO time of the newest event decrypted with it. */
export const readChecked = (projectId: string): Checked => {
  try {
    const raw = storage()?.getItem(PREFIX + projectId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([kid, at]) =>
          VALID_KID.test(kid) && typeof at === 'string' && !Number.isNaN(Date.parse(at)),
      ),
    ) as Checked;
  } catch {
    return {};
  }
};

/** G14: the kid of the newest successfully decrypted event, or null. */
export const newestChecked = (projectId: string): { kid: string; at: string } | null =>
  Object.entries(readChecked(projectId)).reduce<{ kid: string; at: string } | null>(
    (best, [kid, at]) => (!best || at > best.at ? { kid, at } : best),
    null,
  );

/**
 * Review L5: forgets the "checked" state of one project (its class changed) or of every project
 * (sign-out and any session clear). Only this module's own entries are removed.
 */
export const clearChecked = (projectId?: string) => {
  try {
    const s = storage();
    if (!s) return;
    const doomed =
      projectId !== undefined
        ? [PREFIX + projectId]
        : Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
            (k): k is string => k !== null && k.startsWith(PREFIX),
          );
    for (const key of doomed) s.removeItem(key);
  } catch {
    // Storage unavailable: nothing was persisted there either.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHECKED_EVENT));
};

/** Records a successful decryption; keeps the newest event time per kid. */
export const markChecked = (projectId: string, kid: string, at: string) => {
  if (!VALID_KID.test(kid) || Number.isNaN(Date.parse(at))) return;
  const current = readChecked(projectId);
  if (current[kid] !== undefined && current[kid] >= at) return;
  try {
    storage()?.setItem(PREFIX + projectId, JSON.stringify({ ...current, [kid]: at }));
  } catch {
    // Not persisted (private mode, quota): the label falls back to "not checked yet" next time.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHECKED_EVENT));
};
