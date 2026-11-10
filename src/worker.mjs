import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HistoryIndex } from './indexer.mjs';
import { discoverHosts, findHost, localHost, LOCAL_HOST_ID } from './hosts.mjs';
import { createRemoteSource } from './remote.mjs';

// Orca limits replies to 1 MiB. Chunk the serialized snapshot so even one thread
// with years of turns fits, without dropping or truncating history.
export const SNAPSHOT_CHUNK = 64 * 1024;
const LEASE_MS = 120_000;
const HOST_ID = /^(?:local|runtime:[a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/;
const invalid = (message, code = 'invalid_params') => Object.assign(new Error(message), { code });

async function readPluginKey(url = new URL('../orca-plugin.json', import.meta.url)) {
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  return `${manifest.publisher}.${manifest.id}`;
}

export function createCalendarWorker(orca, {
  index = new HistoryIndex(), now = Date.now, intervalMs = 15_000,
  hosts: discover = discoverHosts, remote: makeRemote = createRemoteSource,
  pluginKey = readPluginKey, remoteTtlMs = 20_000
} = {}) {
  const snapshots = new Map();
  // One entry per host and privacy scope: the last answer it gave, plus any fetch still in flight.
  const remoteCache = new Map();
  let started = false, disposed = false, timer, hostList = [localHost()], hostsLoaded = false, remoteSource, remoteSourceError;

  const refresh = async () => {
    await index.refresh();
    if (!disposed) orca.panels.post('calendar.changed', { indexedAt: index.status.indexedAt });
    return { indexed: index.snapshot().sessions.length };
  };
  const backgroundRefresh = () => { void refresh().catch(error => orca.log(`Calendar: ${error.message}`)); };
  const refreshHosts = () => discover().then(found => { if (!disposed) { hostList = found; hostsLoaded = true; } })
    .catch(error => orca.log(`Calendar: cannot list hosts: ${error.message}`));

  function start() {
    if (started) return;
    started = true;
    backgroundRefresh();
    void refreshHosts();
    timer = setInterval(() => { backgroundRefresh(); void refreshHosts(); }, intervalMs); timer.unref?.();
  }

  async function source() {
    if (remoteSource || remoteSourceError) {
      if (remoteSourceError) throw remoteSourceError;
      return remoteSource;
    }
    try {
      remoteSource = makeRemote({ pluginKey: typeof pluginKey === 'function' ? await pluginKey() : pluginKey });
    } catch (error) {
      remoteSourceError = error; throw error;
    }
    return remoteSource;
  }

  /** Tag every session with the host it came from, so one panel can show several machines. */
  function label(snapshot, host) {
    return {
      ...snapshot,
      sessions: (snapshot.sessions || []).map(session => ({ ...session, hostId: host.id, hostName: host.name })),
      status: { ...(snapshot.status || {}), hostId: host.id, hostName: host.name, hostKind: host.kind }
    };
  }

  function remoteEntry(host, allLocal) {
    const key = `${host.id}:${allLocal ? 'all' : 'orca'}`;
    let entry = remoteCache.get(key);
    if (!entry) { entry = { key, at: 0, snapshot: null, error: null, pending: null }; remoteCache.set(key, entry); }
    return entry;
  }

  function fetchRemote(host, allLocal, entry) {
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      try {
        const answer = await (await source()).snapshot(host.environmentId, { allLocal });
        if (disposed) return;
        entry.snapshot = answer; entry.error = null; entry.at = now();
        orca.panels.post('calendar.changed', { indexedAt: entry.at, hostId: host.id });
      } catch (error) {
        if (disposed) return;
        entry.error = { message: error.message, code: error.code || 'remote_failed' }; entry.at = now();
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  }

  /** Never blocks the bridge on a remote call: serve what we have and refresh behind it. */
  function remoteSnapshot(host, allLocal) {
    const entry = remoteEntry(host, allLocal);
    const stale = now() - entry.at > remoteTtlMs;
    if (stale || (!entry.snapshot && !entry.error)) void fetchRemote(host, allLocal, entry);
    if (entry.snapshot) {
      const labelled = label(entry.snapshot, host);
      labelled.status = { ...labelled.status, fetchedAt: entry.at, stale, scanning: !!entry.pending && stale };
      if (entry.error) labelled.status.errors = [...(labelled.status.errors || []), entry.error.message];
      return labelled;
    }
    const status = { scanning: !entry.error, indexedAt: null, scannedFiles: 0, sources: [],
      errors: entry.error ? [entry.error.message] : [], naming: { available: false, namedSessions: 0 },
      remoteCode: entry.error?.code || null };
    return label({ sessions: [], status }, host);
  }

  function snapshotFor(hostId, allLocal) {
    if (hostId === LOCAL_HOST_ID) return label(index.snapshot({ allLocal }), localHost());
    const host = findHost(hostList, hostId);
    if (host) return remoteSnapshot(host, allLocal);
    // The panel may ask before Orca's host list has been read; report that rather than denying it.
    if (hostsLoaded) throw invalid('That host is not paired with Orca any more.', 'unknown_host');
    void refreshHosts();
    return label({ sessions: [], status: { scanning: true, indexedAt: null, scannedFiles: 0, sources: [], errors: [], naming: { available: false, namedSessions: 0 } } },
      { id: hostId, name: 'Another host', kind: 'runtime' });
  }

  orca.panels.handle('calendar.hosts', async () => {
    start();
    await refreshHosts();
    return { hosts: hostList.map(host => {
      const entry = remoteCache.get(`${host.id}:orca`) || remoteCache.get(`${host.id}:all`);
      return { id: host.id, name: host.name, kind: host.kind,
        error: host.kind === 'local' ? null : entry?.error?.message || null,
        code: host.kind === 'local' ? null : entry?.error?.code || null };
    }) };
  });

  orca.panels.handle('calendar.snapshot', (input = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Expected snapshot options.');
    start();
    for (const [id, item] of snapshots) if (now() - item.at > LEASE_MS) snapshots.delete(id);
    let id = input.id, item;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Invalid snapshot offset.');
    if (id !== undefined) {
      if (typeof id !== 'string' || !(item = snapshots.get(id))) throw invalid('Snapshot expired; request it again.', 'snapshot_expired');
    } else {
      if (offset !== 0 || (input.allLocal !== undefined && typeof input.allLocal !== 'boolean')) throw invalid('Invalid snapshot options.');
      const hostId = input.hostId ?? LOCAL_HOST_ID;
      if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) throw invalid('Invalid host id.');
      id = randomUUID();
      item = { at: now(), data: JSON.stringify(snapshotFor(hostId, input.allLocal === true)) };
      while (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(id, item);
    }
    if (offset > item.data.length) throw invalid('Snapshot offset is out of range.');
    const chunk = item.data.slice(offset, offset + SNAPSHOT_CHUNK);
    const next = offset + chunk.length;
    return { id, offset, chunk, total: item.data.length, next: next < item.data.length ? next : null };
  });

  orca.panels.handle('calendar.refresh', async (input = {}) => {
    start();
    const hostId = input && typeof input === 'object' && !Array.isArray(input) ? input.hostId ?? LOCAL_HOST_ID : LOCAL_HOST_ID;
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) throw invalid('Invalid host id.');
    if (hostId === LOCAL_HOST_ID) return refresh();
    await refreshHosts();
    const host = findHost(hostList, hostId);
    if (!host) throw invalid('That host is not paired with Orca any more.', 'unknown_host');
    for (const allLocal of [false, true]) {
      const entry = remoteEntry(host, allLocal);
      if (entry.snapshot || !allLocal) { entry.at = 0; await fetchRemote(host, allLocal, entry); }
    }
    const entry = remoteEntry(host, false);
    if (entry.error) throw Object.assign(new Error(entry.error.message), { code: entry.error.code });
    return { indexed: entry.snapshot?.sessions?.length ?? 0 };
  });

  orca.commands.register('calendar.refresh', async () => { start(); return refresh(); });
  orca.events.on('agent.status.changed', () => { if (!started) start(); else backgroundRefresh(); });

  return { async close() {
    disposed = true; clearInterval(timer); snapshots.clear();
    const inFlight = [...remoteCache.values()].map(entry => entry.pending).filter(Boolean);
    remoteCache.clear();
    await Promise.allSettled([index.pending, ...inFlight]);
  } };
}

let calendar;
export default function activate(orca) { calendar = createCalendarWorker(orca); }
export async function deactivate() { await calendar?.close(); calendar = null; }
