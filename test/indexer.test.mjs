import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryIndex } from '../src/indexer.mjs';

const records = [
  { type: 'session_meta', timestamp: '2026-11-02T09:00:00Z', payload: { id: 'same-id', cwd: '/home/me/orca/workspaces/Atlas/branch' } },
  { type: 'event_msg', timestamp: '2026-11-02T09:00:00Z', payload: { type: 'task_started' } },
  { type: 'event_msg', timestamp: '2026-11-02T10:00:00Z', payload: { type: 'task_complete' } }
];
test('history import deduplicates provider copies, survives partial writes, and uses its cache', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'calendar-test-'));
  try {
    const source = path.join(temp, 'sessions'); await mkdir(source);
    await writeFile(path.join(source, 'a.jsonl'), records.map(x => JSON.stringify(x)).join('\n') + '\n{unfinished');
    await writeFile(path.join(source, 'b.jsonl'), records.map(x => JSON.stringify(x)).join('\n'));
    const index = new HistoryIndex({ directory: path.join(temp, 'data'), sources: [{ agent: 'Codex', path: source, managed: true }] });
    await index.refresh(); assert.equal(index.snapshot().sessions.length, 1); assert.equal(index.status.errors.length, 0);
    const second = new HistoryIndex({ directory: path.join(temp, 'data'), sources: [{ agent: 'Codex', path: source, managed: true }] });
    await second.refresh(); assert.equal(second.snapshot().sessions.length, 1);
    await rm(path.join(source, 'a.jsonl')); await rm(path.join(source, 'b.jsonl')); await second.refresh();
    assert.equal(second.snapshot().sessions.length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('missing provider directories do not break the index', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'calendar-test-'));
  try {
    const index = new HistoryIndex({ directory: path.join(temp, 'data'), sources: [{ agent: 'Claude', path: path.join(temp, 'missing') }] });
    await index.refresh(); assert.equal(index.snapshot().sessions.length, 0); assert.equal(index.status.errors.length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a session in an Orca worktree counts as Orca work even outside ~/orca/workspaces', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'calendar-host-'));
  try {
    const source = path.join(temp, 'projects'); await mkdir(source);
    // A server image keeps its worktrees somewhere the old path guess never matched.
    const server = [
      { type: 'session_meta', timestamp: '2026-11-02T09:00:00Z', payload: { id: 'server-1', cwd: '/workspace/projects/shopsbuilder-v2' } },
      { type: 'event_msg', timestamp: '2026-11-02T09:00:00Z', payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: '2026-11-02T10:00:00Z', payload: { type: 'task_complete' } }
    ];
    const elsewhere = server.map(record => record.type === 'session_meta'
      ? { ...record, payload: { id: 'loose-1', cwd: '/tmp/scratch' } } : record);
    await writeFile(path.join(source, 'server.jsonl'), server.map(x => JSON.stringify(x)).join('\n'));
    await writeFile(path.join(source, 'loose.jsonl'), elsewhere.map(x => JSON.stringify(x)).join('\n'));

    const metadata = {
      async refresh() {}, status: { available: true, namedSessions: 0 }, data: { theme: 'system' },
      isManagedPath: cwd => String(cwd).startsWith('/workspace/projects/shopsbuilder-v2'),
      decorate: session => session
    };
    const index = new HistoryIndex({ directory: path.join(temp, 'data'), metadata,
      sources: [{ agent: 'Codex', path: source, managed: false }] });
    await index.refresh();
    assert.deepEqual(index.snapshot().sessions.map(s => s.id), ['server-1']);
    assert.deepEqual(index.snapshot({ allLocal: true }).sessions.map(s => s.id).sort(), ['loose-1', 'server-1']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
