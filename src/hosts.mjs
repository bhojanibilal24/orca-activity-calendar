import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { orcaDataDirectory } from './orca-metadata.mjs';

export const LOCAL_HOST_ID = 'local';

// Orca writes environment ids as UUIDs. Keep the pattern strict: the id is passed to the Orca CLI
// as an argument, and a strict shape keeps a corrupted file from reaching the command line at all.
const ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const NAME_MAX = 120;

export function localHost() {
  return { id: LOCAL_HOST_ID, kind: 'local', name: 'This machine', environmentId: null };
}

/** Paired Orca servers, as `orca environment list` shows them. Only the id and display name are
 *  read; the device tokens and public keys stored beside them are never touched. */
export function hostsFromEnvironments(document) {
  const hosts = [];
  for (const environment of Array.isArray(document?.environments) ? document.environments : []) {
    const id = typeof environment?.id === 'string' ? environment.id : '';
    if (!ENVIRONMENT_ID.test(id)) continue;
    const name = typeof environment?.name === 'string' && environment.name.trim() ? environment.name.trim() : id;
    hosts.push({
      id: `runtime:${id}`,
      kind: 'runtime',
      name: name.slice(0, NAME_MAX),
      environmentId: id,
      lastUsedAt: Number.isFinite(environment?.lastUsedAt) ? environment.lastUsedAt : 0
    });
  }
  return hosts.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
}

export async function discoverHosts({ directory = orcaDataDirectory(), read = readFile } = {}) {
  let remote = [];
  try {
    remote = hostsFromEnvironments(JSON.parse(await read(path.join(directory, 'orca-environments.json'), 'utf8')));
  } catch { /* No paired servers, or Orca has not written the file yet. */ }
  return [localHost(), ...remote];
}

export function findHost(hosts, id) {
  return hosts.find(host => host.id === id) || null;
}
