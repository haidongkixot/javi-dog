import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptL2, deriveProjectKeys, l1Hash } from '@javis-dog/crypto';
import type { JgrEvent } from '@javis-dog/jgr-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createState, runHook, type CollectorState, type Platform } from '../src/index.ts';
import { isIdentityTrigger, ulidAfter } from '../src/privacy.ts';
import { filesUnder, leaks, makeRecoveryKey } from './privacy-fixtures.ts';

// ADR-0018 §5 (review H1): in an L1/L2 project the collector records `x.javi.thread.identity`
// after `session.started` and its own `heartbeat working`, with the same thread_ref; every
// other event, the triggers included, stays exactly as in an L0 project. Dead endpoint only.
const DEAD = 'http://127.0.0.1:9/x';
const TOKEN = `jd_it_${'I'.repeat(43)}`;
const SLUG = 'web-app';

let root: string;
let repoDir: string;
let fixture: Awaited<ReturnType<typeof makeRecoveryKey>>;
let keys: Awaited<ReturnType<typeof deriveProjectKeys>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'javi-identity-'));
  repoDir = join(root, 'code', 'shop-web');
  await mkdir(join(repoDir, '.git'), { recursive: true });
  await mkdir(join(repoDir, 'src'), { recursive: true });
  await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fixture = await makeRecoveryKey();
  keys = await deriveProjectKeys(fixture.secret, SLUG);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Setup = { state: CollectorState; home: string };
let n = 0;
const setup = async (privacy: 'L0' | 'L1' | 'L2' | 'broken'): Promise<Setup> => {
  const home = join(root, `home-${privacy}-${n++}`);
  const state = createState(home);
  // One installation for every home, so L0 and L1/L2 runs share thread refs.
  await state.installation({
    producer_id: 'prod_claude-code_identity01',
    salt: 'c2FsdC1mb3ItaWRlbnRpdHktdGVzdHM',
  });
  await state.saveCredentials(SLUG, {
    endpoint: DEAD,
    token: TOKEN,
    ...(privacy === 'L1' || privacy === 'L2'
      ? { privacy: { class: privacy, key: fixture.key } }
      : privacy === 'broken'
        ? { privacy: { class: 'L2', key: 'JDK1-0000-0000' } }
        : {}),
  });
  return { state, home };
};

const hook = (s: Setup, platform: Platform, payload: Record<string, unknown>) =>
  runHook({
    state: s.state,
    projectRef: SLUG,
    platform,
    stdin: JSON.stringify(payload),
    spawnFlush: () => {},
  });

const spooled = async (s: Setup): Promise<JgrEvent[]> => {
  const dir = s.state.spoolDir(SLUG);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  return Promise.all(
    names.sort().map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as JgrEvent),
  );
};

/** The trigger hooks per platform (ADR-0018 §5) and a non-trigger hook for each. */
const PLATFORM_CASES: Array<{
  platform: Platform;
  triggers: Array<Record<string, unknown>>;
  others: Array<Record<string, unknown>>;
}> = [
  {
    platform: 'claude-code',
    triggers: [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'please refactor secret.ts' },
    ],
    others: [
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
      { hook_event_name: 'SessionEnd' },
    ],
  },
  {
    platform: 'gemini-cli',
    triggers: [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'BeforeAgent', prompt: 'please refactor secret.ts' },
    ],
    others: [
      { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' },
      { hook_event_name: 'AfterAgent' },
      { hook_event_name: 'SessionEnd' },
    ],
  },
  {
    platform: 'codex-cli',
    triggers: [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'please refactor secret.ts' },
      { hook_event_name: 'SessionStart', source: 'resume' },
    ],
    others: [
      { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'SessionEnd' },
    ],
  },
];

/** The fields of an event that do not depend on the clock or the random id. */
const shape = (e: JgrEvent) => {
  const rest: Partial<JgrEvent> = { ...e };
  delete rest.event_id;
  delete rest.occurred_at;
  delete rest.producer_id;
  return rest;
};

describe.each(PLATFORM_CASES)('identity event — $platform', ({ platform, triggers, others }) => {
  const sessionId = `sess-${platform}`;
  const cwd = () => join(repoDir, 'src');
  const payload = (p: Record<string, unknown>) => ({ session_id: sessionId, cwd: cwd(), ...p });

  it('L0 project: nothing new, every event L0 without hashes (unchanged behaviour)', async () => {
    const s = await setup('L0');
    for (const p of [...triggers, ...others]) await hook(s, platform, payload(p));
    const events = await spooled(s);
    expect(events.map((e) => e.type)).not.toContain('x.javi.thread.identity');
    expect(events.every((e) => e.privacy_class === 'L0' && !e.encrypted)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/_hash/);
  });

  it('L1 project: one identity per trigger, hashes only, same thread, triggers unchanged', async () => {
    const l0 = await setup('L0');
    const l1 = await setup('L1');
    for (const p of [...triggers, ...others]) {
      await hook(l0, platform, payload(p));
      await hook(l1, platform, payload(p));
    }
    const base = await spooled(l0);
    const events = await spooled(l1);
    const identities = events.filter((e) => e.type === 'x.javi.thread.identity');
    const rest = events.filter((e) => e.type !== 'x.javi.thread.identity');
    expect(identities).toHaveLength(triggers.length);
    // The trigger and every other event are exactly what an L0 project records.
    const restShapes = rest.map(shape);
    const baseShapes = base.map(shape);
    // Sequences differ (identity events take numbers too); compare without them, in order.
    const noSeq = (x: ReturnType<typeof shape>) => ({ ...x, sequence: 0 });
    expect(restShapes.map(noSeq)).toEqual(baseShapes.map(noSeq));
    expect(rest.every((e) => e.privacy_class === 'L0' && !e.encrypted)).toBe(true);

    const expected = {
      platform,
      collector_version: '0.1.0',
      cwd_hash: await l1Hash(keys.l1Keys, 'cwd', cwd()),
      repo_hash: await l1Hash(keys.l1Keys, 'repo', 'shop-web'),
      branch_hash: await l1Hash(keys.l1Keys, 'branch', 'main'),
    };
    for (const identity of identities) {
      expect(identity.privacy_class).toBe('L1');
      expect(identity.encrypted).toBeUndefined();
      expect(identity.agent_ref).toBeUndefined();
      expect(identity.status).toBeUndefined();
      expect(identity.attributes).toEqual(expected);
      expect(identity.thread_ref).toBe(base[0]!.thread_ref);
      // It follows its trigger directly: next id, next sequence.
      const trigger = events[events.indexOf(identity) - 1]!;
      expect(isIdentityTrigger(trigger, false)).toBe(true);
      expect(identity.event_id).toBe(ulidAfter(trigger.event_id));
      expect(identity.sequence).toBe(trigger.sequence + 1);
    }
  });

  it('L2 project: hashes plus an encrypted payload that decryptL2 opens only in its own context', async () => {
    const s = await setup('L2');
    for (const p of triggers) await hook(s, platform, payload(p));
    const events = await spooled(s);
    const identities = events.filter((e) => e.type === 'x.javi.thread.identity');
    expect(identities).toHaveLength(triggers.length);
    const { producer_id } = await s.state.installation();
    const byKid = new Map([[keys.kid, keys.l2Key]]);
    for (const identity of identities) {
      expect(identity.privacy_class).toBe('L2');
      expect(Object.keys(identity.attributes ?? {}).sort()).toEqual(
        ['branch_hash', 'collector_version', 'cwd_hash', 'platform', 'repo_hash'].sort(),
      );
      expect(identity.encrypted?.kid).toBe(keys.kid);
      expect(identity.encrypted?.iv).toHaveLength(16);
      const context = {
        eventId: identity.event_id,
        slug: SLUG,
        producerId: producer_id,
        threadRef: identity.thread_ref,
        type: 'x.javi.thread.identity',
      };
      expect(await decryptL2(byKid, identity.encrypted, context)).toEqual({
        ok: true,
        payload: { v: 1, repo: 'shop-web', branch: 'main' },
      });
      // Moved to another thread, type, event, producer or project: refused (M1, H3).
      for (const moved of [
        { threadRef: 'cc_other' },
        { type: 'x.javi.collector.installed' },
        { eventId: ulidAfter(identity.event_id) },
        { producerId: 'prod_other' },
        { slug: 'other-app' },
      ]) {
        expect(await decryptL2(byKid, identity.encrypted, { ...context, ...moved })).toEqual({
          ok: false,
          reason: 'unverifiable',
        });
      }
    }
    // Other events stay L0.
    expect(
      events
        .filter((e) => e.type !== 'x.javi.thread.identity')
        .every((e) => e.privacy_class === 'L0'),
    ).toBe(true);
  });

  it('no cwd in the payload: the trigger only (no cwd_hash, no names)', async () => {
    const s = await setup('L2');
    await hook(s, platform, { session_id: sessionId, ...triggers[0] });
    expect((await spooled(s)).map((e) => e.type)).toEqual(['session.started']);
  });

  it('an unreadable stored key costs only the identity, never the trigger', async () => {
    const s = await setup('broken');
    await hook(s, platform, payload(triggers[0]!));
    expect((await spooled(s)).map((e) => e.type)).toEqual(['session.started']);
  });
});

describe('identity details', () => {
  it('outside git: repo is the session folder name, no branch_hash; L2 payload has repo only', async () => {
    const plain = join(root, 'plain-notes');
    await mkdir(plain, { recursive: true });
    const s = await setup('L2');
    await hook(s, 'claude-code', {
      session_id: 'sess-plain',
      cwd: plain,
      hook_event_name: 'SessionStart',
    });
    const identity = (await spooled(s)).find((e) => e.type === 'x.javi.thread.identity')!;
    // tmpdir's ancestors are not a git work tree here, so the folder itself names the repo.
    expect(identity.attributes?.branch_hash).toBeUndefined();
    expect(identity.attributes?.repo_hash).toBe(await l1Hash(keys.l1Keys, 'repo', 'plain-notes'));
    const { producer_id } = await s.state.installation();
    const opened = await decryptL2(new Map([[keys.kid, keys.l2Key]]), identity.encrypted, {
      eventId: identity.event_id,
      slug: SLUG,
      producerId: producer_id,
      threadRef: identity.thread_ref,
      type: 'x.javi.thread.identity',
    });
    expect(opened).toEqual({ ok: true, payload: { v: 1, repo: 'plain-notes' } });
  });

  it('NFD branch and folder names hash like their NFC forms; the payload carries NFC', async () => {
    const nfdRepo = join(root, 'café-app');
    await mkdir(join(nfdRepo, '.git'), { recursive: true });
    await writeFile(join(nfdRepo, '.git', 'HEAD'), 'ref: refs/heads/résumé\n');
    const s = await setup('L2');
    await hook(s, 'claude-code', {
      session_id: 'sess-nfd',
      cwd: nfdRepo,
      hook_event_name: 'SessionStart',
    });
    const identity = (await spooled(s)).find((e) => e.type === 'x.javi.thread.identity')!;
    expect(identity.attributes?.branch_hash).toBe(await l1Hash(keys.l1Keys, 'branch', 'résumé'));
    expect(identity.attributes?.repo_hash).toBe(await l1Hash(keys.l1Keys, 'repo', 'café-app'));
    expect(identity.attributes?.cwd_hash).toBe(
      await l1Hash(keys.l1Keys, 'cwd', nfdRepo.normalize('NFC')),
    );
    const { producer_id } = await s.state.installation();
    const opened = await decryptL2(new Map([[keys.kid, keys.l2Key]]), identity.encrypted, {
      eventId: identity.event_id,
      slug: SLUG,
      producerId: producer_id,
      threadRef: identity.thread_ref,
      type: 'x.javi.thread.identity',
    });
    expect(opened).toEqual({ ok: true, payload: { v: 1, repo: 'café-app', branch: 'résumé' } });
  });

  it('a Claude Code sub-agent prompt keeps its agent_ref on the trigger; the identity has none', async () => {
    const s = await setup('L1');
    await hook(s, 'claude-code', {
      session_id: 'sess-agent',
      agent_id: 'agent-7',
      cwd: repoDir,
      hook_event_name: 'UserPromptSubmit',
    });
    const [trigger, identity] = await spooled(s);
    expect(trigger?.type).toBe('heartbeat');
    expect(trigger?.agent_ref).toMatch(/^ag_/);
    expect(identity?.type).toBe('x.javi.thread.identity');
    expect(identity?.agent_ref).toBeUndefined();
    expect(identity?.thread_ref).toBe(trigger?.thread_ref);
  });

  it('self-reported records never trigger an identity (unit)', () => {
    expect(isIdentityTrigger({ type: 'heartbeat', status: 'working' }, true)).toBe(false);
    expect(isIdentityTrigger({ type: 'session.started', status: 'working' }, false)).toBe(true);
    expect(isIdentityTrigger({ type: 'heartbeat', status: 'working' }, false)).toBe(true);
    expect(isIdentityTrigger({ type: 'heartbeat', status: 'idle' }, false)).toBe(false);
    expect(isIdentityTrigger({ type: 'task.started' }, false)).toBe(false);
  });

  it('never writes the key, its hex or its base32 body anywhere but the credentials file', async () => {
    const s = await setup('L2');
    for (const p of PLATFORM_CASES[0]!.triggers) {
      await hook(s, 'claude-code', { session_id: 'sess-leak', cwd: repoDir, ...p });
    }
    const files = await filesUnder(s.home);
    expect(files.length).toBeGreaterThan(2);
    for (const [path, text] of files) {
      if (path === 'credentials.json') {
        expect(text).toContain(fixture.key);
        continue;
      }
      expect(leaks(text, fixture.sentinels), path).toEqual([]);
    }
  });

  it('ulidAfter: next id in the same millisecond, fresh id for non-ULIDs', () => {
    expect(ulidAfter('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW');
    expect(ulidAfter('01ARZ3NDEKTSV4RRFFQ69G5FAZ')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FB0');
    expect(ulidAfter('01ARZ3NDEKZZZZZZZZZZZZZZZZ', 5)).toMatch(/^0000000005[0-9A-Z]{16}$/);
    expect(ulidAfter('', 5)).toMatch(/^0000000005/);
  });
});
