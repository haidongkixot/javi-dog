import type { ThreadIdentity } from '@javis-dog/realtime';
import { Card, CardHead } from '@javis-dog/ui/components';
import { ThreadRef } from '@/components/dashboard/signal';
import { LIMITS, ROLE_NOTE, STILL_SEES } from '@/lib/privacy/copy';
import { KeyEntry } from './key-entry';
import { KeySetup } from './key-setup';
import { LowerClass } from './lower-class';
import { PrivacyStatus } from './privacy-status';
import { ThreadIdentityLabel } from './thread-identity';

type PrivacyClass = 'L0' | 'L1' | 'L2';

const CLASS_SUMMARY: Record<PrivacyClass, string> = {
  L0: 'L0: operational metadata only. javi sends no repo, branch or folder names for this project.',
  L1: 'L1 set up. javi sends repo, branch and folder names only as keyed hashes made with the project’s recovery key. Javi’s Dog can’t reverse them.',
  L2: '',
};

/**
 * The project's privacy class and key controls (ADR-0018 §7–§9). Server-rendered text plus
 * client components; the key exists only in those client components.
 */
export function PrivacyCard({
  projectId,
  slug,
  privacyClass,
  canManage,
  identities,
}: {
  projectId: string;
  slug: string;
  privacyClass: PrivacyClass;
  canManage: boolean;
  /** This project's newest thread identities with L2 ciphertext (opaque, from JD-M07). */
  identities: ThreadIdentity[];
}) {
  const knownKids = [...new Set(identities.flatMap((i) => (i.encrypted ? [i.encrypted.kid] : [])))];
  return (
    <Card labelledBy="privacy-title">
      <CardHead
        id="privacy-title"
        title="Privacy"
        subtitle={`Class ${privacyClass} · what Javi’s Dog can and can’t see for this project`}
      />
      <div className="grid gap-5 px-5 pt-4 pb-5">
        {privacyClass === 'L2' ? (
          <PrivacyStatus projectId={projectId} projectSlug={slug} identities={identities} />
        ) : (
          <p className="text-sm font-bold text-ink">{CLASS_SUMMARY[privacyClass]}</p>
        )}

        {privacyClass !== 'L0' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <section aria-labelledby="still-sees-title">
              <h3 id="still-sees-title" className="text-xs font-bold text-ink">
                What Javi’s Dog still sees
              </h3>
              <ul className="mt-2 grid list-disc gap-1 pl-5 text-xs text-muted">
                {STILL_SEES.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="limits-title">
              <h3 id="limits-title" className="text-xs font-bold text-ink">
                Limits
              </h3>
              <ul className="mt-2 grid list-disc gap-1 pl-5 text-xs text-muted">
                {LIMITS.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>
          </div>
        ) : null}
        <p className="text-xs text-muted">{ROLE_NOTE}</p>

        {privacyClass === 'L2' ? (
          <>
            <KeyEntry projectId={projectId} slug={slug} knownKids={knownKids} />
            {identities.length > 0 ? (
              <section aria-labelledby="identity-list-title">
                <h3 id="identity-list-title" className="text-xs font-bold text-ink">
                  Newest threads with encrypted names (last 24 h)
                </h3>
                <ul className="mt-2 grid gap-1">
                  {identities.slice(0, 5).map((i) => (
                    <li key={`${i.threadRef}-${i.eventId}`} className="text-xs text-muted">
                      <ThreadRef value={i.threadRef} />{' '}
                      <ThreadIdentityLabel
                        projectId={projectId}
                        projectSlug={slug}
                        threadRef={i.threadRef}
                        identity={i}
                        className="inline text-xs text-ink"
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}

        {canManage ? (
          <>
            <KeySetup projectId={projectId} slug={slug} currentClass={privacyClass} />
            {privacyClass !== 'L0' ? (
              <LowerClass projectId={projectId} currentClass={privacyClass} />
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
