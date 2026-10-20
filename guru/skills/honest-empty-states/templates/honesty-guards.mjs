// Honesty guards for UIs built before real data exists. Dependency-free (Node 18+).
//
//   node honesty-guards.mjs --self-test          prove every pattern can fail (run in CI first)
//   node honesty-guards.mjs html <dir>           scan built HTML text for sample-looking numbers
//   node honesty-guards.mjs colors <dir>         scan UI source for raw color literals
//
// Exit codes: 0 clean, 1 findings or failed self-test, 2 usage error.
// Adjust UNITS, ALLOW and SOURCE_EXT to your product; keep the self-test probes in sync.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// A number followed by a unit that dashboards typically fake. Note the lookahead after the unit:
// a trailing \b after "%" never matches before a space or the end of the text, so it is avoided.
// Case-sensitive on purpose: "03 Token deltas" (an ordinal before a title) is not a measurement.
const UNITS = String.raw`%|K\/s|[KMB](?![\w])|tokens?(?![\w])|agents?(?![\w])|ms(?![\w])|s(?![\w])|USD(?![\w])`;
export const SAMPLE_NUMBER = new RegExp(
  String.raw`(?<![\w.])\d[\d,]*(?:\.\d+)?\s?(?:${UNITS})|[$€£]\s?\d`,
  'g',
);

// Hex colors with 3, 4, 6 or 8 digits, plus functional color notations.
export const RAW_COLOR =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

// Exact phrases that are allowed because they are labelled targets, not measurements.
const ALLOW = ['p95 < 2 s', '< 4 KB'];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.vue', '.svelte']);

const PROBES = [
  {
    name: 'SAMPLE_NUMBER',
    re: SAMPLE_NUMBER,
    match: ['67%', '67% capacity', '4.8K/s', '4.8 K/s', '12M', '$12', '1,204 tokens', '3 agents'],
    noMatch: [
      'No signal yet',
      'Sprint 2',
      'v0.1 draft',
      'ADR-0004',
      'p95',
      '2026-10-20',
      'L0',
      '03 Token deltas',
    ],
  },
  {
    name: 'RAW_COLOR',
    re: RAW_COLOR,
    match: [
      '#fff',
      '#ffff',
      '#7c5cff',
      '#7c5cff80',
      'bg-[#abc]',
      'rgb(1 2 3)',
      'oklch(0.7 0.1 250)',
    ],
    noMatch: ['bg-ink', 'text-[11px]', 'var(--ink)', 'url(#gradient)', '#section-intro', '#abcde'],
  },
];

const hits = (re, text) => text.match(new RegExp(re.source, re.flags)) ?? [];

const selfTest = () => {
  const failed = [];
  for (const p of PROBES) {
    for (const s of p.match) if (!hits(p.re, s).length) failed.push(`${p.name} misses "${s}"`);
    for (const s of p.noMatch) if (hits(p.re, s).length) failed.push(`${p.name} flags "${s}"`);
  }
  for (const f of failed) console.error(`SELF-TEST FAIL ${f}`);
  console.log(`self-test: ${failed.length ? 'FAIL' : 'PASS'} (${failed.length} problems)`);
  return failed.length ? 1 : 0;
};

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.git')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const visibleText = (html) =>
  html
    .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ');

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\/|(?<![:'"])\/\/.*$/gm, '');

const scan = (mode, dir) => {
  const findings = [];
  for (const file of walk(dir)) {
    if (mode === 'html' && extname(file) === '.html') {
      let text = visibleText(readFileSync(file, 'utf8'));
      for (const phrase of ALLOW) text = text.split(phrase).join(' ');
      for (const m of hits(SAMPLE_NUMBER, text)) findings.push(`${file}: "${m.trim()}"`);
    }
    if (mode === 'colors' && SOURCE_EXT.has(extname(file))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of hits(RAW_COLOR, code)) findings.push(`${file}: "${m}"`);
    }
  }
  for (const f of findings) console.error(`FOUND ${f}`);
  console.log(`${mode}: ${findings.length} findings in ${dir}`);
  return findings.length ? 1 : 0;
};

const [mode, dir] = process.argv.slice(2);
if (mode === '--self-test') process.exit(selfTest());
if ((mode === 'html' || mode === 'colors') && dir) process.exit(selfTest() || scan(mode, dir));
console.error('Usage: node honesty-guards.mjs --self-test | html <dir> | colors <dir>');
process.exit(2);
