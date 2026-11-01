import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromJSONSchema } from 'zod';

// Helpers for the GitHub conformance runner (S5g H5 part 2): vector loading, schema validation,
// body building and comparison. Nothing here imports JD-M10 internals; the runner drives the
// product only through the route module.

export const VECTOR_DIR = resolve(process.cwd(), '../../docs/jgr/conformance/github');

// ---------------------------------------------------------------------------------------------
// Vector types (docs/jgr/conformance/github/README.md "Vector file format").
// ---------------------------------------------------------------------------------------------

export interface SignatureCase {
  label: string;
  note: string;
  secrets: string[];
  bodyHex: string;
  header: string | null;
  expect: { valid: boolean; hmacHexPerSecret: string[] };
}

export interface SignatureVector {
  id: 'S01';
  kind: 'signature';
  cases: SignatureCase[];
}

export interface InstallationRow {
  installationId: number;
  accountId: number;
  accountType: 'User' | 'Organization';
  claimedBy: string | null;
  suspended: boolean;
}

export interface RepositoryRow {
  repoId: number;
  installationId: number;
  fullName: string;
  project: string | null;
}

export interface RowState {
  installations: InstallationRow[];
  repositories: RepositoryRow[];
}

export type AttributeExpectation = string | number | boolean | { optional: true; equals: unknown };

export interface ExpectedEvent {
  derivation: { threadKey: string; eventIdName: string; sequenceRule: string };
  event: {
    jgr: string;
    event_id: string;
    producer_id: string;
    project_ref: string;
    thread_ref: string;
    sequence: number;
    type: string;
    occurred_at: string;
  };
  attributes: Record<string, AttributeExpectation>;
}

export interface RouteRequest {
  headers: Record<string, string>;
  payload: Record<string, unknown> | null;
  bodyText: string | null;
  bodyHex: string | null;
  bodyPadBytes: number | null;
  bodyLength: number;
  bodySha256: string;
  signedWith: string;
}

export interface RouteStep {
  note: string;
  action: { op: 'releaseClaim'; installationId: number } | null;
  fault: 'store-unavailable' | null;
  request: RouteRequest | null;
  expect: {
    outcome: string;
    status: number | null;
    errorCode: string | null;
    equivalenceGroup: string | null;
    deliveryRecorded: boolean | null;
    events: ExpectedEvent[];
    state: RowState | null;
  };
}

export interface RouteVector {
  id: string;
  kind: 'route';
  description: string;
  ambiguities: string[];
  clock: string;
  setup: {
    secrets: { current: string | null; previous: string | null };
    workspaces: { label: string; projects: { slug: string; privacyClass: 'L0' | 'L1' | 'L2' }[] }[];
    installations: InstallationRow[];
    repositories: RepositoryRow[];
  };
  steps: RouteStep[];
  absentStrings: string[];
}

export type Vector = SignatureVector | RouteVector;

export interface VectorFile {
  file: string;
  raw: unknown;
  vector: Vector;
}

export const loadVectors = (): VectorFile[] =>
  readdirSync(VECTOR_DIR)
    .filter((f) => /^[SRMP][0-9]{2}-[a-z0-9-]+\.json$/.test(f))
    .sort()
    .map((file) => {
      const raw: unknown = JSON.parse(readFileSync(resolve(VECTOR_DIR, file), 'utf8'));
      return { file, raw, vector: raw as Vector };
    });

// ---------------------------------------------------------------------------------------------
// schema.json validation. No JSON-Schema validator is a dependency; zod (already a dependency of
// apps/web) converts the draft-07 schema with `fromJSONSchema`. Its converter only builds an
// object check where a subschema says `type: "object"`, so the three body branches of `request`
// (`oneOf` of `properties`-only subschemas, whose parent is already an object) would match
// anything. `normaliseSchema` adds `type: "object"` to every subschema that has `properties` and
// no `type`: an equivalence-preserving rewrite for this schema, because every such subschema
// only ever applies to objects. Negative controls in the runner show the result is not vacuous.
// ---------------------------------------------------------------------------------------------

const normaliseSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(normaliseSchema);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = normaliseSchema(v);
  if ('properties' in out && !('type' in out)) out.type = 'object';
  return out;
};

export const loadSchemaValidator = () => {
  const schema = JSON.parse(readFileSync(resolve(VECTOR_DIR, 'schema.json'), 'utf8')) as unknown;
  const validator = fromJSONSchema(normaliseSchema(schema) as Parameters<typeof fromJSONSchema>[0]);
  return (value: unknown) => {
    const r = validator.safeParse(value);
    return r.success
      ? { ok: true as const }
      : {
          ok: false as const,
          issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5),
        };
  };
};

// ---------------------------------------------------------------------------------------------
// Bodies.
// ---------------------------------------------------------------------------------------------

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const hexBytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** README "Vector file format": payload → compact JSON (+ spaces), bodyText → UTF-8, bodyHex. */
export const buildBody = (r: RouteRequest): Uint8Array<ArrayBuffer> => {
  let bytes: Uint8Array<ArrayBuffer>;
  if (r.payload !== null) {
    const text = JSON.stringify(r.payload);
    const pad = r.bodyPadBytes === null ? 0 : r.bodyPadBytes - Buffer.byteLength(text, 'utf8');
    bytes = new Uint8Array(Buffer.from(text + ' '.repeat(Math.max(0, pad)), 'utf8'));
  } else if (r.bodyText !== null) {
    bytes = new Uint8Array(Buffer.from(r.bodyText, 'utf8'));
  } else {
    bytes = hexBytes(r.bodyHex ?? '');
  }
  // README "Sending": a length or hash mismatch is a fixture problem (BLOCKED), never a FAIL of
  // the implementation.
  if (bytes.length !== r.bodyLength || sha256Hex(bytes) !== r.bodySha256) {
    throw new Error(
      `BLOCKED (fixture serialisation): built ${bytes.length} bytes, sha256 ${sha256Hex(bytes)}; ` +
        `vector says ${r.bodyLength} bytes, ${r.bodySha256}`,
    );
  }
  return bytes;
};

// ---------------------------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------------------------

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored event row read back from JD-M06 (`events` joined to its project's slug). */
export interface StoredEvent {
  id: string;
  event_id: string;
  producer_id: string;
  project_ref: string;
  thread_ref: string;
  sequence: string;
  type: string;
  status: string | null;
  agent_ref: string | null;
  privacy_class: string;
  occurred_at: Date | string;
  usage_delta: unknown;
  attributes: Record<string, unknown> | null;
  encrypted: unknown;
  json: string;
}

const sameJson = (actual: unknown, expected: unknown) =>
  typeof actual === typeof expected &&
  (typeof expected !== 'number' || Number.isInteger(actual) === Number.isInteger(expected)) &&
  actual === expected;

/**
 * README "Event comparison" for one stored event against its expectation; returns the list of
 * mismatches (empty = equal). `jgr` is not a stored column (JD-M06 stores v0.1 events only), so
 * only the expectation's value is checked.
 */
export const compareEvent = (stored: StoredEvent, exp: ExpectedEvent): string[] => {
  const out: string[] = [];
  const e = exp.event;
  if (e.jgr !== '0.1') out.push(`expected jgr ${e.jgr} is not 0.1`);
  for (const k of ['event_id', 'producer_id', 'project_ref', 'thread_ref', 'type'] as const) {
    if (stored[k] !== e[k]) out.push(`${k}: stored ${stored[k]}, expected ${e[k]}`);
  }
  if (stored.sequence !== String(e.sequence)) {
    out.push(`sequence: stored ${stored.sequence}, expected ${e.sequence}`);
  }
  const occurred = new Date(stored.occurred_at).getTime();
  if (occurred !== Date.parse(e.occurred_at)) {
    out.push(`occurred_at: stored ${new Date(occurred).toISOString()}, expected ${e.occurred_at}`);
  }
  // No other envelope keys (README; D0 M1 no status, G15 no agent_ref) and L0 (Y5).
  if (stored.status !== null) out.push(`status present: ${stored.status}`);
  if (stored.agent_ref !== null) out.push(`agent_ref present: ${stored.agent_ref}`);
  if (stored.usage_delta !== null) out.push('usage_delta present');
  if (stored.encrypted !== null) out.push('encrypted present');
  if (stored.privacy_class !== 'L0') out.push(`privacy_class ${stored.privacy_class}, not L0`);
  // Attributes: exactly the listed keys (optional ones may be absent), same JSON types.
  const attrs = stored.attributes ?? {};
  for (const key of Object.keys(attrs)) {
    if (!(key in exp.attributes)) out.push(`attribute ${key} not expected (${String(attrs[key])})`);
  }
  for (const [key, want] of Object.entries(exp.attributes)) {
    const optional = typeof want === 'object' && want !== null && want.optional === true;
    const value = optional ? (want as { equals: unknown }).equals : want;
    if (!(key in attrs)) {
      if (!optional) out.push(`attribute ${key} missing`);
      continue;
    }
    if (!sameJson(attrs[key], value)) {
      out.push(
        `attribute ${key}: stored ${JSON.stringify(attrs[key])}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  return out;
};

const byKey = <T>(rows: T[], key: (r: T) => number) => [...rows].sort((a, b) => key(a) - key(b));

/** README "Row comparison": both tables as sets keyed by id, in the setup row shape. */
export const normaliseState = (s: RowState): RowState => ({
  installations: byKey(
    s.installations.map((i) => ({
      installationId: i.installationId,
      accountId: i.accountId,
      accountType: i.accountType,
      claimedBy: i.claimedBy,
      suspended: i.suspended,
    })),
    (i) => i.installationId,
  ),
  repositories: byKey(
    s.repositories.map((r) => ({
      repoId: r.repoId,
      installationId: r.installationId,
      fullName: r.fullName,
      project: r.project,
    })),
    (r) => r.repoId,
  ),
});

/** Case-insensitive substrings of `needles` found in `haystack`. */
export const findAbsent = (haystack: string, needles: readonly string[]) => {
  const h = haystack.toLowerCase();
  return needles.filter((n) => n.length > 0 && h.includes(n.toLowerCase()));
};
