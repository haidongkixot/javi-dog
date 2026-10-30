// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENTINEL_BODY, SENTINEL_HEX, SENTINEL_SECRET, findSentinel } from './privacy-sentinel';

// ADR-0018 §1, §7, §8 and D0 M5/M6/M8 (TEST_PLAN §S5f rows "Key input attributes and full
// paste-back", "Key never reaches the server", "Class change", "Browser: memory by default").
// The key setup flow, key entry and lowering, with the server action mocked at its module
// boundary. A sentinel key (fixed bytes) is searched in every action argument, request body,
// console line and the DOM after the key is hidden. jsdom + Node WebCrypto. Screenshot budget 0.

const changePrivacyClassAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/projects/actions', () => ({ changePrivacyClassAction }));
// The browser's CSPRNG is replaced by the sentinel for the setup flow only.
const sentinelNext = vi.hoisted(() => ({ value: true }));
vi.mock('@javis-dog/crypto', async (orig) => {
  const real = await orig<typeof import('@javis-dog/crypto')>();
  return {
    ...real,
    generateProjectSecret: () =>
      sentinelNext.value ? SENTINEL_SECRET.slice() : real.generateProjectSecret(),
  };
});

const crypto = await import('@javis-dog/crypto');
const { KeyStoreProvider } = await import('@/components/privacy/key-context');
const { KeySetup } = await import('@/components/privacy/key-setup');
const { KeyEntry } = await import('@/components/privacy/key-entry');
const { LowerClass } = await import('@/components/privacy/lower-class');
const { createKeyStore } = await import('@/lib/privacy/key-store');
/** Review L1: remembering ships off; these tests force the gate on to test the logic. */
const REMEMBER_ON = { rememberEnabled: true } as const;
const { PASTE_MISMATCH, TAB_ONLY_CLEARING_NOTE, lowerWarning } = await import('@/lib/privacy/copy');

const PROJECT = '22222222-2222-4222-8222-222222222222';
const SLUG = 'web-app';

type Store = ReturnType<typeof createKeyStore>;
let store: Store;
let captured: string[];
let requests: string[];
let consoleLines: string[];

const memoryPersistence = () => {
  const rows: unknown[] = [];
  return {
    rows,
    load: vi.fn(async () => []),
    save: vi.fn(async (k: unknown) => void rows.push(k)),
    remove: vi.fn(async () => void rows.splice(0)),
    clear: vi.fn(async () => void rows.splice(0)),
  };
};

beforeEach(() => {
  sentinelNext.value = true;
  store = createKeyStore({ persistence: memoryPersistence(), channel: null });
  changePrivacyClassAction.mockResolvedValue({ privacyClass: 'L2' });
  captured = [];
  requests = [];
  consoleLines = [];
  // Every request body the page could send.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      requests.push(
        `${String(input)} ${typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? null)}`,
      );
      return new Response('{}');
    }),
  );
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((url: string, body: unknown) => {
      requests.push(`${url} ${String(body)}`);
      return true;
    }),
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => {
  cleanup();
  store.dispose();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSetup = (currentClass: 'L0' | 'L1' | 'L2' = 'L0') =>
  render(
    <KeyStoreProvider store={store}>
      <KeySetup projectId={PROJECT} slug={SLUG} currentClass={currentClass} />
    </KeyStoreProvider>,
  );

const keyInput = () => screen.getByLabelText('Recovery key') as HTMLInputElement;

const leaks = () => {
  const actionArgs = changePrivacyClassAction.mock.calls.map((c) => JSON.stringify(c));
  return {
    actionArgs: actionArgs.flatMap(findSentinel),
    requests: requests.flatMap(findSentinel),
    console: consoleLines.flatMap(findSentinel),
    captured: captured.flatMap(findSentinel),
  };
};

const expectNoLeak = () =>
  expect(leaks()).toEqual({ actionArgs: [], requests: [], console: [], captured: [] });

const assertKeyFieldAttributes = (input: HTMLInputElement) => {
  expect(input.type).toBe('password');
  expect(input.getAttribute('autocomplete')).toBe('off');
  expect(input.getAttribute('spellcheck')).toBe('false');
  expect(input.getAttribute('autocapitalize')).toBe('off');
  expect(input.hasAttribute('name')).toBe(false);
  expect(input.closest('form')).toBeNull();
};

const goToConfirm = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Generate recovery key' }));
  const shown = await screen.findByText(/^JDK1-/);
  const key = shown.textContent ?? '';
  fireEvent.click(screen.getByRole('button', { name: 'I saved it, hide the key' }));
  return key;
};

describe('sentinel search', () => {
  it('finds the sentinel as hex, as base32 body, partially and reformatted', async () => {
    const key = await crypto.encodeRecoveryKey(SENTINEL_SECRET);
    expect(findSentinel(key).length).toBeGreaterThan(0);
    expect(findSentinel(key.toLowerCase().replace(/-/g, ' ')).length).toBeGreaterThan(0);
    expect(findSentinel(SENTINEL_HEX.toUpperCase()).length).toBeGreaterThan(0);
    expect(findSentinel(`x${SENTINEL_HEX.slice(20, 40)}x`).length).toBeGreaterThan(0);
    expect(findSentinel(SENTINEL_BODY.slice(30, 45)).length).toBeGreaterThan(0);
    expect(findSentinel(Buffer.from(SENTINEL_SECRET).toString('base64'))).not.toEqual([]);
    expect(findSentinel('nothing to see here, JDK1-0000-1111')).toEqual([]);
  });
});

describe('key setup flow (owner or admin)', () => {
  it('generate → shown once with copy and download → hidden → full paste-back → class only to the server', async () => {
    renderSetup();
    expect(screen.getByText(/can’t recover it/)).toBeTruthy();
    const key = await goToConfirm();
    expect(key).toBe(await crypto.encodeRecoveryKey(SENTINEL_SECRET));
    // Hidden: the key text is no longer anywhere in the page.
    captured.push(document.body.innerHTML);
    expect(findSentinel(document.body.innerHTML)).toEqual([]);
    assertKeyFieldAttributes(keyInput());
    expect(changePrivacyClassAction).not.toHaveBeenCalled();

    // Pasted with other case and spaces instead of dashes: parsing ignores both.
    keyInput().value = key.toLowerCase().replace(/-/g, ' ');
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L2' }));
    await screen.findByText('L2 is on for this project.', { exact: false });

    expect(changePrivacyClassAction).toHaveBeenCalledExactlyOnceWith(PROJECT, 'L2');
    const kid = (await crypto.deriveProjectKeys(SENTINEL_SECRET, SLUG)).kid;
    expect(store.list(PROJECT)).toEqual([{ kid, remembered: false }]);
    expect(screen.getByRole('status').textContent).toContain(`Key ${kid} is loaded in this tab.`);
    expect(screen.getByRole('status').textContent).toContain('javi init --privacy L2');
    captured.push(document.body.innerHTML);
    expectNoLeak();
  });

  it('refuses a different (valid) key and never calls the action', async () => {
    renderSetup();
    await goToConfirm();
    sentinelNext.value = false;
    keyInput().value = await crypto.encodeRecoveryKey(crypto.generateProjectSecret());
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L2' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', PASTE_MISMATCH);
    expect(changePrivacyClassAction).not.toHaveBeenCalled();
    expect(store.list(PROJECT)).toEqual([]);
  });

  it('refuses a typo and a partial key (only the checksum part) with fixed messages', async () => {
    renderSetup();
    const key = await goToConfirm();
    const groups = key.split('-');
    // One character changed in the body.
    const typo = [...groups];
    typo[3] = typo[3]!.replace(/./, (c) => (c === 'A' ? 'B' : 'A'));
    keyInput().value = typo.join('-');
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L2' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/typo|not allowed/);
    // Review M5: the last 4 characters alone prove nothing.
    keyInput().value = groups.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L2' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).not.toBe(alert.textContent ?? 'x'),
    );
    expect(changePrivacyClassAction).not.toHaveBeenCalled();
    for (const message of [screen.getByRole('alert').textContent ?? '']) {
      expect(findSentinel(message)).toEqual([]);
    }
  });

  it('keeps the class and the key out of the tab when the action refuses', async () => {
    changePrivacyClassAction.mockResolvedValue({
      error: 'Only workspace owners and admins can change the privacy class.',
    });
    renderSetup();
    const key = await goToConfirm();
    keyInput().value = key;
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L2' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only workspace owners and admins can change the privacy class.',
    );
    expect(store.list(PROJECT)).toEqual([]);
    expectNoLeak();
  });

  it('offers L1 and L2 from L0, and sends only the chosen class', async () => {
    changePrivacyClassAction.mockResolvedValue({ privacyClass: 'L1' });
    renderSetup('L0');
    fireEvent.click(screen.getByLabelText(/^L1:/));
    const key = await goToConfirm();
    keyInput().value = key;
    fireEvent.click(screen.getByRole('button', { name: 'Check key and turn on L1' }));
    await screen.findByText('L1 is on for this project.', { exact: false });
    expect(changePrivacyClassAction).toHaveBeenCalledExactlyOnceWith(PROJECT, 'L1');
  });

  it('rotation in an L2 project changes nothing on the server', async () => {
    renderSetup('L2');
    const key = await goToConfirm();
    keyInput().value = key;
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('New recovery key confirmed.', { exact: false });
    expect(changePrivacyClassAction).not.toHaveBeenCalled();
    expect(store.list(PROJECT)).toHaveLength(1);
  });

  it('copy writes the key to the clipboard only; download makes a local file', async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ href: this.href, download: this.download });
    });
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Generate recovery key' }));
    const key = (await screen.findByText(/^JDK1-/)).textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(key);
    fireEvent.click(screen.getByRole('button', { name: 'Download as a file' }));
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe('javis-dog-web-app-recovery-key.txt');
    // A local blob or data URL, never a request to the server.
    expect(clicks[0]!.href).toMatch(/^(blob:|data:text\/plain)/);
    expect(requests).toEqual([]);
    // The anchor is removed again.
    expect(document.querySelector('a[download]')).toBeNull();
  });
});

describe('key entry for reading', () => {
  const renderEntry = (s: Store = store) =>
    render(
      <KeyStoreProvider store={s}>
        <KeyEntry projectId={PROJECT} slug={SLUG} knownKids={[]} />
      </KeyStoreProvider>,
    );

  it('has the review M6 attributes and is not inside a form', () => {
    renderEntry();
    assertKeyFieldAttributes(keyInput());
    expect(document.querySelector('form')).toBeNull();
  });

  it('keeps a key in memory only by default, and clears the field', async () => {
    const persistence = memoryPersistence();
    const s = createKeyStore({ persistence, channel: null, ...REMEMBER_ON });
    renderEntry(s);
    keyInput().value = await crypto.encodeRecoveryKey(SENTINEL_SECRET);
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    const kid = (await crypto.deriveProjectKeys(SENTINEL_SECRET, SLUG)).kid;
    await screen.findByText(`Key ${kid} loaded in this tab.`, { exact: false });
    expect(keyInput().value).toBe('');
    expect(s.list(PROJECT)).toEqual([{ kid, remembered: false }]);
    expect(persistence.save).not.toHaveBeenCalled();
    captured.push(document.body.innerHTML);
    expectNoLeak();
    s.dispose();
  });

  it('"Remember on this device" (ticked) stores the non-extractable key; "Forget" removes it', async () => {
    const persistence = memoryPersistence();
    const s = createKeyStore({ persistence, channel: null, ...REMEMBER_ON });
    s.setUser('user-1');
    renderEntry(s);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember on this device' }));
    keyInput().value = await crypto.encodeRecoveryKey(SENTINEL_SECRET);
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    const kid = (await crypto.deriveProjectKeys(SENTINEL_SECRET, SLUG)).kid;
    await screen.findByText(`Key ${kid} remembered on this device.`, { exact: false });
    expect(persistence.save).toHaveBeenCalledOnce();
    const saved = persistence.save.mock.calls[0]![0] as { kid: string; l2Key: CryptoKey };
    expect(saved.kid).toBe(kid);
    expect(saved.l2Key.extractable).toBe(false);
    // What reaches the device store has no secret in it.
    expect(findSentinel(JSON.stringify(saved))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Forget on this device' }));
    await screen.findByText('Keys for this project are forgotten on this device.');
    expect(s.list(PROJECT)).toEqual([]);
    expect(persistence.remove).toHaveBeenCalledWith(PROJECT);
    s.dispose();
  });

  it('shows the checksum message for a typo and stores nothing', async () => {
    renderEntry();
    keyInput().value = `${(await crypto.encodeRecoveryKey(SENTINEL_SECRET)).slice(0, -1)}0`;
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/checksum|not allowed/);
    expect(store.list(PROJECT)).toEqual([]);
    expectNoLeak();
  });

  it('without device storage, offers no remember option and says so (gate forced on)', () => {
    const s = createKeyStore({ persistence: null, channel: null, ...REMEMBER_ON });
    renderEntry(s);
    expect(screen.queryByRole('checkbox', { name: 'Remember on this device' })).toBeNull();
    expect(screen.getByText(/can’t remember keys/)).toBeTruthy();
    s.dispose();
  });

  it('review L1: with the gate off (default), no remember option and no copy about remembering', async () => {
    const persistence = memoryPersistence();
    const s = createKeyStore({ persistence, channel: null });
    s.setUser('user-1');
    renderEntry(s);
    const section = screen.getByRole('region', { name: 'Read encrypted names in this browser' });
    expect(within(section).queryByRole('checkbox')).toBeNull();
    expect(within(section).queryByRole('button', { name: /remember/i })).toBeNull();
    expect(section.textContent).not.toMatch(/remember|safari/i);
    expect(section.textContent).toContain(TAB_ONLY_CLEARING_NOTE);
    // Using a key keeps it in this tab only; nothing reaches the device store.
    keyInput().value = await crypto.encodeRecoveryKey(SENTINEL_SECRET);
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    const kid = (await crypto.deriveProjectKeys(SENTINEL_SECRET, SLUG)).kid;
    await screen.findByText(`Key ${kid} loaded in this tab.`, { exact: false });
    expect(section.textContent).not.toMatch(/remember/i);
    expect(persistence.save).not.toHaveBeenCalled();
    s.dispose();
  });

  it('states the clearing paths and the Safari 7-day note (gate forced on)', () => {
    const s = createKeyStore({ persistence: memoryPersistence(), channel: null, ...REMEMBER_ON });
    renderEntry(s);
    const text = document.body.textContent ?? '';
    // Review M2: exactly the clearing paths that exist (sign-out here or in another tab, any
    // signed-out page, another account's remembered keys).
    expect(text).toContain(
      'Signing out, here or in another tab, forgets every key in this browser, remembered ones included. So does any page that finds you signed out, for example after your session expires. Keys remembered under another account are deleted, never loaded.',
    );
    expect(text).toContain(
      'Safari may delete keys remembered on this device after 7 days without a visit.',
    );
    s.dispose();
  });
});

describe('lowering the class', () => {
  it('shows the ADR-0018 §7 / D0 H1 warning first, then sends only the lower class', async () => {
    changePrivacyClassAction.mockResolvedValue({ privacyClass: 'L0' });
    render(<LowerClass projectId={PROJECT} currentClass="L2" />);
    expect(changePrivacyClassAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Lower to L0…' }));
    const group = screen.getByRole('group', { name: 'Lower to L0' });
    for (const line of lowerWarning('L0')) expect(within(group).getByText(line)).toBeTruthy();
    expect(group.textContent).toContain('stay as they are');
    expect(group.textContent).toContain('new L1 and L2 events for this project are rejected');
    expect(group.textContent).toContain('Status signals keep arriving');
    expect(changePrivacyClassAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Lower to L0 now' }));
    await screen.findByText('Privacy class lowered to L0.');
    expect(changePrivacyClassAction).toHaveBeenCalledExactlyOnceWith(PROJECT, 'L0');
  });

  it('from L2 offers L1 and L0; from L1 only L0', () => {
    const { unmount } = render(<LowerClass projectId={PROJECT} currentClass="L2" />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Lower to L1…',
      'Lower to L0…',
    ]);
    unmount();
    render(<LowerClass projectId={PROJECT} currentClass="L1" />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Lower to L0…']);
  });
});
