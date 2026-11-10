// Copy this working tree's plugin onto a paired Orca server, so that host can answer the
// calendar for its own machine. Everything travels through Orca's existing paired connection:
// no repository, no SSH key, no credential of any kind is needed or read.
//
//   node scripts/sync-host.mjs <host> [--dir /workspace/orca-activity-calendar]
//
// `<host>` is a paired server as `orca host list` names it. Re-run it whenever this tree
// changes; the host's copy is replaced atomically, and Orca reloads the plugin there.

import { execFile } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHUNK = 900;
const STAGE = '/tmp/.orca-activity-calendar-sync';

const [host, ...rest] = process.argv.slice(2);
const dirFlag = rest.indexOf('--dir');
const target = dirFlag >= 0 ? rest[dirFlag + 1] : '/workspace/orca-activity-calendar';
if (!host) { console.error('Usage: node scripts/sync-host.mjs <host> [--dir <path on that host>]'); process.exit(2); }
if (!/^\//.test(target)) { console.error('--dir must be an absolute path on that host.'); process.exit(2); }

const orca = (args, timeout = 120_000) => new Promise((resolve, reject) =>
  execFile('orca', args, { timeout, maxBuffer: 8e6 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr || stdout || error.message).slice(0, 400)));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Unreadable reply: ${String(stdout).slice(0, 200)}`)); }
  }));

const run = async (handle, text) => {
  await orca(['terminal', 'send', '--environment', host, '--terminal', handle, '--text', text, '--enter', '--json']);
};
const tail = async handle =>
  (await orca(['terminal', 'read', '--environment', host, '--terminal', handle, '--json'])).result.terminal.tail || [];

/** Waits for a marker the remote shell echoes, so each step is confirmed rather than assumed. */
async function expect(handle, marker, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const lines = await tail(handle);
    const hit = lines.find(line => line.includes(marker) && !line.includes('echo'));
    if (hit) return hit.trim();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`The host never reported ${marker}. Last output:\n${(await tail(handle)).slice(-6).join('\n')}`);
}

const work = await mkdtemp(path.join(tmpdir(), 'ac-sync-'));
try {
  console.log('Packaging this working tree…');
  await new Promise((resolve, reject) => execFile(process.execPath, ['scripts/package.mjs'], error => error ? reject(error) : resolve()));
  const archive = path.join(work, 'plugin.tgz');
  await new Promise((resolve, reject) =>
    execFile('tar', ['-czf', archive, '-C', 'dist', 'bhojanibilal24.activity-calendar'], error => error ? reject(error) : resolve()));
  const bytes = await readFile(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const payload = bytes.toString('base64');
  console.log(`Built ${bytes.length} bytes (sha256 ${digest.slice(0, 12)}…), ${Math.ceil(payload.length / CHUNK)} chunks.`);

  // A remote terminal must be created in one of that host's worktrees; this machine's cwd means
  // nothing there. Any worktree will do, since the plugin is written to an absolute path.
  const worktreeFlag = rest.indexOf('--worktree');
  let worktree = worktreeFlag >= 0 ? rest[worktreeFlag + 1] : null;
  if (!worktree) {
    const listed = (await orca(['worktree', 'list', '--environment', host, '--json'])).result.worktrees || [];
    if (!listed.length) throw new Error(`${host} has no worktree to open a terminal in. Pass --worktree <selector>.`);
    worktree = `id:${listed[0].id}`;
    console.log(`Using worktree ${listed[0].displayName || listed[0].path}.`);
  }

  console.log(`Opening a terminal on ${host}…`);
  const created = await orca(['terminal', 'create', '--environment', host, '--worktree', worktree, '--title', 'activity-calendar sync',
    '--command', `mkdir -p ${STAGE} && rm -f ${STAGE}/plugin.b64 && echo SYNC-READY`, '--json']);
  const handle = created.result.terminal.handle;
  try {
    await expect(handle, 'SYNC-READY');
    for (let offset = 0, n = 0; offset < payload.length; offset += CHUNK) {
      // Base64 has no shell metacharacters, so single quotes make each append literal.
      await run(handle, `printf '%s' '${payload.slice(offset, offset + CHUNK)}' >> ${STAGE}/plugin.b64`);
      if (++n % 10 === 0) process.stdout.write(`  sent ${Math.min(offset + CHUNK, payload.length)}/${payload.length}\r`);
    }
    console.log(`  sent ${payload.length}/${payload.length}          `);

    await run(handle, `test $(wc -c < ${STAGE}/plugin.b64) -eq ${payload.length} && echo SIZE-OK || echo SIZE-BAD`);
    await expect(handle, 'SIZE-OK');

    await run(handle, `base64 -d ${STAGE}/plugin.b64 > ${STAGE}/plugin.tgz && echo "${digest}  ${STAGE}/plugin.tgz" | sha256sum -c - && echo HASH-OK || echo HASH-BAD`);
    await expect(handle, 'HASH-OK');

    // Replace the host's copy atomically so a half-written folder is never loaded.
    await run(handle, `rm -rf ${STAGE}/out && mkdir -p ${STAGE}/out && tar -xzf ${STAGE}/plugin.tgz -C ${STAGE}/out ` +
      `&& rm -rf ${target}.old && (test -d ${target} && mv ${target} ${target}.old || true) ` +
      `&& mkdir -p $(dirname ${target}) && mv ${STAGE}/out/bhojanibilal24.activity-calendar ${target} ` +
      `&& rm -rf ${target}.old ${STAGE} && echo INSTALLED-$(cat ${target}/orca-plugin.json | tr -d ' \\n' | sed 's/.*"version":"\\([^"]*\\)".*/\\1/')`);
    const installed = await expect(handle, 'INSTALLED-');
    console.log(`\n${host}: ${installed.slice(installed.indexOf('INSTALLED-'))} at ${target}`);
    console.log('Next: orca plugin dev load \'' + target + '\' --environment "' + host + '"');
  } finally {
    await orca(['terminal', 'stop', '--environment', host, '--terminal', handle, '--json']).catch(() => {});
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
