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
