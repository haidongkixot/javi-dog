// Doc-drift guard: if a module's source changed relative to a base ref, the same change set
// must also touch that module's docs, a changelog/changeset entry, or the shared docs folder.
// Base ref: $DOC_DRIFT_BASE, else origin/main. With no base ref it prints SKIPPED and exits 0,
// so report it as SKIPPED (not PASS) until the default branch exists.
// CI needs full history for merge-base (e.g. actions/checkout with fetch-depth: 0).
import { execFileSync } from 'node:child_process';

// --- Adapt these to your layout -------------------------------------------------------------
const MODULE_SRC = /^((?:apps|packages|services)\/[^/]+)\/src\//; // captures the module root
const SHARED_DOCS = (f) => f.startsWith('docs/');
const CHANGE_NOTE = (f) => /^\.changeset\/(?!README\.md|config\.json).+\.md$/.test(f);
const MODULE_DOCS = (mod) => [`${mod}/README.md`, `${mod}/CHANGELOG.md`];
// ---------------------------------------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const candidates = [process.env.DOC_DRIFT_BASE, 'origin/main'].filter(Boolean);

const base = candidates.find((ref) => {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
});

if (!base) {
  console.log(`Doc drift: SKIPPED (no base ref; tried ${candidates.join(', ')}).`);
  process.exit(0);
}

const changed = git('diff', '--name-only', `${git('merge-base', base, 'HEAD')}...HEAD`)
  .split('\n')
  .filter(Boolean);

const modules = new Set(changed.map((f) => MODULE_SRC.exec(f)?.[1]).filter(Boolean));
const globalDocs = changed.some((f) => SHARED_DOCS(f) || CHANGE_NOTE(f));
const drift = globalDocs
  ? []
  : [...modules].filter((mod) => !MODULE_DOCS(mod).some((d) => changed.includes(d)));

if (drift.length) {
  console.error(`Doc drift: source changed without docs for ${drift.join(', ')}.`);
  process.exit(1);
}
console.log(`Doc drift: PASS (base ${base}, ${modules.size} module(s) with source changes).`);
