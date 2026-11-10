import { execFile } from 'node:child_process';

// A paired Orca server computes its own calendar: this plugin runs there too, indexes that machine's
// transcripts, and answers `calendar.snapshot` exactly as it does locally. We only carry the answer
// across, through the Orca CLI, which already speaks the paired end-to-end-encrypted protocol.
// Nothing here opens a socket, reads a key, or runs a command of its own on the remote machine.

export const PLUGIN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
export const ENVIRONMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** Orca caps a handler at 120 s; stay under it so the CLI reports the handler's own timeout. */
const HANDLER_TIMEOUT_MS = 60_000;
const PROCESS_TIMEOUT_MS = HANDLER_TIMEOUT_MS + 20_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;
const MAX_PAGES = 4096;

const CLI_CANDIDATES = process.platform === 'win32'
  ? ['orca.cmd', 'orca.exe', 'orca']
  : ['orca', '/usr/local/bin/orca', '/opt/homebrew/bin/orca'];

const fail = (message, code) => Object.assign(new Error(message), { code });

function runCommand(file, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true, shell: false },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** Reads the CLI's `--json` envelope out of stdout, tolerating a leading notice line. */
export function parseCliJson(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function describeFailure({ error, stdout, stderr }) {
  const envelope = parseCliJson(stdout);
  const message = String(envelope?.error?.message || stderr || error?.message || 'The Orca CLI failed.').trim();
  const requestCode = envelope?.error?.data?.requestCode;
  if (requestCode === 'unknown_method') {
    return fail('That host runs an Activity Calendar without the snapshot handler. Update it there.', 'remote_outdated');
  }
  if (/Installed plugins are refused|development plugin/i.test(message)) {
    return fail('Load this plugin on that host first: orca plugin dev load <folder> --environment <host>.', 'remote_not_loaded');
  }
  if (/not found|no such plugin|unknown plugin/i.test(message)) {
    return fail('Activity Calendar is not loaded on that host yet.', 'remote_not_loaded');
  }
  if (error?.killed || /timed out|ETIMEDOUT/i.test(message)) {
    return fail('That host did not answer in time. It may be asleep or unreachable.', 'remote_timeout');
  }
  return fail(message.slice(0, 300), 'remote_failed');
}

export function createRemoteSource({ run = runCommand, candidates = CLI_CANDIDATES, pluginKey } = {}) {
  if (!PLUGIN_KEY_PATTERN.test(String(pluginKey || ''))) throw fail('Invalid plugin key.', 'invalid_params');
  let resolved = null;

  // Each argument is passed as its own argv entry and never through a shell, so a host name can
  // not become part of a command. The patterns below reject anything that is not an Orca id.
  const requestArgs = (environmentId, data) => [
    'plugin', 'dev', 'request', pluginKey, 'calendar.snapshot',
    '--environment', environmentId,
    '--timeout-ms', String(HANDLER_TIMEOUT_MS),
    '--data', JSON.stringify(data),
    '--json'
  ];

  async function page(environmentId, data) {
    const args = requestArgs(environmentId, data);
    // The binary that worked is tried first, with the rest kept as a fallback in case it is gone.
    const order = resolved ? [resolved, ...candidates.filter(candidate => candidate !== resolved)] : candidates;
    for (const candidate of order) {
      const outcome = await run(candidate, args, PROCESS_TIMEOUT_MS);
      // A remembered binary that has since been removed falls back to the search instead of
      // reporting the miss as a remote failure.
      if (outcome.error?.code === 'ENOENT') { resolved = null; continue; }
      resolved = candidate;
      if (outcome.error) throw describeFailure(outcome);
      const envelope = parseCliJson(outcome.stdout);
      if (envelope?.ok !== true) throw describeFailure(outcome);
      const result = envelope.result?.result;
      if (!result || typeof result !== 'object') throw fail('That host returned an unreadable answer.', 'remote_failed');
      return result;
    }
    throw fail('The Orca command line tool was not found, so other hosts cannot be reached.', 'cli_missing');
  }

  return {
    get cliPath() { return resolved; },
    /** The remote host's own snapshot, reassembled from the same chunked reply a panel reads. */
    async snapshot(environmentId, { allLocal = false } = {}) {
      if (!ENVIRONMENT_PATTERN.test(String(environmentId || ''))) throw fail('Invalid host id.', 'invalid_params');
      let reply = await page(environmentId, { allLocal: allLocal === true });
      const { id, total } = reply;
      if (typeof id !== 'string' || !Number.isSafeInteger(total) || total < 0) throw fail('That host returned an unreadable answer.', 'remote_failed');
      if (total > MAX_SNAPSHOT_BYTES) throw fail('That host returned more history than the calendar can hold.', 'remote_too_large');
      let data = '', offset = 0, pages = 0;
      while (true) {
        if (++pages > MAX_PAGES) throw fail('That host returned more pages than the calendar can hold.', 'remote_too_large');
        if (reply.id !== id || reply.total !== total || reply.offset !== offset || typeof reply.chunk !== 'string') {
          throw fail('That host’s history changed while it was being read. Refresh to try again.', 'remote_failed');
        }
        data += reply.chunk; offset += reply.chunk.length;
        if (reply.next === null) break;
        if (reply.next !== offset || offset >= total || !reply.chunk.length) throw fail('That host returned an invalid page.', 'remote_failed');
        reply = await page(environmentId, { id, offset });
      }
      if (data.length !== total) throw fail('That host returned incomplete history. Refresh to try again.', 'remote_failed');
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw fail('That host returned unreadable history.', 'remote_failed'); }
      if (!parsed || !Array.isArray(parsed.sessions)) throw fail('That host returned history in an unexpected shape.', 'remote_failed');
      return parsed;
    }
  };
}
