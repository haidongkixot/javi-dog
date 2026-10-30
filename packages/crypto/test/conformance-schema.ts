// Minimal JSON Schema (draft-07) checker for the privacy conformance suite
// (docs/jgr/conformance/privacy/schema.json). No validator library is resolvable from
// packages/crypto and dependencies are not added for a test, so this implements exactly the
// keywords that schema.json uses. Any other keyword is an error, never silently ignored: if
// the schema grows a new keyword, this checker fails loudly instead of under-validating.

type Schema = boolean | { [keyword: string]: unknown };

/** Keywords that only annotate (no validation effect). */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'definitions']);
/** Keywords this checker implements. */
const SUPPORTED = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'pattern',
  'minLength',
  'minimum',
  'maximum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'allOf',
  'oneOf',
]);

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validates `value` against `root` (a draft-07 schema with local `#/definitions/...` refs).
 * Returns the list of errors (JSON pointer + message); empty means valid.
 */
export const validateAgainstSchema = (root: Schema, value: unknown): string[] => {
  const resolve = (ref: string): Schema => {
    if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
    let node: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      if (!isRecord(node) || !(part in node)) throw new Error(`Unresolvable $ref ${ref}`);
      node = node[part];
    }
    return node as Schema;
  };

  const check = (schema: Schema, data: unknown, path: string): string[] => {
    if (schema === true) return [];
    if (schema === false) return [`${path}: not allowed`];
    for (const keyword of Object.keys(schema)) {
      if (!ANNOTATIONS.has(keyword) && !SUPPORTED.has(keyword)) {
        throw new Error(`Schema keyword "${keyword}" at ${path} is not implemented`);
      }
    }
    const errors: string[] = [];
    const s = schema;

    if (typeof s.$ref === 'string') errors.push(...check(resolve(s.$ref), data, path));

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => matchesType(data, t))) {
        errors.push(`${path}: type ${typeOf(data)}, expected ${types.join('|')}`);
        return errors;
      }
    }
    if ('const' in s && !deepEqual(data, s.const)) {
      errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(option, data))) {
      errors.push(`${path}: not in enum`);
    }

    if (typeof data === 'string') {
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(data)) {
        errors.push(`${path}: does not match /${s.pattern}/`);
      }
      // JSON Schema counts code points, not UTF-16 units.
      if (typeof s.minLength === 'number' && [...data].length < s.minLength) {
        errors.push(`${path}: shorter than ${s.minLength}`);
      }
    }
    if (typeof data === 'number') {
      if (typeof s.minimum === 'number' && data < s.minimum) errors.push(`${path}: < minimum`);
      if (typeof s.maximum === 'number' && data > s.maximum) errors.push(`${path}: > maximum`);
    }

    if (Array.isArray(data)) {
      if (typeof s.minItems === 'number' && data.length < s.minItems) {
        errors.push(`${path}: fewer than ${s.minItems} items`);
      }
      if (typeof s.maxItems === 'number' && data.length > s.maxItems) {
        errors.push(`${path}: more than ${s.maxItems} items`);
      }
      if (s.uniqueItems === true) {
        const seen = new Set(data.map((item) => JSON.stringify(item)));
        if (seen.size !== data.length) errors.push(`${path}: items not unique`);
      }
      if (s.items !== undefined) {
        data.forEach((item, i) => errors.push(...check(s.items as Schema, item, `${path}/${i}`)));
      }
    }

    if (isRecord(data)) {
      if (Array.isArray(s.required)) {
        for (const key of s.required as string[]) {
          if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
        }
      }
      const properties = isRecord(s.properties) ? s.properties : {};
      for (const [key, child] of Object.entries(data)) {
        if (key in properties) {
          errors.push(...check(properties[key] as Schema, child, `${path}/${key}`));
        } else if (s.additionalProperties !== undefined) {
          errors.push(...check(s.additionalProperties as Schema, child, `${path}/${key}`));
        }
      }
    }

    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf as Schema[]) errors.push(...check(sub, data, path));
    }
    if (Array.isArray(s.oneOf)) {
      const passing = (s.oneOf as Schema[]).filter((sub) => check(sub, data, path).length === 0);
      if (passing.length !== 1) {
        errors.push(`${path}: matches ${passing.length} of the oneOf branches, expected exactly 1`);
      }
    }
    return errors;
  };

  return check(root, value, '#');
};
