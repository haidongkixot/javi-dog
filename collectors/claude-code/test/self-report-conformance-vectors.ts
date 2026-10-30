import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vector loading and small pure helpers for the self-report H runner
// (self-report-conformance.test.ts). Nothing here knows an expected value: every expectation
// comes from docs/jgr/conformance/self-report (README "Hook vectors", "Runner rules" → "Hook
// steps"). The I/O helpers (processes, ingest stub, quiescence) are reused from the Codex
// runner's harness.

export const SUITE_DIR = fileURLToPath(
  new URL('../../../docs/jgr/conformance/self-report/', import.meta.url),
);

export type Platform = 'claude-code' | 'codex-cli' | 'gemini-cli';

/** README "Record comparison" → `attributes`: a string, `{ equals, optional }` or a prefix. */
export type AttrMatcher =
  | string
  | { equals: string; optional: boolean }
  | { prefixOf: string; maxLength: number; optional: boolean };

export interface ExpectedRecord {
  type: string;
  session: string;
  agent: string | null;
  status: string | null | { notIn: string[] };
  attributes: Record<string, AttrMatcher> | null;
  eventId: null | { format: 'ulid-at-clock'; idLabel: string | null };
}

export interface HookStep {
  platform: Platform;
  note: string;
  stdin: Record<string, unknown>;
  /** README "Step clock": milliseconds added to the clock before this step (absent = 0). */
  clockAdvanceMs?: number;
  expect: { record: ExpectedRecord | null };
}

export interface HookVector {
  id: string;
  kind: 'hook';
  description: string;
  ambiguities: string[];
  clock: string;
  identityGroup: string | null;
  steps: HookStep[];
  absentStrings: string[];
}

/** The H files of the suite, sorted, with their parsed contents. */
export const loadHookVectors = async () => {
  const names = (await readdir(SUITE_DIR)).filter((f) => /^H\d{2}-[a-z0-9-]+\.json$/.test(f));
  return Promise.all(
    names
      .sort()
      .map(
        async (f) =>
          [f, JSON.parse(await readFile(join(SUITE_DIR, f), 'utf8')) as unknown] as const,
      ),
  );
};

/**
 * schema.json (draft-07) validator. The suite's M runner uses Ajv through JD-C03's dev
 * dependency `@modelcontextprotocol/sdk` (`validation/ajv`). JD-C01 depends on JD-C03, so the
 * same module is resolved from JD-C03's own package folder; no dependency is added here.
 * Returns null when it cannot be resolved (the schema check is then BLOCKED, never faked).
 */
export const loadSchemaValidator = async (): Promise<
  ((value: unknown) => { valid: boolean; errorMessage?: string }) | null
> => {
  try {
    const jdC03Entry = createRequire(import.meta.url).resolve('@javis-dog/collector-mcp-server');
    const path = createRequire(jdC03Entry).resolve('@modelcontextprotocol/sdk/validation/ajv');
    const mod = (await import(path)) as {
      AjvJsonSchemaValidator: new () => {
        getValidator: (
          schema: unknown,
        ) => (value: unknown) => { valid: boolean; errorMessage?: string };
      };
    };
    const schema = JSON.parse(await readFile(join(SUITE_DIR, 'schema.json'), 'utf8')) as unknown;
    return new mod.AjvJsonSchemaValidator().getValidator(schema);
  } catch {
    return null;
  }
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** README "Event identity": 26 characters of Crockford base32 after upper-casing. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Millisecond time encoded in the first 10 characters of a ULID. */
export const ulidTimeMs = (id: string) => {
  let ms = 0;
  for (const c of id.toUpperCase().slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * README cross-platform matrix rows "Match" (ADR-0017 decision 3), used only for invariant I5
 * ("every heartbeat that carries tool_name came from a javi tool call step"): Claude Code and
 * Codex `tool_name` exactly `mcp__javi__report_status` / `mcp__javi__report_task`; Gemini
 * `mcp_context.server_name` = `javi` and `mcp_context.tool_name` ∈ the two names.
 */
export const isJaviToolCall = (platform: Platform, stdin: Record<string, unknown>) => {
  if (platform === 'gemini-cli') {
    const ctx = stdin.mcp_context;
    return (
      isObject(ctx) &&
      ctx.server_name === 'javi' &&
      (ctx.tool_name === 'report_status' || ctx.tool_name === 'report_task')
    );
  }
  return (
    stdin.tool_name === 'mcp__javi__report_status' || stdin.tool_name === 'mcp__javi__report_task'
  );
};

/** README "Record comparison" → one controlled attribute key; null when it matches. */
export const attributeProblem = (
  key: string,
  matcher: AttrMatcher | undefined,
  value: unknown,
): string | null => {
  if (matcher === undefined) {
    return value === undefined
      ? null
      : `controlled key "${key}" must be absent, got ${String(value)}`;
  }
  if (typeof matcher === 'string') {
    return value === matcher ? null : `attributes.${key}: want "${matcher}", got ${String(value)}`;
  }
  if (value === undefined) {
    return matcher.optional ? null : `attributes.${key} may not be absent`;
  }
  if ('equals' in matcher) {
    return value === matcher.equals
      ? null
      : `attributes.${key}: want "${matcher.equals}", got ${String(value)}`;
  }
  const ok =
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= matcher.maxLength &&
    matcher.prefixOf.startsWith(value);
  return ok
    ? null
    : `attributes.${key}: "${String(value)}" is not a prefix of "${matcher.prefixOf}" ≤ ${matcher.maxLength}`;
};

/** README `record.status`: a string equal; null not checked; `{ notIn }` absent or none of. */
export const statusProblem = (want: ExpectedRecord['status'], got: unknown): string | null => {
  if (want === null) return null;
  if (typeof want === 'string')
    return got === want ? null : `status: want ${want}, got ${String(got)}`;
  return got === undefined || !want.notIn.includes(got as string)
    ? null
    : `status ${String(got)} is in notIn ${JSON.stringify(want.notIn)}`;
};
