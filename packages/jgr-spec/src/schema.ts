import { z } from 'zod';

/**
 * Javi Grande Rules (JGR) v0.1 — draft. Normative text: docs/jgr/spec/v0.1.md.
 * Rule IDs (JGR-Rnn) in comments refer to that document.
 */
export const JGR_VERSION = '0.1' as const;

/** Hard limits (JGR-R12). Size targets in the brand (p95 < 2 s, < 4 KB) are hypotheses, not limits. */
export const JGR_LIMITS = {
  maxEventBytes: 8 * 1024,
  targetEventBytes: 4 * 1024,
  maxBatchEvents: 100,
  maxBatchBytes: 256 * 1024,
  maxRefLength: 128,
  maxAttributeKeys: 16,
  maxAttributeStringLength: 128,
  /** Accepted clock skew for occurred_at (JGR-R07). */
  maxFutureSkewMs: 5 * 60 * 1000,
} as const;

/** Event types (JGR-R04). Kept deliberately small; extensions use the `x.` prefix. */
export const coreEventTypes = [
  'session.started',
  'session.ended',
  'agent.started',
  'agent.stopped',
  'heartbeat',
  'task.started',
  'task.completed',
  'task.failed',
  'attention.requested',
  'usage.reported',
  'error',
] as const;
const EXTENSION_TYPE = /^x\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const EventType = z.union([
  z.enum(coreEventTypes),
  z.string().regex(EXTENSION_TYPE, 'Extension types must look like "x.vendor.name".'),
]);
export type EventType = z.infer<typeof EventType>;

/** Thread/agent status (JGR-R05). `stale` is never sent: the platform derives it from silence. */
export const Status = z.enum(['working', 'waiting', 'idle', 'blocked', 'failed', 'completed']);
export type Status = z.infer<typeof Status>;

/** Privacy classes (JGR-R09). L0 = operational metadata only (default). */
export const PrivacyClass = z.enum(['L0', 'L1', 'L2']);
export type PrivacyClass = z.infer<typeof PrivacyClass>;

const REF = z
  .string()
  .min(1)
  .max(JGR_LIMITS.maxRefLength)
  // Opaque identifiers only: no '/', '.' or '@', so paths, file names and emails cannot pass as refs.
  .regex(/^[A-Za-z0-9_:-]+$/, 'Refs are opaque identifiers: letters, digits and _ : - only.');

/** Token and cost deltas since the producer's previous report for the same thread (JGR-R08). */
export const UsageDelta = z
  .object({
    input_tokens: z.int().nonnegative().optional(),
    output_tokens: z.int().nonnegative().optional(),
    cache_read_tokens: z.int().nonnegative().optional(),
    cache_write_tokens: z.int().nonnegative().optional(),
    /** Reasoning/thinking tokens (Codex reasoning, Gemini "thought"); research note 2026-10-20 §3. */
    reasoning_tokens: z.int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
    model: z.string().min(1).max(64).optional(),
    /** True when the producer could not read exact counts from the tool. */
    estimated: z.boolean().default(false),
  })
  .strict()
  .refine(
    (u) =>
      [
        u.input_tokens,
        u.output_tokens,
        u.cache_read_tokens,
        u.cache_write_tokens,
        u.reasoning_tokens,
        u.cost_usd,
      ].some((v) => v !== undefined),
    'usage_delta needs at least one counter.',
  );
export type UsageDelta = z.infer<typeof UsageDelta>;

const AttributeValue = z.union([
  z.string().max(JGR_LIMITS.maxAttributeStringLength),
  z.number().finite(),
  z.boolean(),
]);

/**
 * Encrypted payload for privacy class L2 (JGR-R10). The platform stores it opaquely.
 * `iv` is the 96-bit AES-GCM IV: exactly 12 bytes = 16 base64url characters (ADR-0018 §4).
 */
export const EncryptedPayload = z
  .object({
    alg: z.literal('A256GCM'),
    kid: z.string().min(1).max(64),
    iv: z.base64url().length(16, 'iv is 12 bytes: exactly 16 base64url characters.'),
    ciphertext: z.base64url().min(1),
  })
  .strict();

/** One JGR event (JGR-R01…R11). Unknown top-level fields are rejected. */
export const JgrEvent = z
  .object({
    jgr: z.literal(JGR_VERSION),
    event_id: z
      .string()
      .regex(
        /^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'Use a ULID or UUID.',
      ),
    producer_id: REF,
    project_ref: REF,
    thread_ref: REF,
    agent_ref: REF.optional(),
    sequence: z.int().nonnegative(),
    type: EventType,
    status: Status.optional(),
    occurred_at: z.iso.datetime({ offset: true }),
    usage_delta: UsageDelta.optional(),
    privacy_class: PrivacyClass.default('L0'),
    attributes: z.record(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/), AttributeValue).optional(),
    encrypted: EncryptedPayload.optional(),
  })
  .strict();
export type JgrEvent = z.output<typeof JgrEvent>;
export type JgrEventInput = z.input<typeof JgrEvent>;

/** Transport unit (JGR-R12): 1–100 events. */
export const JgrBatch = z
  .object({
    events: z.array(z.unknown()).min(1).max(JGR_LIMITS.maxBatchEvents),
  })
  .strict();
