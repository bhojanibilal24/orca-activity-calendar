import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrcaMetadata, metadataFromDocuments } from '../src/orca-metadata.mjs';

test('Orca names match by provider session ID rather than a shared workspace path', () => {
  const documents = {
    workspaceSession: { tabsByWorktree: { 'repo::/orca/workspaces/Atlas/feature': [
      { aiVaultTitle: { agent: 'codex', sessionId: 'one', title: 'Assess navigation redesign scope' } },
      { aiVaultTitle: { agent: 'codex', sessionId: 'two', title: 'Inventory new model files' }, customTitle: 'My custom agent name' }
    ] } },
    worktreeMeta: { 'repo::/orca/workspaces/Atlas/feature': { displayName: 'Navigation Feedback 2' } },
    settings: { theme: 'dark', secret: 'never returned' }
  };
  const metadata = new OrcaMetadata(); metadata.data = metadataFromDocuments(documents);
  const first = metadata.decorate({ key: 'Codex:one', title: 'A long first prompt', cwd: '/orca/workspaces/Atlas/feature' });
  const second = metadata.decorate({ key: 'Codex:two', cwd: first.cwd });
  assert.equal(first.title, 'Assess navigation redesign scope');
  assert.equal(first.prompt, 'A long first prompt');
  assert.equal(first.workspace, 'Navigation Feedback 2');
  assert.equal(second.title, 'My custom agent name');
  assert.equal(metadata.data.theme, 'dark'); assert.equal(metadata.data.secret, undefined);
  assert.equal(metadata.decorate({ key: 'Codex:missing', title: 'Recorded task' }).title, 'Recorded task');
});

test('custom names in unified tabs match the sidebar despite duplicate legacy records', () => {
  const cwd = '/orca/workspaces/Atlas/feature', worktreeId = `repo::${cwd}`;
  const named = { agent: 'codex', sessionId: 'one', title: 'Encapsulate feedback eligibility' };
  const legacy = { aiVaultTitle: named, customTitle: 'Widgets MVC' };
  const current = { aiVaultTitle: named, customLabel: 'Widgets MVC' };
  for (const workspaceSession of [
    { tabsByWorktree: { [worktreeId]: [legacy] }, unifiedTabs: { [worktreeId]: [current] } },
    { unifiedTabs: { [worktreeId]: [current] }, tabsByWorktree: { [worktreeId]: [legacy] } }
  ]) {
    const metadata = new OrcaMetadata(); metadata.data = metadataFromDocuments({ workspaceSession });
    assert.equal(metadata.decorate({ key: 'Codex:one', cwd }).title, 'Widgets MVC');
  }
});

test('the current unified-tab name takes precedence over stale legacy names', () => {
  const named = { agent: 'codex', sessionId: 'one', title: 'Generated name' };
  const current = { aiVaultTitle: named, customLabel: 'Current name' };
  const documents = { workspaceSession: {
    unifiedTabs: { workspace: [current] },
    tabsByWorktree: { workspace: [{ aiVaultTitle: named, customTitle: 'Old name' }] }
  } };
  assert.equal(metadataFromDocuments(documents).titles.get('Codex:one').title, 'Current name');
  current.customLabel = null;
  assert.equal(metadataFromDocuments(documents).titles.get('Codex:one').title, 'Generated name');
});

test('metadata reads only naming and theme documents without modifying the database', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'calendar-metadata-'));
  let db;
  try {
    const database = path.join(temp, 'profile-state.db');
    db = new DatabaseSync(database);
    db.exec('CREATE TABLE profile_state_documents (domain TEXT, payload TEXT)');
    const insert = db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)');
    insert.run('workspaceSession', JSON.stringify({ tabsByWorktree: { workspace: [{ aiVaultTitle: { agent: 'codex', sessionId: 'one', title: 'Orca title' } }] } }));
    insert.run('settings', JSON.stringify({ theme: 'light' }));
    insert.run('credentials', 'invalid-json-this-must-not-be-loaded');
    const metadata = new OrcaMetadata({ database }); await metadata.refresh();
    assert.equal(metadata.status.available, true); assert.equal(metadata.status.namedSessions, 1);
    assert.equal(metadata.decorate({ key: 'Codex:one' }).title, 'Orca title');
    assert.equal(db.prepare('SELECT count(*) AS n FROM profile_state_documents').get().n, 3);
    await new OrcaMetadata({ database: path.join(temp, 'missing.db') }).refresh();
  } finally { db?.close(); await rm(temp, { recursive: true, force: true }); }
});

test('Orca worktree paths decide what counts as Orca work, wherever a host keeps them', () => {
  const data = metadataFromDocuments({ worktreeMeta: {
    'repo-a::/workspace/projects/shopsbuilder-v2': { displayName: 'shopsbuilder-v2' },
    'repo-b::/Users/me/orca/workspaces/Atlas/branch': { displayName: 'Atlas' },
    'repo-c::C:\\Users\\me\\orca\\workspaces\\Win': { displayName: 'Win' },
    'global-floating-terminal': { displayName: 'Floating' }
  } });
  assert.deepEqual([...data.worktreePaths].sort(),
    ['/Users/me/orca/workspaces/Atlas/branch', '/workspace/projects/shopsbuilder-v2', 'C:/Users/me/orca/workspaces/Win']);
  // A key that is not a path never becomes a root that swallows everything.
  assert.equal(data.worktreePaths.has(''), false);

  const metadata = new OrcaMetadata({ directory: '/nowhere' });
  metadata.data = data;
  // A server image keeps worktrees far from ~/orca/workspaces; they still count.
  assert.equal(metadata.isManagedPath('/workspace/projects/shopsbuilder-v2'), true);
  assert.equal(metadata.isManagedPath('/workspace/projects/shopsbuilder-v2/packages/web'), true);
  assert.equal(metadata.isManagedPath('C:\\Users\\me\\orca\\workspaces\\Win\\sub'), true);
  // A sibling that merely shares a prefix is not inside the worktree.
  assert.equal(metadata.isManagedPath('/workspace/projects/shopsbuilder-v2-old'), false);
  assert.equal(metadata.isManagedPath('/workspace/other'), false);
  assert.equal(metadata.isManagedPath(''), false);
  assert.equal(metadata.isManagedPath(null), false);
});
