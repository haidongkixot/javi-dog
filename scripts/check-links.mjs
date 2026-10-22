// Offline check that relative links in tracked Markdown files point to existing files.
// External (http/https/mailto) links are not fetched; anchors are not validated.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const IGNORE = [/^docs\/brand\/source\//, /^\.claude\/skills\/(?!javis-dog-brand|guru-checkpoint)/];

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => !IGNORE.some((re) => re.test(f)));

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const broken = [];

for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, href] of text.matchAll(LINK)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const path = decodeURIComponent(href.split('#')[0]);
    if (!path) continue;
    if (!existsSync(resolve(dirname(join(root, file)), path))) broken.push(`${file} → ${href}`);
  }
}

if (broken.length) {
  console.error(
    `Broken relative links (${broken.length}):\n${broken.map((b) => `  ✗ ${b}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Links OK (${files.length} Markdown files checked).`);
