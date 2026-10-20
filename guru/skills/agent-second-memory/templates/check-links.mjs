// Offline relative-link check for Markdown files tracked (or newly added) in git.
// External links (http, https, mailto) and pure anchors are skipped; anchors are not validated.
// Usage: node check-links.mjs        (run from anywhere inside the repository)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Paths whose links you do not own (archived sources, vendored third-party docs).
const IGNORE = [/^vendor\//, /^docs\/archive\//];

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => !IGNORE.some((re) => re.test(f)));

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const broken = [];

for (const file of files) {
  // Drop fenced code so example links inside code blocks are not checked.
  const text = readFileSync(join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, href] of text.matchAll(LINK)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const path = decodeURIComponent(href.split('#')[0]);
    if (path && !existsSync(resolve(dirname(join(root, file)), path))) {
      broken.push(`${file} -> ${href}`);
    }
  }
}

if (broken.length) {
  console.error(`Broken relative links (${broken.length}):\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`Links OK (${files.length} Markdown files checked).`);
