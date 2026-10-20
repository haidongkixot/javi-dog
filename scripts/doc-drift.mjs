// Doc-drift guard (CLAUDE.md §4–5): if a module's source changed relative to the base ref,
// the same change set must touch that module's README/CHANGELOG, a changeset, or docs/.
// Base ref: $DOC_DRIFT_BASE, else origin/main. Without a base ref the check reports SKIPPED.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const candidates = [process.env.DOC_DRIFT_BASE, 'origin/main'].filter(Boolean);

let base;
for (const ref of candidates) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    base = ref;
    break;
  } catch {
    // try next candidate
  }
}

if (!base) {
  console.log(`Doc drift: SKIPPED — no base ref found (tried ${candidates.join(', ')}).`);
  process.exit(0);
}

const changed = git('diff', '--name-only', `${git('merge-base', base, 'HEAD')}...HEAD`)
  .split('\n')
  .filter(Boolean);

const MODULE_SRC = /^((?:apps|packages|collectors)\/[^/]+)\/src\//;
const touchedModules = new Set(changed.map((f) => MODULE_SRC.exec(f)?.[1]).filter(Boolean));
const hasChangeset = changed.some((f) =>
  /^\.changeset\/(?!README\.md|config\.json).+\.md$/.test(f),
);
const hasDocs = changed.some((f) => f.startsWith('docs/'));

const drift = [...touchedModules].filter(
  (mod) =>
    !hasChangeset &&
    !hasDocs &&
    !changed.includes(`${mod}/README.md`) &&
    !changed.includes(`${mod}/CHANGELOG.md`),
);

if (drift.length) {
  console.error(
    `Doc drift: source changed without docs for ${drift.join(', ')}.\n` +
      'Update the module README/CHANGELOG, add a changeset (pnpm changeset) or update docs/.',
  );
  process.exit(1);
}
console.log(
  `Doc drift: PASS (base ${base}, ${touchedModules.size} module(s) with source changes).`,
);
