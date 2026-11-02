import { readdir, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { createParser, materialize } from './parsers.mjs';
import { OrcaMetadata } from './orca-metadata.mjs';

export function dataDirectory() {
  const home = homedir();
  if (platform() === 'darwin') return path.join(home, 'Library', 'Application Support', 'Orca Activity Calendar');
  if (platform() === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Orca Activity Calendar');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'orca-activity-calendar');
}

export function defaultSources(home = homedir()) {
  const orca = platform() === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Orca') :
    platform() === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Orca') :
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Orca');
  return [
    { agent: 'Codex', path: path.join(orca, 'codex-runtime-home', 'home', 'sessions'), managed: true },
    { agent: 'Codex', path: path.join(home, '.codex', 'sessions'), managed: false },
    { agent: 'Claude', path: path.join(home, '.claude', 'projects'), managed: false }
  ];
}

async function walk(directory, depth = 0) {
  if (depth > 12) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    // Never follow symlinks out of the configured session roots.
    if (entry.isDirectory()) files.push(...await walk(file, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
  }
  return files;
}

export async function parseFile(file, agent) {
  const parser = createParser(agent, file);
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 128 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) continue;
      // Tool outputs and reasoning aren't needed. Avoid decoding their potentially large bodies.
      if (agent === 'Codex' && !/"type"\s*:\s*"(?:session_meta|turn_context|event_msg)"/.test(line) &&
        !(/"type"\s*:\s*"response_item"/.test(line) && /"role"\s*:\s*"(?:user|assistant)"/.test(line))) continue;
      try { parser.consume(JSON.parse(line)); } catch { /* Partial final writes and malformed records are ignored. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  return parser.finish();
}

export class HistoryIndex {
  constructor({ directory = dataDirectory(), sources = defaultSources(), now = () => Date.now(), metadata = new OrcaMetadata() } = {}) {
    this.directory = directory; this.sources = sources; this.now = now;
    this.entries = new Map(); this.status = { scanning: false, indexedAt: null, scannedFiles: 0, errors: [], sources: [] };
    this.pending = null; this.metadata = metadata;
  }
  async refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    this.pending = this.scan(force).finally(() => { this.pending = null; this.status.scanning = false; });
    return this.pending;
  }
  async scan(force) {
    this.status.scanning = true; this.status.errors = []; this.status.sources = [];
    await this.metadata.refresh();
    const cacheDir = path.join(this.directory, 'cache-v2');
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const found = new Set(); const tasks = [];
    for (const source of this.sources) {
      try {
        const files = await walk(source.path);
        this.status.sources.push({ ...source, available: true, files: files.length });
        tasks.push(...files.map(file => ({ file, source })));
      } catch (error) {
        this.status.sources.push({ ...source, available: false, files: 0 });
        if (error.code !== 'ENOENT') this.status.errors.push(`Cannot read ${source.agent} history: ${error.code || error.message}`);
      }
    }
    this.status.totalFiles = tasks.length; this.status.scannedFiles = 0;
    let cursor = 0;
    const run = async () => {
      while (cursor < tasks.length) {
        const { file, source } = tasks[cursor++]; found.add(file);
        try {
          const info = await stat(file); const signature = `${info.size}:${info.mtimeMs}`;
          if (!force && this.entries.get(file)?.signature === signature) { this.status.scannedFiles++; continue; }
          const cachePath = path.join(cacheDir, createHash('sha256').update(file).digest('hex') + '.json');
          let entry;
          if (!force) { try { entry = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* First import. */ } }
          if (!entry || entry.signature !== signature) {
            const state = await parseFile(file, source.agent);
            entry = { signature, modifiedAt: info.mtimeMs, managed: source.managed || /[/\\]orca[/\\]workspaces[/\\]/i.test(state.cwd), state };
            // Cache only the small derived record, never full messages or tool output.
            const temporary = cachePath + `.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 }); await rename(temporary, cachePath);
          }
          this.entries.set(file, entry);
        } catch (error) {
          this.status.errors.push(`Skipped one ${source.agent} transcript: ${error.code || error.message}`);
        }
        this.status.scannedFiles++;
      }
    };
    await Promise.all([run(), run(), run()]);
    for (const file of this.entries.keys()) if (!found.has(file)) this.entries.delete(file);
    this.status.indexedAt = this.now();
    return this.snapshot();
  }
  snapshot({ allLocal = false } = {}) {
    const sessions = new Map();
    for (const entry of this.entries.values()) {
      if ((!allLocal && !entry.managed) || !entry.state.id) continue;
      const session = materialize(entry.state, { now: this.now(), modifiedAt: entry.modifiedAt });
      if (!session.turns.length) continue;
      // Orca can copy a provider's session into its managed home. Merge turns by stable session ID.
      const previous = sessions.get(session.key);
      if (previous) {
        const newest = session.lastAt >= previous.lastAt ? session : previous;
        sessions.set(session.key, { ...newest, turns: [...previous.turns, ...session.turns], live: previous.live || session.live });
      } else sessions.set(session.key, session);
    }
    return { sessions: [...sessions.values()].map(session => this.metadata.decorate(session)).sort((a, b) => b.lastAt - a.lastAt),
      status: { ...this.status, naming: this.metadata.status, theme: this.metadata.data.theme } };
  }
}
