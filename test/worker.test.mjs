import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarWorker } from '../src/worker.mjs';
import { createCalendarClient } from '../web/client.mjs';

function harness(sessions = [], options = {}) {
  const handlers = new Map(), commands = new Map(), events = new Map(), posts = [], requests = [];
  const index = { status: { indexedAt: 1 }, refreshes: 0, sessions,
    async refresh() { this.refreshes++; },
    snapshot({ allLocal = false } = {}) { return { sessions: this.sessions.filter(s => allLocal || s.managed), status: { ...this.status } }; }
  };
  const worker = createCalendarWorker({
    panels: { handle: (name, fn) => handlers.set(name, fn), post: (...args) => posts.push(args) },
    commands: { register: (name, fn) => commands.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) }, log() {}
  }, { index, pluginKey: 'test.calendar',
    hosts: options.hosts ?? (async () => [{ id: 'local', kind: 'local', name: 'This machine', environmentId: null }]),
    remote: options.remote ?? (() => ({ async snapshot() { throw Object.assign(new Error('no remote'), { code: 'remote_failed' }); } })),
    ...options.worker });
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
    const tagged = sessions.map(session => ({ ...session, hostId: 'local', hostName: 'This machine' }));
    assert.deepEqual(JSON.parse(data).sessions, tagged);
    h.index.sessions = sessions;
    assert.deepEqual((await h.client.snapshot()).sessions, tagged);
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

const REMOTE_HOSTS = async () => [
  { id: 'local', kind: 'local', name: 'This machine', environmentId: null },
  { id: 'runtime:devs-1', kind: 'runtime', name: 'devs', environmentId: 'devs-1' }
];

async function settle(handlers, input, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const page = handlers.get('calendar.snapshot')(input);
    const parsed = JSON.parse(page.chunk);
    if (!parsed.status?.scanning) return parsed;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('remote snapshot never settled');
}

test('another host answers with its own calendar, tagged with the host it came from', async () => {
  const remoteSessions = [{ key: 'claude:r1', title: 'Remote build', cwd: '/workspace/projects/api', turns: [{ start: 5, end: 9 }] }];
  const asked = [];
  const h = harness([{ key: 'codex:a', managed: true, turns: [{ start: 1, end: 2 }] }], {
    hosts: REMOTE_HOSTS,
    remote: () => ({ async snapshot(environmentId, options) {
      asked.push({ environmentId, options });
      return { sessions: remoteSessions, status: { indexedAt: 42, sources: [{ agent: 'Claude', path: '/root/.claude/projects', available: true, files: 3 }] } };
    } })
  });
  try {
    assert.deepEqual((await h.handlers.get('calendar.hosts')()).hosts.map(host => host.name), ['This machine', 'devs']);

    // The first read never blocks the bridge on the remote call; it reports that it is gathering.
    const first = JSON.parse(h.handlers.get('calendar.snapshot')({ hostId: 'runtime:devs-1' }).chunk);
    assert.equal(first.status.scanning, true);
    assert.deepEqual(first.sessions, []);

    const settled = await settle(h.handlers, { hostId: 'runtime:devs-1' });
    assert.deepEqual(settled.sessions.map(s => s.title), ['Remote build']);
    assert.equal(settled.sessions[0].hostId, 'runtime:devs-1');
    assert.equal(settled.sessions[0].hostName, 'devs');
    assert.equal(settled.status.sources[0].path, '/root/.claude/projects');
    assert.deepEqual(asked, [{ environmentId: 'devs-1', options: { allLocal: false } }]);

    // This machine keeps answering from its own index, untouched by the remote host.
    const local = JSON.parse(h.handlers.get('calendar.snapshot')({ hostId: 'local' }).chunk);
    assert.deepEqual(local.sessions.map(s => s.key), ['codex:a']);
    assert.equal(local.sessions[0].hostId, 'local');
  } finally { await h.worker.close(); }
});

test('a remote answer is cached, so polling the panel does not re-ask the host', async () => {
  let calls = 0;
  const h = harness([], { hosts: REMOTE_HOSTS,
    remote: () => ({ async snapshot() { calls++; return { sessions: [], status: {} }; } }) });
  try {
    await settle(h.handlers, { hostId: 'runtime:devs-1' });
    for (let i = 0; i < 5; i++) h.handlers.get('calendar.snapshot')({ hostId: 'runtime:devs-1' });
    assert.equal(calls, 1);
    await h.handlers.get('calendar.refresh')({ hostId: 'runtime:devs-1' });
    assert.ok(calls > 1, 'an explicit refresh asks the host again');
  } finally { await h.worker.close(); }
});

test('an unreachable host explains itself instead of breaking the calendar', async () => {
  const h = harness([], { hosts: REMOTE_HOSTS,
    remote: () => ({ async snapshot() { throw Object.assign(new Error('Load this plugin on that host first.'), { code: 'remote_not_loaded' }); } }) });
  try {
    const answer = await settle(h.handlers, { hostId: 'runtime:devs-1' });
    assert.equal(answer.status.remoteCode, 'remote_not_loaded');
    assert.match(answer.status.errors[0], /Load this plugin/);
    assert.deepEqual(answer.sessions, []);
    assert.equal((await h.handlers.get('calendar.hosts')()).hosts[1].code, 'remote_not_loaded');
    await assert.rejects(h.handlers.get('calendar.refresh')({ hostId: 'runtime:devs-1' }), { code: 'remote_not_loaded' });
  } finally { await h.worker.close(); }
});

test('host ids are checked, and an unpaired host is named as such', async () => {
  const h = harness([], { hosts: REMOTE_HOSTS });
  try {
    const snapshot = h.handlers.get('calendar.snapshot');
    await h.handlers.get('calendar.hosts')();
    for (const hostId of ['', 'runtime:', 'local;rm -rf /', '../other', 42, 'runtime:' + 'x'.repeat(200)]) {
      assert.throws(() => snapshot({ hostId }), { code: 'invalid_params' }, String(hostId));
    }
    assert.throws(() => snapshot({ hostId: 'runtime:absent' }), { code: 'unknown_host' });
    await assert.rejects(h.handlers.get('calendar.refresh')({ hostId: 'runtime:absent' }), { code: 'unknown_host' });
    assert.equal(JSON.parse(snapshot({}).chunk).status.hostId, 'local');
  } finally { await h.worker.close(); }
});
