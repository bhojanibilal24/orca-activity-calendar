import { randomUUID } from 'node:crypto';
import { HistoryIndex } from './indexer.mjs';

// Orca limits replies to 1 MiB. Chunk the serialized snapshot so even one thread
// with years of turns fits, without dropping or truncating history.
export const SNAPSHOT_CHUNK = 64 * 1024;
const LEASE_MS = 120_000;
const invalid = (message, code = 'invalid_params') => Object.assign(new Error(message), { code });

export function createCalendarWorker(orca, { index = new HistoryIndex(), now = Date.now, intervalMs = 15_000 } = {}) {
  const snapshots = new Map();
  let started = false, disposed = false, timer;
  const refresh = async () => {
    await index.refresh();
    if (!disposed) orca.panels.post('calendar.changed', { indexedAt: index.status.indexedAt });
    return { indexed: index.snapshot().sessions.length };
  };
  const backgroundRefresh = () => { void refresh().catch(error => orca.log(`Calendar: ${error.message}`)); };
  function start() {
    if (started) return;
    started = true;
    backgroundRefresh();
    timer = setInterval(backgroundRefresh, intervalMs); timer.unref?.();
  }

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
      id = randomUUID();
      item = { at: now(), data: JSON.stringify(index.snapshot({ allLocal: input.allLocal === true })) };
      while (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(id, item);
    }
    if (offset > item.data.length) throw invalid('Snapshot offset is out of range.');
    const chunk = item.data.slice(offset, offset + SNAPSHOT_CHUNK);
    const next = offset + chunk.length;
    return { id, offset, chunk, total: item.data.length, next: next < item.data.length ? next : null };
  });
  orca.panels.handle('calendar.refresh', async () => { start(); return refresh(); });
  orca.commands.register('calendar.refresh', async () => { start(); return refresh(); });
  orca.events.on('agent.status.changed', () => { if (!started) start(); else backgroundRefresh(); });

  return { async close() { disposed = true; clearInterval(timer); snapshots.clear(); await index.pending; } };
}

let calendar;
export default function activate(orca) { calendar = createCalendarWorker(orca); }
export async function deactivate() { await calendar?.close(); calendar = null; }
