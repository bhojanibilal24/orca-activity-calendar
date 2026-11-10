import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

export function orcaDataDirectory(home = homedir()) {
  return platform() === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Orca') :
    platform() === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Orca') :
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Orca');
}

/** Compares paths the way both platforms write them, without resolving anything on disk. */
export function normalizePath(value) {
  const text = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return text === '' ? '' : text;
}

export function metadataFromDocuments({ workspaceSession = {}, worktreeMeta = {}, settings = {} } = {}) {
  const titles = new Map(), titlePriorities = new Map(), workspaces = new Map(), worktreePaths = new Set();
  for (const [id, meta] of Object.entries(worktreeMeta)) {
    const cwd = id.split('::').at(-1);
    if (meta.displayName) workspaces.set(cwd, meta.displayName);
    // Orca's own record of where its worktrees are. Server images keep them somewhere else
    // entirely from a laptop, so the paths are read rather than guessed.
    const normalized = normalizePath(cwd);
    if (/^(?:\/|[a-zA-Z]:\/)/.test(normalized)) worktreePaths.add(normalized);
  }
  const visit = (node, cwd = '', depth = 0, sourcePriority = 0) => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    cwd = node.worktreeId?.split('::').at(-1) || cwd;
    const named = node.aiVaultTitle;
    if (named?.agent && named.sessionId && named.title) {
      const agent = { codex: 'Codex', claude: 'Claude' }[named.agent.toLowerCase()];
      if (agent) {
        const key = `${agent}:${named.sessionId}`;
        const custom = [node.customLabel, node.customTitle].find(value => typeof value === 'string' && value.trim());
        // Unified tabs are Orca's current record; legacy tabs can contain stale names.
        // Within a source, never let a generated duplicate replace a custom name.
        const priority = sourcePriority * 2 + (custom ? 1 : 0);
        if (priority >= (titlePriorities.get(key) ?? -1)) {
          titles.set(key, { title: String(custom || named.title).slice(0, 220), cwd });
          titlePriorities.set(key, priority);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') visit(value, key.includes('::') ? key.split('::').at(-1) : cwd, depth + 1,
        key === 'unifiedTabs' ? 2 : key === 'tabsByWorktree' ? 1 : sourcePriority);
    }
  };
  visit(workspaceSession);
  return { titles, workspaces, worktreePaths, theme: ['dark', 'light'].includes(settings.theme) ? settings.theme : 'system' };
}

export class OrcaMetadata {
  constructor({ directory = orcaDataDirectory(), database } = {}) {
    this.directory = directory; this.database = database;
    this.data = metadataFromDocuments(); this.status = { available: false, namedSessions: 0 };
  }
  async refresh() {
    let db;
    try {
      let file = this.database;
      if (!file) {
        const index = JSON.parse(await readFile(path.join(this.directory, 'orca-profile-index.json'), 'utf8'));
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(index.activeProfileId)) throw new Error('Invalid profile ID');
        file = path.join(this.directory, 'profiles', index.activeProfileId, 'profile-state.db');
      }
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(file, { readOnly: true });
      // Read only naming/workspace/theme documents. Never load credentials or modify Orca state.
      const rows = db.prepare("SELECT domain, payload FROM profile_state_documents WHERE domain IN ('workspaceSession', 'worktreeMeta', 'settings')").all();
      this.data = metadataFromDocuments(Object.fromEntries(rows.map(row => [row.domain, JSON.parse(row.payload)])));
      this.status = { available: true, namedSessions: this.data.titles.size };
    } catch (error) {
      this.status = { available: false, namedSessions: this.data.titles.size, warning: 'Orca names unavailable; showing recorded task titles.' };
    } finally { db?.close(); }
  }
  /** Whether a path is inside one of this host's Orca worktrees. */
  isManagedPath(cwd) {
    const value = normalizePath(cwd);
    if (!value) return false;
    for (const root of this.data.worktreePaths || []) {
      if (value === root || value.startsWith(`${root}/`)) return true;
    }
    return false;
  }
  decorate(session) {
    const named = this.data.titles.get(session.key);
    return { ...session, prompt: session.title, title: named?.title || session.title, titleSource: named ? 'orca' : 'transcript',
      workspace: this.data.workspaces.get(session.cwd) || path.basename(session.cwd || '') || session.project };
  }
}
