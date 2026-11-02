import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarWorker } from '../src/worker.mjs';
import { createCalendarClient } from '../web/client.mjs';

function harness(sessions = []) {
  const handlers = new Map(), commands = new Map(), events = new Map(), posts = [], requests = [];
  const index = { status: { indexedAt: 1 }, refreshes: 0, sessions,
    async refresh() { this.refreshes++; },
    snapshot({ allLocal = false } = {}) { return { sessions: this.sessions.filter(s => allLocal || s.managed), status: { ...this.status } }; }
  };
  const worker = createCalendarWorker({
    panels: { handle: (name, fn) => handlers.set(name, fn), post: (...args) => posts.push(args) },
    commands: { register: (name, fn) => commands.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) }, log() {}
  }, { index });
  const frame = { plugin: { async request(name, input) {
    const result = await handlers.get(name)(input);
    const json = JSON.stringify(result); requests.push({ name, input, bytes: Buffer.byteLength(json) });
    return JSON.parse(json);
  }, on() { return { dispose() {} }; } } };
  const client = createCalendarClient({ frame });
  return { handlers, commands, events, posts, requests, index, client, worker };
}

test('native panel reads actual index data through the worker, retaining privacy scope and worktree metadata', async () => {
  const h = harness([
    { key: 'codex:a', managed: true, title: 'Saved Orca name', cwd: '/work/tree', workspace: 'Tree', turns: [{ start: 1, end: 2 }] },
    { key: 'codex:b', managed: false, title: 'Outside Orca', turns: [] }
  ]);
  try {
    const normal = await h.client.snapshot();
    assert.equal(normal.sessions.length, 1); assert.equal(normal.sessions[0].title, 'Saved Orca name');
    assert.equal(normal.sessions[0].cwd, '/work/tree');
    assert.equal((await h.client.snapshot(true)).sessions.length, 2);
    await h.client.refresh(); assert.ok(h.posts.some(([name]) => name === 'calendar.changed'));
    const before = h.index.refreshes; h.events.get('agent.status.changed')();
    assert.ok(h.index.refreshes > before);
    assert.deepEqual([...h.commands.keys()], ['calendar.refresh']);
  } finally { await h.worker.close(); }
});

test('large histories and Unicode survive the 1 MiB bridge limit and a concurrent refresh', async () => {
  const sessions = Array.from({ length: 400 }, (_, i) => ({ key: String(i), managed: true, title: '工作 🌳 "quoted" '.repeat(150), turns: [{ start: i, end: i + 1 }] }));
  const h = harness(sessions);
  try {
    const first = h.handlers.get('calendar.snapshot')({ allLocal: false });
    h.index.sessions = [];
    let data = first.chunk, page = first;
    while (page.next !== null) {
      page = h.handlers.get('calendar.snapshot')({ id: first.id, offset: page.next });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
      data += page.chunk;
    }
    assert.deepEqual(JSON.parse(data).sessions, sessions);
    h.index.sessions = sessions;
    assert.deepEqual((await h.client.snapshot()).sessions, sessions);
    assert.ok(h.requests.length > 1);
    assert.ok(h.requests.every(r => r.bytes < 1024 * 1024));
  } finally { await h.worker.close(); }
});

test('bridge rejects invalid cursors, and client retries after a worker restart', async () => {
  const h = harness([{ managed: true, key: 'a' }]);
  try {
    const snapshot = h.handlers.get('calendar.snapshot');
    for (const value of [null, [], { offset: -1 }, { offset: 1 }, { allLocal: 'yes' }]) assert.throws(() => snapshot(value), { code: 'invalid_params' });
    assert.throws(() => snapshot({ id: 'unknown' }), { code: 'snapshot_expired' });
    let calls = 0;
    const client = createCalendarClient({ frame: { plugin: { async request(name, input) {
      if (++calls === 1) throw Object.assign(new Error('Worker restarted'), { code: 'snapshot_expired' });
      return snapshot(input);
    } } } });
    assert.equal((await client.snapshot()).sessions[0].key, 'a'); assert.equal(calls, 2);
    await assert.rejects(createCalendarClient({ frame: {} }).snapshot(), /requires Orca 1.4.246/);
  } finally { await h.worker.close(); }
});

test('native panel persists colors and exports via the Orca save dialog', async () => {
  const saved = [], values = new Map();
  const client = createCalendarClient({ frame: {
    storage: { get: async key => values.get(key), set: async (key, value) => values.set(key, value) },
    files: { saveAs: async options => { saved.push(options); return { status: 'cancelled' }; } }
  } });
  await client.saveColors([['/work/tree', 2]]);
  assert.deepEqual(await client.loadColors(), [['/work/tree', 2]]);
  assert.deepEqual(await client.saveCSV('a,b\n1,2', 'activity.csv'), { status: 'cancelled' });
  assert.deepEqual(saved, [{ data: 'a,b\n1,2', suggestedName: 'activity.csv', mimeType: 'text/csv;charset=utf-8' }]);
});
