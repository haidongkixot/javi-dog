// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { deriveProjectKeys, encryptL2, generateProjectSecret } from '@javis-dog/crypto';
import type { DashboardSnapshot, ThreadIdentity } from '@javis-dog/realtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsView } from '@/components/dashboard/agents-view';
import { OverviewView } from '@/components/dashboard/overview-view';
import { KeyStoreProvider } from '@/components/privacy/key-context';
import { PrivacyStatus } from '@/components/privacy/privacy-status';
import { ThreadIdentityLabel } from '@/components/privacy/thread-identity';
import { newestChecked } from '@/lib/privacy/checked';
import {
  LABEL_L2_NOT_CHECKED,
  LABEL_OTHER_KID,
  LABEL_UNVERIFIABLE,
  labelL2Checked,
} from '@/lib/privacy/copy';
import { cleanName, type L2EventRef } from '@/lib/privacy/identity';
import { createKeyStore, type KeyStore } from '@/lib/privacy/key-store';

// ADR-0018 §8 and §9 label states (TEST_PLAN §S5f browser rows, D0 M8) and the QA label vectors
// P03 and P04 (`docs/jgr/conformance/privacy/`, read from the repo, not from the crypto
// package's tests). jsdom for the DOM; WebCrypto is Node's engine, not a browser's.
// Screenshot budget 0: text assertions only.

const VECTORS = resolve(process.cwd(), '../../docs/jgr/conformance/privacy');
const vector = (name: string) => JSON.parse(readFileSync(resolve(VECTORS, name), 'utf8'));

const P1 = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-30T12:00:00.000Z';
/** Lets pending WebCrypto work (Node's thread pool) and effects finish before a negative check. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

let stores: KeyStore[] = [];
const newStore = () => {
  const s = createKeyStore({ persistence: null, channel: null });
  stores.push(s);
  return s;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  for (const s of stores) s.dispose();
  stores = [];
});

const identityFor = async (
  keys: Awaited<ReturnType<typeof deriveProjectKeys>>,
  payload: { repo?: string; branch?: string },
  over: Partial<ThreadIdentity> = {},
): Promise<ThreadIdentity> => {
  const base = {
    eventId: '01JBZ4XQ80000000000000001A',
    producerId: 'prod_x',
    threadRef: 'cc_t1',
    type: 'x.javi.thread.identity' as const,
    projectSlug: 'web-app',
  };
  const encrypted = await encryptL2(
    keys.l2Key,
    keys.kid,
    {
      eventId: base.eventId,
      slug: base.projectSlug,
      producerId: base.producerId,
      threadRef: base.threadRef,
      type: base.type,
    },
    payload,
  );
  return {
    ...base,
    privacyClass: 'L2',
    at: AT,
    repoHash: null,
    branchHash: null,
    cwdHash: null,
    encrypted,
    ...over,
  };
};

const Row = ({ identity, store }: { identity: ThreadIdentity | null; store: KeyStore }) => (
  <KeyStoreProvider store={store}>
    <div data-testid="row">
      <ThreadIdentityLabel projectId={P1} identity={identity} />
    </div>
  </KeyStoreProvider>
);

describe('ThreadIdentityLabel — states (ADR-0018 §8)', () => {
  it('shows "repo · branch" with the right key, and records the check', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    store.add(P1, keys.kid, keys.l2Key);
    render(
      <Row
        store={store}
        identity={await identityFor(keys, { repo: 'javi-dog', branch: 'main' })}
      />,
    );
    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe('javi-dog · main'));
    expect(newestChecked(P1)).toEqual({ kid: keys.kid, at: AT });
  });

  it('no key on this device: "Encrypted (key kid)", and nothing is checked', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    render(<Row store={newStore()} identity={await identityFor(keys, { repo: 'r' })} />);
    expect(text(screen.getByTestId('row'))).toBe(`Encrypted (key ${keys.kid})`);
    await settle();
    expect(text(screen.getByTestId('row'))).toBe(`Encrypted (key ${keys.kid})`);
    expect(newestChecked(P1)).toBeNull();
  });

  it('a key with another kid: "Can\'t decrypt with the key on this device"', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const other = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    store.add(P1, other.kid, other.l2Key);
    render(<Row store={store} identity={await identityFor(keys, { repo: 'r' })} />);
    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe(LABEL_OTHER_KID));
  });

  it('the right kid, changed data: "Can\'t verify this encrypted data (changed or damaged)"', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    store.add(P1, keys.kid, keys.l2Key);
    const id = await identityFor(keys, { repo: 'r' });
    // Shown under another thread: the AAD no longer matches (review M1).
    render(<Row store={store} identity={{ ...id, threadRef: 'cc_other' }} />);
    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe(LABEL_UNVERIFIABLE));
    expect(newestChecked(P1)).toBeNull();
  });

  it('an encrypted object on an event that is not L2 is never decrypted', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    store.add(P1, keys.kid, keys.l2Key);
    const id = await identityFor(keys, { repo: 'r' }, { privacyClass: 'L1' });
    render(<Row store={store} identity={id} />);
    await settle();
    expect(text(screen.getByTestId('row'))).toBe(LABEL_UNVERIFIABLE);
    expect(newestChecked(P1)).toBeNull();
  });

  it('renders nothing for L0 threads and for L1 identities (hashes only)', async () => {
    const { container, rerender } = render(<Row store={newStore()} identity={null} />);
    expect(text(container)).toBe('');
    const l1: ThreadIdentity = {
      eventId: '01JBZ4XQ80000000000000001A',
      producerId: 'p',
      threadRef: 't',
      type: 'x.javi.thread.identity',
      projectSlug: 'web-app',
      privacyClass: 'L1',
      at: AT,
      repoHash: `sha256:${'a'.repeat(64)}`,
      branchHash: null,
      cwdHash: null,
      encrypted: null,
    };
    rerender(<Row store={newStore()} identity={l1} />);
    await settle();
    expect(text(container)).toBe('');
  });

  it('switches from "Encrypted" to the names as soon as a key is added', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    render(<Row store={store} identity={await identityFor(keys, { branch: 'main' })} />);
    expect(text(screen.getByTestId('row'))).toBe(`Encrypted (key ${keys.kid})`);
    act(() => store.add(P1, keys.kid, keys.l2Key));
    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe('main'));
  });

  it('renders names as text, never as HTML', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const store = newStore();
    store.add(P1, keys.kid, keys.l2Key);
    render(
      <Row
        store={store}
        identity={await identityFor(keys, { repo: '<img src=x onerror=alert(1)>' })}
      />,
    );
    await waitFor(() =>
      expect(text(screen.getByTestId('row'))).toBe('<img src=x onerror=alert(1)>'),
    );
    expect(screen.getByTestId('row').querySelector('img')).toBeNull();
  });

  it('cleanName removes bidi and control characters and keeps everything else', () => {
    const bidi = [0x202e, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c, 0x202a, 0x0007]
      .map((c) => String.fromCodePoint(c))
      .join('');
    expect(cleanName(`a${bidi}b`)).toBe('ab');
    const astral = `feat/${String.fromCodePoint(0x1f436)}`;
    expect(cleanName(astral)).toBe(astral);
  });
});

describe('PrivacyStatus — project label (ADR-0018 §9)', () => {
  it('says "not checked" until a decryption, then the scoped label, and keeps it after a reload', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const id = await identityFor(keys, { repo: 'r' });
    const store = newStore();
    const { unmount } = render(
      <KeyStoreProvider store={store}>
        <PrivacyStatus projectId={P1} identities={[id]} />
      </KeyStoreProvider>,
    );
    expect(text(screen.getByRole('status'))).toBe(LABEL_L2_NOT_CHECKED);
    act(() => store.add(P1, keys.kid, keys.l2Key));
    await waitFor(() => expect(text(screen.getByRole('status'))).toBe(labelL2Checked(keys.kid)));
    unmount();
    // Reload: a new tab store without keys; the remembered check stays (per project and kid).
    render(
      <KeyStoreProvider store={newStore()}>
        <PrivacyStatus projectId={P1} identities={[]} />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(text(screen.getByRole('status'))).toBe(labelL2Checked(keys.kid)));
  });

  it('G14: after a rotation, names the kid of the newest decrypted event', async () => {
    const old = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const next = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const a = await identityFor(old, { repo: 'r' }, { at: '2026-10-30T10:00:00.000Z' });
    const b = await identityFor(
      next,
      { repo: 'r' },
      { at: '2026-10-30T11:00:00.000Z', threadRef: 'cc_t1' },
    );
    const store = newStore();
    store.add(P1, old.kid, old.l2Key);
    store.add(P1, next.kid, next.l2Key);
    render(
      <KeyStoreProvider store={store}>
        <PrivacyStatus projectId={P1} identities={[a, b]} />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(text(screen.getByRole('status'))).toBe(labelL2Checked(next.kid)));
  });

  it('label strings are the ADR’s exact wording', () => {
    expect(LABEL_L2_NOT_CHECKED).toBe('L2 set up. No encrypted event checked yet.');
    expect(labelL2Checked('0Q12NAV3')).toBe(
      "Repo and branch names from javi are encrypted on your machine (key 0Q12NAV3). Javi's Dog stores them only as ciphertext and can't read them. They are decrypted here, in your browser.",
    );
    expect(LABEL_OTHER_KID).toBe("Can't decrypt with the key on this device");
    expect(LABEL_UNVERIFIABLE).toBe("Can't verify this encrypted data (changed or damaged)");
  });
});

// ---------------------------------------------------------------------------------------------
// QA conformance vectors P03 and P04 (docs/jgr/conformance/privacy/README.md "label" and
// "label-sequence" runners).
// ---------------------------------------------------------------------------------------------

interface DeviceKey {
  secretHex: string;
  slug: string;
}
interface VectorEvent {
  event_id: string;
  project_slug: string;
  producer_id: string;
  thread_ref: string;
  type: string;
  privacy_class: string;
  encrypted: { alg: string; kid: string; iv: string; ciphertext: string } | null;
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

/** The project id in this runner is the slug: keys and the checked state are per project. */
const loadKeys = async (store: KeyStore, deviceKeys: DeviceKey[]) => {
  for (const k of deviceKeys) {
    const derived = await deriveProjectKeys(hex(k.secretHex), k.slug);
    store.add(k.slug, derived.kid, derived.l2Key);
  }
};

const toRef = (e: VectorEvent, at = AT): L2EventRef & { at: string } => ({
  eventId: e.event_id,
  producerId: e.producer_id,
  threadRef: e.thread_ref,
  type: e.type,
  projectSlug: e.project_slug,
  privacyClass: e.privacy_class,
  encrypted: e.encrypted,
  at,
});

const p03 = vector('P03-thread-labels.json') as {
  cases: Array<{
    label: string;
    deviceKeys: DeviceKey[];
    event: VectorEvent;
    expect: { state: string; threadText: string };
  }>;
};

describe('conformance P03 — thread text', () => {
  it('has the 11 cases the README lists', () => {
    expect(p03.cases).toHaveLength(11);
  });

  it.each(p03.cases.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    const store = newStore();
    await loadKeys(store, c.deviceKeys);
    const ref = toRef(c.event);
    const identity = { ...ref, repoHash: null, branchHash: null, cwdHash: null } as ThreadIdentity;
    render(
      <KeyStoreProvider store={store}>
        <div data-testid="row">
          <ThreadIdentityLabel projectId={c.event.project_slug} identity={identity} />
        </div>
      </KeyStoreProvider>,
    );
    await settle();
    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe(c.expect.threadText));
  });
});

const p04 = vector('P04-project-label.json') as {
  project: { slug: string; privacyClass: string; kid: string };
  sequences: Array<{
    label: string;
    steps: Array<{
      action: 'open' | 'decrypt' | 'reload';
      note: string;
      deviceKeys: DeviceKey[];
      event: VectorEvent | null;
      expect: { projectLabel: string };
    }>;
  }>;
};

describe('conformance P04 — project label sequences', () => {
  it('has 8 steps across its sequences, as the README lists', () => {
    expect(p04.sequences.flatMap((s) => s.steps)).toHaveLength(8);
  });

  for (const sequence of p04.sequences) {
    it.each(sequence.steps.map((s, i) => [`${sequence.label} #${i + 1} ${s.action}`, i] as const))(
      '%s',
      async (_name, upTo) => {
        // One fresh browser profile per sequence: replay the steps up to this one.
        localStorage.clear();
        const project = p04.project.slug;
        let last = '';
        for (const step of sequence.steps.slice(0, upTo + 1)) {
          cleanup();
          // Every step is a tab state: `decrypt` holds exactly `deviceKeys`; open/reload none.
          const store = newStore();
          await loadKeys(store, step.deviceKeys);
          const event = step.event;
          const own = event && event.project_slug === project ? [toRef(event)] : [];
          render(
            <KeyStoreProvider store={store}>
              <div data-testid="label">
                <PrivacyStatus projectId={project} identities={own} />
              </div>
              {event && event.project_slug !== project ? (
                // Another project's event is shown under that project; it never checks this one.
                <PrivacyStatus projectId={event.project_slug} identities={[toRef(event)]} />
              ) : null}
            </KeyStoreProvider>,
          );
          await settle();
          await waitFor(() =>
            expect(text(screen.getByTestId('label'))).toBe(step.expect.projectLabel),
          );
          last = text(screen.getByTestId('label'));
        }
        expect(last).toBe(sequence.steps[upTo]!.expect.projectLabel);
      },
    );
  }
});

describe('dashboard rows show the identity (ADR-0018 §8)', () => {
  const snapshotWith = (identity: ThreadIdentity): DashboardSnapshot => ({
    generatedAt: AT,
    freshnessWindowMs: 180_000,
    windowHours: 24,
    overview: {
      activeProjects: { value: 1, lastSignalAt: AT },
      agentsWorking: { value: 1, lastSignalAt: AT },
      tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
      tasksCompleted24h: { value: 0, lastSignalAt: null },
    },
    threads: [
      {
        projectId: P1,
        projectSlug: 'web-app',
        projectName: 'Web app',
        threadRef: identity.threadRef,
        status: 'working',
        statusSource: 'collector',
        statusReason: null,
        lastType: 'heartbeat',
        firstSignalAt: AT,
        lastSignalAt: AT,
        freshness: 'fresh',
        attention: false,
        needsAttention: false,
        agents: 1,
        tasksCompleted: 0,
        inputTokens: 0,
        outputTokens: 0,
        identity,
      },
    ],
    activity: [
      {
        at: AT,
        projectSlug: 'web-app',
        threadRef: identity.threadRef,
        type: 'heartbeat',
        status: 'working',
        toolName: null,
        statusSource: 'collector',
        statusReason: null,
      },
    ],
    projects: [],
  });

  it('overview squad and activity feed, then the agents table: the label without a key, names with it', async () => {
    const keys = await deriveProjectKeys(generateProjectSecret(), 'web-app');
    const s = snapshotWith(await identityFor(keys, { repo: 'javi-dog', branch: 'main' }));
    const store = newStore();
    const { unmount } = render(
      <KeyStoreProvider store={store}>
        <OverviewView snapshot={s} />
      </KeyStoreProvider>,
    );
    const squad = screen.getByRole('list', { name: 'Fresh threads' });
    const feed = screen.getByRole('list', { name: 'Recent signals' });
    expect(squad.textContent).toContain(`Encrypted (key ${keys.kid})`);
    expect(feed.textContent).toContain(`Encrypted (key ${keys.kid})`);
    act(() => store.add(P1, keys.kid, keys.l2Key));
    await waitFor(() => expect(within(squad).getByText('javi-dog · main')).toBeTruthy());
    await waitFor(() => expect(within(feed).getByText('javi-dog · main')).toBeTruthy());
    unmount();

    render(
      <KeyStoreProvider store={store}>
        <AgentsView snapshot={s} inspector={null} />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(screen.getByRole('table').textContent).toContain('javi-dog · main'));
  });
});
