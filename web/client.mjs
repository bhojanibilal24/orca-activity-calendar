export function createCalendarClient({ frame = globalThis.orca } = {}) {
  const key = 'orca-calendar-worktree-colors';
  const bridge = () => {
    if (!frame?.plugin?.request) throw new Error('The sidebar calendar requires Orca 1.4.246 or later.');
    return frame.plugin;
  };
  return {
    async hosts() {
      return (await bridge().request('calendar.hosts', {})).hosts;
    },
    async snapshot(allLocal = false, hostId = 'local') {
      // A lease keeps all pages consistent even when history changes during a read.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let page = await bridge().request('calendar.snapshot', { allLocal, hostId });
          const id = page.id, total = page.total;
          let data = '', offset = 0;
          while (true) {
            if (page.id !== id || page.offset !== offset || page.total !== total || typeof page.chunk !== 'string' || !page.chunk.length) throw new Error('Incomplete calendar history. Refresh to try again.');
            data += page.chunk; offset += page.chunk.length;
            if (page.next === null) break;
            if (page.next !== offset || offset >= total) throw new Error('Invalid calendar history page.');
            page = await bridge().request('calendar.snapshot', { id, offset });
          }
          if (data.length !== total) throw new Error('Incomplete calendar history. Refresh to try again.');
          return JSON.parse(data);
        } catch (error) {
          if (error.code !== 'snapshot_expired' || attempt) throw error;
        }
      }
    },
    async refresh(hostId = 'local') {
      return bridge().request('calendar.refresh', { hostId }, { timeoutMs: 120_000 });
    },
    async loadColors() {
      return (await frame.storage.get(key)) || [];
    },
    async saveColors(value) {
      return frame.storage.set(key, value);
    },
    onChange(handler) { return bridge().on('calendar.changed', handler); },
    async saveCSV(data, suggestedName) {
      return frame.files.saveAs({ data, suggestedName, mimeType: 'text/csv;charset=utf-8' });
    }
  };
}
