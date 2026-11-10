import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteSource, parseCliJson } from '../src/remote.mjs';

const CHUNK = 64 * 1024;
const envelope = result => ({ error: null, stdout: JSON.stringify({ ok: true, result: { pluginKey: 'p.c', name: 'calendar.snapshot', result } }), stderr: '' });

/** Answers like the Orca CLI relaying a remote worker's chunked snapshot. */
function cliFor(snapshot, { calls = [] } = {}) {
  const data = JSON.stringify(snapshot);
  return { calls, run: async (file, args) => {
    calls.push({ file, args });
    const payload = JSON.parse(args[args.indexOf('--data') + 1]);
    const offset = payload.offset ?? 0;
    const chunk = data.slice(offset, offset + CHUNK);
    const next = offset + chunk.length;
    return envelope({ id: 'lease-1', offset, chunk, total: data.length, next: next < data.length ? next : null });
  } };
}

test('a remote snapshot is reassembled from the same chunked reply a panel reads', async () => {
  const snapshot = { sessions: Array.from({ length: 300 }, (_, i) => ({ key: `s${i}`, title: '远程 🛰 "work"'.repeat(40), turns: [{ start: i, end: i + 1 }] })), status: { indexedAt: 7 } };
  const { run, calls } = cliFor(snapshot);
  const source = createRemoteSource({ run, pluginKey: 'pub.activity-calendar' });
  assert.deepEqual(await source.snapshot('devs-1', { allLocal: true }), snapshot);
  assert.ok(calls.length > 1, 'expected the reply to be paged');
  // Every argument is its own argv entry: the host id can never become part of a command.
  assert.deepEqual(calls[0].args.slice(0, 5), ['plugin', 'dev', 'request', 'pub.activity-calendar', 'calendar.snapshot']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--environment') + 1], 'devs-1');
  assert.deepEqual(JSON.parse(calls[0].args[calls[0].args.indexOf('--data') + 1]), { allLocal: true });
  assert.deepEqual(JSON.parse(calls[1].args[calls[1].args.indexOf('--data') + 1]), { id: 'lease-1', offset: CHUNK });
});

test('host ids and plugin keys that are not Orca ids are refused before a process starts', async () => {
  let started = false;
  const source = createRemoteSource({ run: async () => { started = true; return envelope({}); }, pluginKey: 'pub.calendar' });
  for (const id of ['', '../etc', 'a b', 'x;rm -rf /', '-rf', 'a'.repeat(200), null]) {
    await assert.rejects(source.snapshot(id), { code: 'invalid_params' });
  }
  assert.equal(started, false);
  for (const key of ['', 'nodot', 'UPPER.case', 'a.b;c', '.leading']) {
    assert.throws(() => createRemoteSource({ pluginKey: key }), { code: 'invalid_params' });
  }
});

test('a torn or dishonest reply is rejected instead of being shown as history', async () => {
  const bad = [
    [{ id: 'a', offset: 0, chunk: '{"sessions":[]}', total: 99, next: null }, 'remote_failed'],
    [{ id: 'a', offset: 5, chunk: '{}', total: 2, next: null }, 'remote_failed'],
    [{ id: 'a', offset: 0, chunk: 'not json', total: 8, next: null }, 'remote_failed'],
    [{ id: 'a', offset: 0, chunk: '{"nope":1}', total: 10, next: null }, 'remote_failed'],
    [{ id: 'a', offset: 0, chunk: '{}', total: 2, next: 999 }, 'remote_failed'],
    [{ id: 'a', offset: 0, chunk: '', total: 4, next: 0 }, 'remote_failed'],
    [{ id: 'a', offset: 0, chunk: '{}', total: 64 * 1024 * 1024 * 2, next: 2 }, 'remote_too_large']
  ];
  for (const [reply, code] of bad) {
    const source = createRemoteSource({ run: async () => envelope(reply), pluginKey: 'pub.calendar' });
    await assert.rejects(source.snapshot('devs-1'), error => error.code === code, JSON.stringify(reply));
  }
});

test('setup problems are reported as guidance rather than a raw CLI error', async () => {
  const cases = [
    [{ error: Object.assign(new Error('x'), { code: 1 }), stdout: JSON.stringify({ ok: false, error: { message: 'Installed plugins are refused' } }), stderr: '' }, 'remote_not_loaded'],
    [{ error: new Error('x'), stdout: JSON.stringify({ ok: false, error: { message: 'failed', data: { requestCode: 'unknown_method' } } }), stderr: '' }, 'remote_outdated'],
    [{ error: Object.assign(new Error('timeout'), { killed: true }), stdout: '', stderr: '' }, 'remote_timeout'],
    [{ error: new Error('boom'), stdout: '', stderr: 'something else failed' }, 'remote_failed']
  ];
  for (const [outcome, code] of cases) {
    const source = createRemoteSource({ run: async () => outcome, pluginKey: 'pub.calendar' });
    await assert.rejects(source.snapshot('devs-1'), error => error.code === code && error.message.length > 0);
  }
});

test('the Orca CLI is looked for on PATH and in its usual places, then reported missing once', async () => {
  const tried = [];
  const missing = async file => { tried.push(file); return { error: Object.assign(new Error('no entry'), { code: 'ENOENT' }), stdout: '', stderr: '' }; };
  const source = createRemoteSource({ run: missing, candidates: ['orca', '/usr/local/bin/orca'], pluginKey: 'pub.calendar' });
  await assert.rejects(source.snapshot('devs-1'), { code: 'cli_missing' });
  assert.deepEqual(tried, ['orca', '/usr/local/bin/orca']);

  const found = [];
  const second = createRemoteSource({ candidates: ['missing-orca', 'real-orca'], pluginKey: 'pub.calendar',
    run: async (file, args) => {
      found.push(file);
      if (file === 'missing-orca') return { error: Object.assign(new Error('no entry'), { code: 'ENOENT' }), stdout: '', stderr: '' };
      const offset = JSON.parse(args[args.indexOf('--data') + 1]).offset ?? 0;
      return envelope({ id: 'a', offset, chunk: '{"sessions":[]}'.slice(offset), total: 15, next: null });
    } });
  assert.deepEqual(await second.snapshot('devs-1'), { sessions: [] });
  await second.snapshot('devs-1');
  // The working binary is remembered, so later reads do not retry the misses.
  assert.deepEqual(found, ['missing-orca', 'real-orca', 'real-orca']);
  assert.equal(second.cliPath, 'real-orca');
});

test('the CLI envelope is read even behind a leading notice line', () => {
  assert.deepEqual(parseCliJson('Updating…\n{"ok":true}'), { ok: true });
  assert.equal(parseCliJson('   '), null);
  assert.equal(parseCliJson('no json here'), null);
  assert.equal(parseCliJson('{broken'), null);
});

test('a remembered binary that disappears is searched for again, not blamed on the host', async () => {
  const tried = [];
  let present = true;
  const source = createRemoteSource({ candidates: ['orca', '/usr/local/bin/orca'], pluginKey: 'pub.calendar',
    run: async (file, args) => {
      tried.push(file);
      if (!present) return { error: Object.assign(new Error('no entry'), { code: 'ENOENT' }), stdout: '', stderr: '' };
      const offset = JSON.parse(args[args.indexOf('--data') + 1]).offset ?? 0;
      return envelope({ id: 'a', offset, chunk: '{"sessions":[]}'.slice(offset), total: 15, next: null });
    } });
  assert.deepEqual(await source.snapshot('devs-1'), { sessions: [] });
  present = false;
  await assert.rejects(source.snapshot('devs-1'), { code: 'cli_missing' });
  assert.deepEqual(tried, ['orca', 'orca', '/usr/local/bin/orca']);
});
