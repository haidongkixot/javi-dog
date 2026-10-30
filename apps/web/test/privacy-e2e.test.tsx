// @vitest-environment jsdom
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { format } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  deriveProjectKeys,
  encodeRecoveryKey,
  generateProjectSecret,
  l1Hash,
  parseRecoveryKey,
} from '@javis-dog/crypto';
import { schema } from '@javis-dog/event-store';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { createDashboardReader, type ThreadIdentity } from '@javis-dog/realtime';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KeyStoreProvider } from '@/components/privacy/key-context';
import { KeyEntry } from '@/components/privacy/key-entry';
import { PrivacyStatus } from '@/components/privacy/privacy-status';
import { ThreadIdentityLabel } from '@/components/privacy/thread-identity';
import { newestChecked } from '@/lib/privacy/checked';
import {
  LABEL_L2_NOT_CHECKED,
  LABEL_OTHER_KID,
  LABEL_UNVERIFIABLE,
  labelL2Checked,
  labelNoKey,
} from '@/lib/privacy/copy';
import { resolveIdentity } from '@/lib/privacy/identity';
import { createKeyStore, type KeyStore } from '@/lib/privacy/key-store';

// S5f K5, TEST_PLAN §S5f rows "End to end: init --privacy L2 → hook → ingest (PGlite) → reader →
// decrypt → checked" and "Lowering the class keeps the status signal" (ADR-0018 §5–§9, D0 H1).
// Every piece is the real one, chained with no stub between them:
//   JD-M04 projects repository (workspace, project, setPrivacyClass, ingest token)
//   → JD-M11 recovery key → `javi init --privacy L2 --privacy-key-file` (JD-C01 `main()`)
//   → the real JD-M05 ingest handler behind a local node:http server (the collector's own fetch)
//   → PGlite with the committed migrations (JD-M06)
//   → Claude Code hook payloads SessionStart → UserPromptSubmit → `javi flush`
//   → the JD-M07 dashboard reader snapshot
//   → the web app's own key entry, key store, decryption and label code (JD-APP), in jsdom.
// jsdom for the DOM; WebCrypto is Node's engine, not a browser's. Screenshot budget 0.

/**
 * The JD-C01 public entry (`@javis-dog/collector-claude-code`, `src/index.ts`), loaded at run time
 * through a non-literal specifier so the web app's `tsc` does not type-check the collector's
 * sources: under Next.js's global `ProcessEnv` (required `NODE_ENV`), `collectors/claude-code/
 * src/run.ts` (`deps.env ?? {}`) does not compile. The module is the real one; only its type is
 * narrowed here to the parts of `main` and `Io` this test uses.
 */
interface CollectorIo {
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  spawnFlush: (projectRef: string) => void;
  spawnReceiver: () => void;
}
const COLLECTOR = '@javis-dog/collector-claude-code';
const { main } = (await import(/* @vite-ignore */ COLLECTOR)) as {
  main: (argv: string[], io: CollectorIo) => Promise<number>;
};

const SLUG = 'e2e-shop';
const OTHER_SLUG = 'e2e-other';
const REPO = 'my-repo';
const BRANCH = 'feature/x';
const PROMPT = 'PROMPT_TEXT_S5F_E2E_7c1d please ship';

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** Lets pending WebCrypto work (Node's thread pool) and effects finish before a negative check. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

const windows = (s: string, size: number) =>
  Array.from({ length: Math.max(0, s.length - size + 1) }, (_, i) => s.slice(i, i + size));

/**
 * Every spelling of the recovery key a leak could take (D0 M8): the full key, the decoded bytes
 * as hex and the base32 body as substrings (a quarter of the key is enough to match), and the
 * base64 forms of the bytes.
 */
const keyLeakFinder = (key: string, secret: Uint8Array) => {
  const hex = Buffer.from(secret).toString('hex');
  const body = key.slice('JDK1-'.length).replaceAll('-', '').slice(0, 52);
  const hexWindows = windows(hex, 16);
  const bodyWindows = windows(body, 13);
  const b64Windows = [
    ...windows(Buffer.from(secret).toString('base64').replace(/=+$/, ''), 11),
    ...windows(Buffer.from(secret).toString('base64url'), 11),
  ];
  return (haystack: string): string[] => {
    const lower = haystack.toLowerCase();
    const compact = haystack.replace(/[\s-]/g, '').toUpperCase();
    const hits: string[] = [];
    if (compact.includes(key.replaceAll('-', '').toUpperCase())) hits.push('full key');
    for (const w of hexWindows) if (lower.includes(w)) hits.push(`hex:${w}`);
    for (const w of bodyWindows) if (compact.includes(w)) hits.push(`base32:${w}`);
    for (const w of b64Windows) if (haystack.includes(w)) hits.push(`base64:${w}`);
    return hits;
  };
};

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let endpoint: string;
let root: string;
/** Every request body the ingest server received, decompressed. */
const requestBodies: string[] = [];
/** Every console line during the run (server side: the ingest handler logs through console). */
const consoleLines: string[] = [];
const consoleSpies: Array<{ mockRestore(): void }> = [];
const stores: KeyStore[] = [];

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), '../../packages/event-store/migrations'),
  });
  const handler = createIngestHandler(createIngestDeps(db));
  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      requestBodies.push(
        (req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'),
      );
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const response = await handler(
        new Request(`${endpoint.replace(/\/api\/v1\/events$/, '')}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(body.length > 0 && { body }),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  endpoint = `http://127.0.0.1:${port}/api/v1/events`;
  root = await mkdtemp(join(tmpdir(), 'javi-privacy-e2e-'));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleLines.push(format(...args));
      }),
    );
  }
}, 60_000);

afterAll(async () => {
  cleanup();
  for (const s of stores) s.dispose();
  for (const spy of consoleSpies) spy.mockRestore();
  await new Promise<void>((r) => server.close(() => r()));
  await client.close();
  await rm(root, { recursive: true, force: true });
});

describe('L1/L2 end to end: javi init --privacy L2 → hook → ingest → reader → browser decryption', () => {
  it('decrypts in the browser, labels honestly, leaks nothing, and survives a lowered class', async () => {
    // ── 1. Workspace, project raised to L2 through JD-M04, a real ingest token ───────────────
    const projects = createProjectRepository(db);
    const ws = await projects.createWorkspace({ name: 'E2E privacy team' });
    const project = await projects.createProject(ws.id, {
      name: 'E2E Shop',
      slug: SLUG,
      platforms: ['claude-code'],
    });
    expect(project.privacyClass).toBe('L0');
    expect(await projects.setPrivacyClass(ws.id, project.id, 'L2')).toEqual({
      id: project.id,
      privacyClass: 'L2',
    });
    const { token } = await projects.issueToken(ws.id, project.id, 'laptop');

    // ── 2. A real recovery key (JD-M11), handed to javi through a key file ──────────────────
    const secret = generateProjectSecret();
    const secretCopy = new Uint8Array(secret);
    const recoveryKey = await encodeRecoveryKey(secret);
    const findKey = keyLeakFinder(recoveryKey, secretCopy);
    const keyFile = join(root, 'recovery.key');
    await writeFile(keyFile, `${recoveryKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);

    // A git work tree named my-repo on branch feature/x (`.git/HEAD` is read as a file).
    const home = join(root, 'javi-home');
    const repoDir = join(root, REPO);
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await writeFile(join(repoDir, '.git', 'HEAD'), `ref: refs/heads/${BRANCH}\n`);

    const collectorOutput: string[] = [];
    const io = (stdin = ''): CollectorIo => ({
      env: { JAVI_HOME: home, JAVI_INGEST_TOKEN: token },
      cwd: repoDir,
      readStdin: async () => stdin,
      out: (l) => collectorOutput.push(l),
      err: (l) => collectorOutput.push(l),
      spawnFlush: () => {},
      spawnReceiver: () => {},
      // No `fetch`: the collector uses its real fetch against the local HTTP server.
    });
    const hook = async (payload: Record<string, unknown>) => {
      const before = collectorOutput.length;
      expect(await main(['hook', '--project', SLUG], io(JSON.stringify(payload)))).toBe(0);
      // A hook never writes to stdout or stderr.
      expect(collectorOutput.slice(before)).toEqual([]);
    };
    const flush = async () =>
      expect(await main(['flush', '--project', SLUG, '--quiet'], io())).toBe(0);
    const session = {
      session_id: 'e2e-session-1',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: repoDir,
    };

    // ── 3. javi init --privacy L2 (the canary is checked by the server before anything is saved)
    const initCode = await main(
      [
        'init',
        '--project',
        SLUG,
        '--endpoint',
        endpoint,
        '--privacy',
        'L2',
        '--privacy-key-file',
        keyFile,
      ],
      io(),
    );
    expect(initCode, collectorOutput.join('\n')).toBe(0);
    const ownKeys = await deriveProjectKeys(secretCopy, SLUG);
    expect(collectorOutput.join('\n')).toContain(`(key ${ownKeys.kid})`);

    // ── 4. Claude Code hooks: SessionStart → UserPromptSubmit → flush ─────────────────────────
    await hook({ ...session, hook_event_name: 'SessionStart', source: 'startup' });
    await hook({ ...session, hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    await flush();

    const stored = async () =>
      (
        await client.query<{ type: string; status: string | null; privacy_class: string }>(
          `select type, status, privacy_class from events where project_id = $1
            order by received_at, sequence`,
          [project.id],
        )
      ).rows.map((r) => `${r.type}${r.status ? ` ${r.status}` : ''} ${r.privacy_class}`);
    // ADR-0018 §5: names only on the identity event; every status event stays L0.
    expect(await stored()).toEqual([
      'x.javi.collector.installed L2',
      'session.started working L0',
      'x.javi.thread.identity L2',
      'heartbeat working L0',
      'x.javi.thread.identity L2',
    ]);

    // ── 5. JD-M07 reader: the newest identity as opaque data ─────────────────────────────────
    const reader = createDashboardReader(db);
    const readIdentity = async (): Promise<ThreadIdentity> => {
      const snapshot = await reader.snapshot(ws.id, { now: new Date() });
      const withIdentity = snapshot.threads.filter(
        (t) => t.projectId === project.id && t.identity?.encrypted,
      );
      expect(withIdentity, 'one thread with an L2 identity').toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toContain(REPO);
      expect(JSON.stringify(snapshot)).not.toContain(BRANCH);
      return withIdentity[0]!.identity!;
    };
    const identity = await readIdentity();
    expect(identity).toMatchObject({
      type: 'x.javi.thread.identity',
      projectSlug: SLUG,
      privacyClass: 'L2',
      encrypted: { alg: 'A256GCM', kid: ownKeys.kid },
    });
    // L1 hashes are keyed HMACs the browser can recompute with the same key (ADR-0018 §3).
    expect(identity.repoHash).toBe(await l1Hash(ownKeys.l1Keys, 'repo', REPO));
    expect(identity.branchHash).toBe(await l1Hash(ownKeys.l1Keys, 'branch', BRANCH));
    // The page passes the project's identities with ciphertext to the label (projects/[id]).
    const identities = [identity];

    // ── 6. Browser: a fresh tab store, the key typed into the web app's own key entry ────────
    localStorage.clear();
    const store = createKeyStore({ persistence: null, channel: null });
    stores.push(store);
    const page = render(
      <KeyStoreProvider store={store}>
        <PrivacyStatus projectId={project.id} identities={identities} />
        <div data-testid="row">
          <ThreadIdentityLabel projectId={project.id} identity={identity} />
        </div>
        <KeyEntry projectId={project.id} slug={SLUG} knownKids={[ownKeys.kid]} />
      </KeyStoreProvider>,
    );
    const projectLabel = () => text(page.container.querySelector('p[role="status"]'));
    await settle();
    expect(projectLabel()).toBe('L2 set up. No encrypted event checked yet.');
    expect(projectLabel()).toBe(LABEL_L2_NOT_CHECKED);
    expect(text(screen.getByTestId('row'))).toBe(labelNoKey(ownKeys.kid));

    const keyInput = page.container.querySelector<HTMLInputElement>('#key-entry')!;
    keyInput.value = recoveryKey;
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    await screen.findByText(`Key ${ownKeys.kid} loaded in this tab.`);
    expect(store.list(project.id)).toEqual([{ kid: ownKeys.kid, remembered: false }]);

    await waitFor(() => expect(text(screen.getByTestId('row'))).toBe('my-repo · feature/x'));
    await waitFor(() => expect(projectLabel()).toBe(labelL2Checked(ownKeys.kid)));
    expect(projectLabel()).toBe(
      `Repo and branch names from javi are encrypted on your machine (key ${ownKeys.kid}). Javi's Dog stores them only as ciphertext and can't read them. They are decrypted here, in your browser.`,
    );
    expect(newestChecked(project.id)).toEqual({ kid: ownKeys.kid, at: identity.at });
    expect(await resolveIdentity(identity, store.keysFor(project.id))).toEqual({
      kind: 'names',
      repo: REPO,
      branch: BRANCH,
      kid: ownKeys.kid,
    });
    page.unmount();

    // ── 7. The same recovery key derived for ANOTHER slug: another kid, nothing decrypts ────
    const parsed = await parseRecoveryKey(recoveryKey);
    if (!parsed.ok) throw new Error(`recovery key did not parse: ${parsed.message}`);
    const otherKeys = await deriveProjectKeys(parsed.secret, OTHER_SLUG);
    expect(otherKeys.kid).not.toBe(ownKeys.kid);
    const otherStore = createKeyStore({ persistence: null, channel: null });
    stores.push(otherStore);
    otherStore.add(project.id, otherKeys.kid, otherKeys.l2Key);
    const other = render(
      <KeyStoreProvider store={otherStore}>
        <div data-testid="row">
          <ThreadIdentityLabel projectId={project.id} identity={identity} />
        </div>
      </KeyStoreProvider>,
    );
    await waitFor(() =>
      expect(text(screen.getByTestId('row'))).toBe("Can't decrypt with the key on this device"),
    );
    expect(text(screen.getByTestId('row'))).toBe(LABEL_OTHER_KID);
    expect(await resolveIdentity(identity, otherStore.keysFor(project.id))).toEqual({
      kind: 'other-kid',
    });
    other.unmount();

    // ── 8. One byte of the stored ciphertext changed in the DB: the right kid cannot verify ──
    const ciphertext = Buffer.from(identity.encrypted!.ciphertext, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 0x01;
    await client.query(
      `update events set encrypted = jsonb_set(encrypted, '{ciphertext}', to_jsonb($1::text))
        where project_id = $2 and event_id = $3`,
      [ciphertext.toString('base64url'), project.id, identity.eventId],
    );
    const tampered = await readIdentity();
    expect(tampered.eventId).toBe(identity.eventId);
    expect(tampered.encrypted!.ciphertext).not.toBe(identity.encrypted!.ciphertext);
    expect(tampered.encrypted!.kid).toBe(ownKeys.kid);
    localStorage.clear();
    const freshStore = createKeyStore({ persistence: null, channel: null });
    stores.push(freshStore);
    freshStore.add(project.id, ownKeys.kid, ownKeys.l2Key);
    const damaged = render(
      <KeyStoreProvider store={freshStore}>
        <PrivacyStatus projectId={project.id} identities={[tampered]} />
        <div data-testid="row">
          <ThreadIdentityLabel projectId={project.id} identity={tampered} />
        </div>
      </KeyStoreProvider>,
    );
    await waitFor(() =>
      expect(text(screen.getByTestId('row'))).toBe(
        "Can't verify this encrypted data (changed or damaged)",
      ),
    );
    expect(text(screen.getByTestId('row'))).toBe(LABEL_UNVERIFIABLE);
    await settle();
    // A changed ciphertext never flips the project label to "checked".
    expect(text(damaged.container.querySelector('p[role="status"]'))).toBe(LABEL_L2_NOT_CHECKED);
    expect(newestChecked(project.id)).toBeNull();
    expect(await resolveIdentity(tampered, freshStore.keysFor(project.id))).toEqual({
      kind: 'unverifiable',
    });
    damaged.unmount();

    // ── 9. Lowered to L0: the status signal still arrives, the identity is rejected ──────────
    expect(await projects.setPrivacyClass(ws.id, project.id, 'L0')).toEqual({
      id: project.id,
      privacyClass: 'L0',
    });
    await hook({ ...session, hook_event_name: 'UserPromptSubmit', prompt: `${PROMPT} again` });
    await flush();
    expect(await stored()).toEqual([
      'x.javi.collector.installed L2',
      'session.started working L0',
      'x.javi.thread.identity L2',
      'heartbeat working L0',
      'x.javi.thread.identity L2',
      'heartbeat working L0',
    ]);
    const statusOut: string[] = [];
    expect(
      await main(['status', '--project', SLUG], {
        ...io(),
        out: (l) => statusOut.push(l),
        err: (l) => statusOut.push(l),
      }),
    ).toBe(0);
    const status = statusOut.join('\n');
    expect(status).toMatch(/Last rejected events: 1 at .* \(privacy_class_not_allowed\)\./);
    expect(status).toContain(
      `Privacy class: L2 (key ${ownKeys.kid}; the key itself is never shown).`,
    );
    collectorOutput.push(...statusOut);

    // ── 10. Nothing readable reached the server: DB rows, request bodies, server logs ───────
    const dump = (
      await client.query<{ row: string }>(`select e::text as row from events e`)
    ).rows.map((r) => r.row);
    expect(dump).toHaveLength(6);
    const surfaces: Array<[string, string]> = [
      ['events rows', dump.join('\n')],
      ['ingest request bodies', requestBodies.join('\n')],
      ['console (server logs)', consoleLines.join('\n')],
    ];
    // Controls: the bodies are decoded JSON and the finder does find the key where it is stored.
    expect(requestBodies.length).toBeGreaterThanOrEqual(3);
    expect(requestBodies.join('\n')).toContain('"x.javi.thread.identity"');
    expect(findKey(await readFile(join(home, 'credentials.json'), 'utf8'))).not.toEqual([]);
    for (const [surface, haystack] of surfaces) {
      for (const needle of [REPO, BRANCH, PROMPT.split(' ')[0]!]) {
        expect(haystack.includes(needle), `${needle} in ${surface}`).toBe(false);
      }
      expect(findKey(haystack), `recovery key in ${surface}`).toEqual([]);
    }
    // The collector never prints the key either (it stays in credentials.json only).
    expect(findKey(collectorOutput.join('\n')), 'recovery key in javi output').toEqual([]);
    const credentials = JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8'));
    expect(credentials[SLUG].privacy).toEqual({ class: 'L2', key: recoveryKey });
  }, 60_000);
});
