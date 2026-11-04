import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
const folder = path.join('dist', `${manifest.publisher}.${manifest.id}`);
// Ship only the installed plugin; keep tests and build tools in the repository.
const releaseFiles = [
  'orca-plugin.json', 'README.md', 'LICENSE',
  'src/worker.mjs', 'src/indexer.mjs', 'src/orca-metadata.mjs',
  'src/parsers.mjs', 'src/intervals.mjs', 'src/dates.mjs',
  'web/panel.html', 'web/app.mjs', 'web/client.mjs', 'web/styles.css'
];
await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
for (const file of releaseFiles) {
  const destination = path.join(folder, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(file, destination);
}
await writeFile('dist/INSTALL.txt', `Activity Calendar ${manifest.version}\nRequires Orca 1.4.246 or later.\n\nIn Orca: Settings → Plugins → Add plugin → From a folder…\nChoose the ${manifest.publisher}.${manifest.id} folder.\nReview the worker access and enable it.\nClick the calendar icon in Orca’s RIGHT sidebar.\nThe live calendar opens in Day view inside that panel.\n`);
console.log(`Installable plugin folder: ${path.resolve(folder)}`);
