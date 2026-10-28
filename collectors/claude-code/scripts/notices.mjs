// THIRD_PARTY_NOTICES.md for the javi tarball (JD-C01, S3f review finding 7). The bundle inlines
// third-party code (zod at least), so the package must carry each one's licence text. The list
// comes from esbuild's metafile (every input under node_modules), never from a hard-coded list,
// and packing fails when a bundled package has no licence file.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** `…/node_modules/<name>` or `…/node_modules/@scope/<name>`: the last one in the path wins. */
const PACKAGE_DIR = /^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;
const FIRST_PARTY = /^@javis-dog\//;

/** The bundled third-party packages with name, version, licence id and full licence text. */
export const thirdPartyPackages = async (metafile, absWorkingDir) => {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = PACKAGE_DIR.exec(input.replace(/\\/g, '/'));
    if (match) dirs.add(resolve(absWorkingDir, match[1]));
  }
  const packages = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (FIRST_PARTY.test(manifest.name)) continue;
    const id = `${manifest.name}@${manifest.version}`;
    const file = (await readdir(dir)).filter((f) => LICENCE_FILE.test(f)).sort()[0];
    if (!file) throw new Error(`No licence file found for the bundled package ${id}.`);
    const text = (await readFile(join(dir, file), 'utf8')).trim();
    if (!text) throw new Error(`The licence file of the bundled package ${id} is empty.`);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'see the licence text',
      text,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
};

/** Markdown with one section per package; fences are longer than any backtick run inside. */
export const renderNotices = (packages) => {
  const sections = packages.map(({ name, version, license, text }) => {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `## ${name}@${version}\n\nLicence: ${license}\n\n${fence}text\n${text}\n${fence}\n`;
  });
  return [
    '# Third-party notices',
    '',
    'javi.mjs bundles the following third-party packages. Their licence texts follow.',
    '',
    ...sections,
  ].join('\n');
};
