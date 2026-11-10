import test from 'node:test';
import assert from 'node:assert/strict';
import { hostsFromEnvironments, discoverHosts, findHost, localHost } from '../src/hosts.mjs';

test('paired Orca servers become hosts, newest first, without reading their credentials', () => {
  const hosts = hostsFromEnvironments({ environments: [
    { id: '7fa895c7-cf34-472a-8113-46bc9c7c1851', name: 'Car Finder Server', lastUsedAt: 10,
      endpoints: [{ deviceToken: 'secret-token', publicKeyB64: 'secret-key', endpoint: 'ws://127.0.0.1:50508/' }] },
    { id: '2183f1a6-3010-4e9c-8fc3-2100c5f4d51d', name: 'devs', lastUsedAt: 99 }
  ] });
  assert.deepEqual(hosts.map(host => host.name), ['devs', 'Car Finder Server']);
  assert.deepEqual(hosts.map(host => host.id),
    ['runtime:2183f1a6-3010-4e9c-8fc3-2100c5f4d51d', 'runtime:7fa895c7-cf34-472a-8113-46bc9c7c1851']);
  assert.ok(hosts.every(host => host.kind === 'runtime'));
  // Only the id and the display name travel; nothing that could authenticate to the server does.
  assert.equal(JSON.stringify(hosts).includes('secret'), false);
  assert.deepEqual(Object.keys(hosts[0]).sort(), ['environmentId', 'id', 'kind', 'lastUsedAt', 'name']);
});

test('environments with an unusable id or shape are skipped rather than reaching a command line', () => {
  const hosts = hostsFromEnvironments({ environments: [
    { id: '../../etc/passwd', name: 'traversal' },
    { id: 'a b; rm -rf /', name: 'injection' },
    { id: '', name: 'empty' },
    { id: 'x'.repeat(200), name: 'too long' },
    { name: 'no id' },
    null,
    { id: 'good-host-1', name: '  Spaced  ' }
  ] });
  assert.deepEqual(hosts.map(host => host.id), ['runtime:good-host-1']);
  assert.equal(hosts[0].name, 'Spaced');
});

test('a missing or broken environments file leaves just this machine', async () => {
  for (const read of [async () => { throw new Error('ENOENT'); }, async () => 'not json', async () => '{}']) {
    assert.deepEqual(await discoverHosts({ directory: '/nowhere', read }), [localHost()]);
  }
});

test('discovery puts this machine first and finds hosts by id', async () => {
  const hosts = await discoverHosts({ directory: '/nowhere',
    read: async () => JSON.stringify({ environments: [{ id: 'devs-1', name: 'devs' }] }) });
  assert.deepEqual(hosts.map(host => host.id), ['local', 'runtime:devs-1']);
  assert.equal(findHost(hosts, 'runtime:devs-1').name, 'devs');
  assert.equal(findHost(hosts, 'runtime:absent'), null);
});
