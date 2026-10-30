import { closeSync, constants, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isatty, ReadStream, WriteStream } from 'node:tty';
import type { ProjectKeys } from '@javis-dog/crypto';
import { createUlid, type RecordInput } from '@javis-dog/jgr-sdk';
import { loadCrypto } from './crypto-loader.ts';
import { COLLECTOR_VERSION } from './mapping.ts';
import type { Platform } from './platform.ts';
import type { SessionFolder } from './session-folder.ts';

// Privacy classes L1/L2 on the collector side (JD-C01, ADR-0018 §4–§6, review H1–H3, M3).

export const PRIVACY_CLASSES = ['L0', 'L1', 'L2'] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];
export type KeyedClass = Exclude<PrivacyClass, 'L0'>;

/** What the project's credentials entry holds for an L1/L2 project. Never printed. */
export interface StoredPrivacy {
  class: KeyedClass;
  /** The recovery key in its canonical `JDK1-…` form (checksum re-checked on every load). */
  key: string;
}

/** ADR-0018 §5: the identity event of a thread. */
export const IDENTITY_TYPE = 'x.javi.thread.identity';
/** ADR-0018 §5: the installation event, the canary of `init --privacy`. */
export const INSTALLED_TYPE = 'x.javi.collector.installed';

/** Project refs that look like a UUID: refused with `--privacy` (review H3: slug only). */
export const UUID_LIKE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The key file of `--privacy-key-file`: a regular file of at most this many bytes. */
export const KEY_FILE_MAX_BYTES = 1024;

export const PRIVACY_GUIDANCE = [
  'Run javi init --privacy yourself, in a terminal.',
  "Never paste the recovery key into an agent chat or an agent's command: it would land in the model provider's transcript.",
];

export const isPrivacyClass = (value: unknown): value is PrivacyClass =>
  typeof value === 'string' && (PRIVACY_CLASSES as readonly string[]).includes(value);

const isKeyedClass = (value: unknown): value is KeyedClass => value === 'L1' || value === 'L2';

/** A credentials entry's `privacy` field, or null when it is absent or malformed. */
export const storedPrivacy = (value: unknown): StoredPrivacy | null => {
  if (!value || typeof value !== 'object') return null;
  const { class: cls, key } = value as Record<string, unknown>;
  return isKeyedClass(cls) && typeof key === 'string' ? { class: cls, key } : null;
};

export type LoadedKeys = { class: KeyedClass; keys: ProjectKeys };

/** Parses the stored key (checksum included) and derives the project keys; null on any error. */
export const loadProjectKeys = async (
  stored: unknown,
  slug: string,
): Promise<LoadedKeys | null> => {
  const privacy = storedPrivacy(stored);
  if (!privacy) return null;
  try {
    const { deriveProjectKeys, parseRecoveryKey, SLUG_PATTERN } = await loadCrypto();
    if (!SLUG_PATTERN.test(slug) || UUID_LIKE.test(slug)) return null;
    const parsed = await parseRecoveryKey(privacy.key);
    if (!parsed.ok) return null;
    return { class: privacy.class, keys: await deriveProjectKeys(parsed.secret, slug) };
  } catch {
    return null;
  }
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The ULID right after `id` (same millisecond, random part + 1), so the identity event sorts
 * directly after its trigger in the spool. A fresh ULID when `id` is not a ULID or overflows.
 */
export const ulidAfter = (id: string, now: number = Date.now()): string => {
  const upper = id.toUpperCase();
  if (ULID.test(upper)) {
    const chars = upper.split('');
    for (let i = chars.length - 1; i >= 10; i--) {
      const value = CROCKFORD.indexOf(chars[i]!);
      if (value < 31) {
        chars[i] = CROCKFORD[value + 1]!;
        return chars.join('');
      }
      chars[i] = '0';
    }
  }
  return createUlid()(now);
};

/**
 * True for the events an identity event follows (ADR-0018 §5): `session.started` and the
 * collector's own `heartbeat working` (Claude Code and Codex `UserPromptSubmit`, Codex resume
 * or compact `SessionStart`, Gemini `BeforeAgent`). Self-reported records never count.
 */
export const isIdentityTrigger = (
  input: Pick<RecordInput, 'type' | 'status'>,
  selfReported: boolean,
) =>
  !selfReported &&
  (input.type === 'session.started' || (input.type === 'heartbeat' && input.status === 'working'));

export interface IdentityContext {
  loaded: LoadedKeys;
  projectRef: string;
  producerId: string;
  threadRef: string;
  platform: Platform;
  folder: SessionFolder;
  /** Set by the collector so the L2 AAD can include it (ADR-0018 §4). */
  eventId: string;
  occurredAt?: string;
  /** Conformance tests only: a fixed AES-GCM IV (see @javis-dog/crypto EncryptL2TestOptions). */
  unsafeFixedIvForTests?: Uint8Array;
}

/**
 * `x.javi.thread.identity` (ADR-0018 §5): the project's class, the thread's `thread_ref`, no
 * `agent_ref` (the identity describes the thread's folder, not an agent), L1 attributes
 * `cwd_hash`, `repo_hash`, `branch_hash` (only those available), and for L2 the encrypted v1
 * payload `{repo, branch}` with the AAD over event id, slug, producer, thread, type and kid.
 */
export const buildIdentityRecord = async (ctx: IdentityContext): Promise<RecordInput> => {
  const { encryptL2, l1Hash } = await loadCrypto();
  const { l1Keys, kid, l2Key } = ctx.loaded.keys;
  const { cwd, repo, branch } = ctx.folder;
  const attributes: Record<string, string> = {
    platform: ctx.platform,
    collector_version: COLLECTOR_VERSION,
    cwd_hash: await l1Hash(l1Keys, 'cwd', cwd),
    ...(repo !== undefined && { repo_hash: await l1Hash(l1Keys, 'repo', repo) }),
    ...(branch !== undefined && { branch_hash: await l1Hash(l1Keys, 'branch', branch) }),
  };
  const record: RecordInput = {
    event_id: ctx.eventId,
    project_ref: ctx.projectRef,
    thread_ref: ctx.threadRef,
    type: IDENTITY_TYPE,
    privacy_class: ctx.loaded.class,
    attributes,
    ...(ctx.occurredAt && { occurred_at: ctx.occurredAt }),
  };
  if (ctx.loaded.class === 'L2') {
    record.encrypted = await encryptL2(
      l2Key,
      kid,
      {
        eventId: ctx.eventId,
        slug: ctx.projectRef,
        producerId: ctx.producerId,
        threadRef: ctx.threadRef,
        type: IDENTITY_TYPE,
      },
      { ...(repo !== undefined && { repo }), ...(branch !== undefined && { branch }) },
      ctx.unsafeFixedIvForTests ? { unsafeFixedIvForTests: ctx.unsafeFixedIvForTests } : undefined,
    );
  }
  return record;
};

export interface CanaryContext {
  /** null: an L0 check event (`init --privacy L0`). */
  loaded: LoadedKeys | null;
  projectRef: string;
  producerId: string;
  threadRef: string;
  platform: Platform;
  eventId: string;
}

/**
 * The installation event as the canary (ADR-0018 §5, review H2). L2: `{"v":1,"canary":true}`
 * encrypted with the AAD of this event. L1: class L1 with no hashed attribute and no encrypted
 * part — the smallest event the validator accepts as L1, and enough for the receiver's class
 * ceiling check. L0: the plain installation event.
 */
export const buildCanaryRecord = async (ctx: CanaryContext): Promise<RecordInput> => {
  const record: RecordInput = {
    event_id: ctx.eventId,
    project_ref: ctx.projectRef,
    thread_ref: ctx.threadRef,
    type: INSTALLED_TYPE,
    attributes: { platform: ctx.platform, collector_version: COLLECTOR_VERSION },
  };
  if (!ctx.loaded) return record;
  const { encryptL2 } = await loadCrypto();
  record.privacy_class = ctx.loaded.class;
  if (ctx.loaded.class === 'L2') {
    record.encrypted = await encryptL2(
      ctx.loaded.keys.l2Key,
      ctx.loaded.keys.kid,
      {
        eventId: ctx.eventId,
        slug: ctx.projectRef,
        producerId: ctx.producerId,
        threadRef: ctx.threadRef,
        type: INSTALLED_TYPE,
      },
      { canary: true },
    );
  }
  return record;
};

// --- Reading the recovery key (ADR-0018 §6, review M3): never from argv ---

export type KeyFileResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * `--privacy-key-file <path>`: a regular file (symlinks to one are fine) of at most 1 KiB,
 * opened without blocking so a FIFO or device never hangs init. Messages never contain the
 * file's content.
 */
export const readKeyFile = async (path: string): Promise<KeyFileResult> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, message: `Could not open the key file (${code}).` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, message: 'The key file is not a regular file.' };
    if (info.size > KEY_FILE_MAX_BYTES) {
      return { ok: false, message: `The key file is larger than ${KEY_FILE_MAX_BYTES} bytes.` };
    }
    const buffer = Buffer.alloc(KEY_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > KEY_FILE_MAX_BYTES) {
      return { ok: false, message: `The key file is larger than ${KEY_FILE_MAX_BYTES} bytes.` };
    }
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8').trim() };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, message: `Could not read the key file (${code}).` };
  } finally {
    await handle.close().catch(() => {});
  }
};

export type HiddenPromptResult =
  { ok: true; text: string } | { ok: false; reason: 'no-terminal' | 'cancelled' };

/** Reads one hidden line from the terminal itself; injectable in `Io` for tests. */
export type HiddenPrompt = (prompt: string) => Promise<HiddenPromptResult>;

/** Longest line the prompt collects (a recovery key is 61 characters with its dashes). */
const PROMPT_MAX_CHARS = 1024;

/**
 * Hidden prompt on the controlling terminal (`/dev/tty`; `CONIN$`/`CONOUT$` on Windows), not on
 * stdin, so a token piped on stdin does not conflict. Raw mode, no echo; Enter ends, Backspace
 * deletes, Ctrl-C or Ctrl-D cancels. `no-terminal` when there is no terminal to open.
 */
export const promptHiddenFromTerminal: HiddenPrompt = (prompt) =>
  new Promise((resolvePrompt) => {
    const windows = process.platform === 'win32';
    let inFd: number | undefined;
    let outFd: number | undefined;
    try {
      inFd = openSync(windows ? 'CONIN$' : '/dev/tty', windows ? 'r+' : 'r');
      outFd = openSync(windows ? 'CONOUT$' : '/dev/tty', windows ? 'r+' : 'w');
      if (!isatty(inFd)) throw new Error('not a terminal');
    } catch {
      for (const fd of [inFd, outFd]) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // already closed
          }
        }
      }
      resolvePrompt({ ok: false, reason: 'no-terminal' });
      return;
    }
    const input = new ReadStream(inFd);
    const output = new WriteStream(outFd);
    let text = '';
    let done = false;
    const finish = (result: HiddenPromptResult) => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      try {
        input.setRawMode(false);
      } catch {
        // the terminal is gone
      }
      output.write('\n', () => {
        input.destroy();
        output.destroy();
        resolvePrompt(result);
      });
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish({ ok: true, text });
        if (ch === '\u0003' || ch === '\u0004') return finish({ ok: false, reason: 'cancelled' });
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ' && text.length < PROMPT_MAX_CHARS) text += ch;
      }
    };
    try {
      input.setRawMode(true);
    } catch {
      input.destroy();
      output.destroy();
      resolvePrompt({ ok: false, reason: 'no-terminal' });
      return;
    }
    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('error', () => finish({ ok: false, reason: 'no-terminal' }));
    output.write(prompt);
  });
