// Pattern language of docs/jgr/conformance/self-report/README.md ("Pattern language"), written
// from that README only. A pattern P matches a JSON value V; `matchPattern` returns every
// mismatch (empty = match) and the text-label observations of the matching branch.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface LabelObservation {
  label: string;
  text: string;
  path: string;
}

export interface MatchResult {
  errors: string[];
  labels: LabelObservation[];
}

/** README rule Y3: words that would claim delivery (checked on the lower-cased text). */
export const DELIVERY_CLAIM =
  /\b(sent|delivered|delivering|uploaded|published|synced|synchronized|live|updated|visible|displayed|shown)\b/;

type Obj = { [key: string]: Json };

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Not a type guard: a non-matcher may still be an object pattern. */
const isMatcher = (p: Json): boolean => isObj(p) && hasOwn(p, '$match');
const jsonType = (v: Json | undefined) =>
  v === undefined ? 'absent' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const show = (v: Json | undefined) => {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

const isOptional = (p: Json) => isObj(p) && isMatcher(p) && p.optional === true;

const primitiveEquals = (a: Json, b: Json) => jsonType(a) === jsonType(b) && a === b;

const run = (p: Json, v: Json | undefined, path: string, out: MatchResult): void => {
  if (isObj(p) && isMatcher(p)) return runMatcher(p, v, path, out);
  if (p === null || typeof p !== 'object') {
    if (v === undefined || !primitiveEquals(p, v)) {
      out.errors.push(`${path}: expected ${show(p)}, got ${show(v)}`);
    }
    return;
  }
  if (Array.isArray(p)) {
    if (!Array.isArray(v)) {
      out.errors.push(`${path}: expected an array, got ${show(v)}`);
      return;
    }
    if (v.length !== p.length) {
      out.errors.push(`${path}: expected ${p.length} elements, got ${v.length}: ${show(v)}`);
      return;
    }
    p.forEach((item, i) => run(item, v[i], `${path}[${i}]`, out));
    return;
  }
  // Object pattern.
  if (!isObj(v)) {
    out.errors.push(`${path}: expected an object, got ${show(v)}`);
    return;
  }
  const open = p.$open === true;
  for (const key of Object.keys(p)) {
    if (key === '$open') continue;
    const sub = p[key] as Json;
    if (!hasOwn(v, key)) {
      if (!isOptional(sub)) out.errors.push(`${path}.${key}: missing`);
      continue;
    }
    run(sub, v[key], `${path}.${key}`, out);
  }
  if (!open) {
    for (const key of Object.keys(v)) {
      if (key === '$open' || !hasOwn(p, key)) {
        out.errors.push(`${path}.${key}: unexpected key (value ${show(v[key])})`);
      }
    }
  }
};

const runMatcher = (m: Obj, v: Json | undefined, path: string, out: MatchResult): void => {
  switch (m.$match) {
    case 'any':
      if (v === undefined) out.errors.push(`${path}: missing`);
      return;
    case 'string': {
      if (typeof v !== 'string') {
        out.errors.push(`${path}: expected a string, got ${show(v)}`);
        return;
      }
      if (typeof m.minLength === 'number' && v.length < m.minLength) {
        out.errors.push(`${path}: length ${v.length} < minLength ${m.minLength}`);
      }
      if (typeof m.maxLength === 'number' && v.length > m.maxLength) {
        out.errors.push(`${path}: length ${v.length} > maxLength ${m.maxLength}`);
      }
      if (typeof m.startsWith === 'string' && !v.startsWith(m.startsWith)) {
        out.errors.push(`${path}: ${show(v)} does not start with ${show(m.startsWith)}`);
      }
      if (Array.isArray(m.containsAll)) {
        for (const part of m.containsAll) {
          if (typeof part === 'string' && !v.includes(part)) {
            out.errors.push(`${path}: ${show(v)} does not contain ${show(part)}`);
          }
        }
      }
      if (m.noDeliveryClaim === true) {
        const lower = v.toLowerCase();
        const claim = DELIVERY_CLAIM.exec(lower);
        if (claim) out.errors.push(`${path}: delivery claim "${claim[1]}" in ${show(v)} (Y3)`);
        if (lower.startsWith('not recorded')) {
          out.errors.push(`${path}: success text starts with "not recorded": ${show(v)} (Y3)`);
        }
      }
      if (typeof m.label === 'string') out.labels.push({ label: m.label, text: v, path });
      return;
    }
    case 'oneOf': {
      const values = Array.isArray(m.values) ? m.values : [];
      const tried: string[] = [];
      for (const option of values) {
        const sub: MatchResult = { errors: [], labels: [] };
        run(option, v, path, sub);
        if (sub.errors.length === 0) {
          out.labels.push(...sub.labels);
          return;
        }
        tried.push(sub.errors.join('; '));
      }
      out.errors.push(`${path}: ${show(v)} matches none of oneOf [${tried.join(' | ')}]`);
      return;
    }
    case 'setEquals': {
      const values = Array.isArray(m.values) ? m.values : [];
      if (!Array.isArray(v)) {
        out.errors.push(`${path}: expected an array (setEquals), got ${show(v)}`);
        return;
      }
      const problems: string[] = [];
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') problems.push(`[${i}] is not a primitive`);
        if (v.findIndex((other) => primitiveEquals(other, item)) !== i) {
          problems.push(`duplicate ${show(item)}`);
        }
        if (!values.some((want) => primitiveEquals(want, item))) {
          problems.push(`unexpected ${show(item)}`);
        }
      });
      for (const want of values) {
        if (!v.some((item) => primitiveEquals(item, want))) problems.push(`missing ${show(want)}`);
      }
      if (problems.length) out.errors.push(`${path}: setEquals: ${problems.join(', ')}`);
      return;
    }
    case 'unorderedArray': {
      const items = Array.isArray(m.items) ? m.items : [];
      if (!Array.isArray(v)) {
        out.errors.push(`${path}: expected an array (unorderedArray), got ${show(v)}`);
        return;
      }
      if (v.length !== items.length) {
        out.errors.push(`${path}: expected ${items.length} elements, got ${v.length}`);
        return;
      }
      // Precompute which element matches which item pattern, then search a one-to-one assignment.
      const fit = v.map((el, i) =>
        items.map((item, j) => {
          const sub: MatchResult = { errors: [], labels: [] };
          run(item, el, `${path}[${i}]~item${j}`, sub);
          return sub;
        }),
      );
      const used = new Set<number>();
      const assignment: number[] = [];
      const assign = (i: number): boolean => {
        if (i === v.length) return true;
        for (let j = 0; j < items.length; j += 1) {
          if (used.has(j) || (fit[i]?.[j]?.errors.length ?? 1) > 0) continue;
          used.add(j);
          assignment[i] = j;
          if (assign(i + 1)) return true;
          used.delete(j);
        }
        return false;
      };
      if (assign(0)) {
        assignment.forEach((j, i) => out.labels.push(...(fit[i]?.[j]?.labels ?? [])));
        return;
      }
      const detail = fit
        .map(
          (row, i) =>
            `[${i}]: ${row.map((r, j) => `item${j} ${r.errors.join('; ') || 'ok'}`).join(' / ')}`,
        )
        .join(' || ');
      out.errors.push(`${path}: no one-to-one assignment (unorderedArray): ${detail}`);
      return;
    }
    default:
      out.errors.push(`${path}: unknown matcher ${show(m.$match)} in the vector`);
  }
};

/** Matches `value` against `pattern`; the root path is `$`. */
export const matchPattern = (pattern: Json, value: Json): MatchResult => {
  const out: MatchResult = { errors: [], labels: [] };
  run(pattern, value, '$', out);
  return out;
};
