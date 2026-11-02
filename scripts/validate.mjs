import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
const assert = (value, message) => { if (!value) throw new Error(message); };
assert(manifest.manifestVersion === 2 && manifest.pluginApi === 1 && manifest.execution === 'trusted-worker', 'Expected Orca manifest v2/API 1 worker.');
assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id), 'Invalid plugin ID.');
assert(!manifest.id.startsWith('orca-'), 'orca- IDs are reserved.');
assert(typeof manifest.publisher === 'string' && manifest.publisher.length > 0, 'Set the publisher to the repository owner before publication.');
assert(manifest.engines.orca === '>=1.4.246', 'Native worker panels require the targeted Orca release.');
await access(manifest.main);
assert(manifest.contributes.panels.length === 1 && manifest.contributes.panels[0].icon === 'calendar', 'Expected one native calendar panel.');
await access(manifest.contributes.panels[0].entry);
assert(manifest.contributes.commands.length === 1 && manifest.contributes.commands[0].id === 'calendar.refresh', 'Expected one refresh command.');
assert(manifest.capabilities.every(x => ['agent:read', 'storage:own'].includes(x.kind)), 'Unexpected capability.');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
for (const file of ['src', 'web', 'scripts', 'test'].flatMap(walk).filter(p => p.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log('Manifest fields, entries, and JavaScript syntax verified.');
