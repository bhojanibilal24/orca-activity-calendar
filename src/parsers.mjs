import { unionIntervals } from './intervals.mjs';

const stamp = value => typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content
  .filter(x => x.type === 'text' || x.type === 'input_text' || x.type === 'output_text').map(x => x.text || '').join('\n') : '';
export function cleanText(text, length = 220) {
  return String(text || '').replace(/<(environment_context|user_instructions|permissions instructions|system_reminder|system-reminder|INSTRUCTIONS|instructions)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function promptTitle(text) {
  const value = String(text || '').trim();
  // These are injected user-role setup records, rather than the person's task.
  if (/^(?:#\s*AGENTS\.md instructions for\b|<environment_context>|<user_instructions>|<permissions instructions>|<skills_instructions>|Another language model started to solve this problem)/i.test(value)) {
    return /^(?:<environment_context>|<user_instructions>)/i.test(value) ? cleanText(value) : '';
  }
  return cleanText(value.replace(/^[\s\S]*?## My request for Codex:\s*/i, ''));
}

export function projectFromPath(cwd) {
  const parts = String(cwd || '').replaceAll('\\', '/').split('/').filter(Boolean);
  const workspace = parts.lastIndexOf('workspaces');
  if (workspace >= 0 && parts[workspace + 1]) return parts[workspace + 1];
  return parts.at(-1) || 'Unassigned';
}

export function createParser(agent, file) {
  const state = { agent, id: '', cwd: '', title: '', summary: '', model: '', isSubagent: /[/\\]subagents[/\\]/.test(file),
    turns: [], open: null, lastAt: 0, inferred: false, explicit: false };
  let firstPrompt = '';
  const close = (end, estimated = false) => {
    if (state.open && Number.isFinite(end) && end > state.open.start) state.turns.push({ start: state.open.start, end, estimated });
    state.open = null;
  };
  return {
    consume(d) {
      const at = stamp(d.timestamp); const previousAt = state.lastAt;
      if (Number.isFinite(at)) state.lastAt = Math.max(state.lastAt, at);
      if (agent === 'Codex') {
        const p = d.payload || {};
        if (d.type === 'session_meta') {
          state.id = p.id || p.session_id || ''; state.cwd = p.cwd || '';
          state.isSubagent ||= !!p.source?.subagent || !!p.thread_source?.subagent || p.thread_source === 'subagent';
        }
        if (d.type === 'turn_context') { state.cwd ||= p.cwd || ''; state.model = p.model || state.model; }
        if (d.type === 'event_msg' && p.type === 'task_started') {
          if (state.open) close(previousAt, true);
          state.open = { start: stamp(p.started_at) || at, turnId: p.turn_id }; state.explicit = true;
        }
        if (d.type === 'event_msg' && ['task_complete', 'turn_aborted', 'task_aborted'].includes(p.type)) {
          if (!state.open || !p.turn_id || !state.open.turnId || state.open.turnId === p.turn_id) close(at);
          const summary = cleanText(p.last_agent_message || p.message, 500); if (summary) state.summary = summary;
        }
        if (d.type === 'event_msg' && p.type === 'user_message') {
          firstPrompt ||= promptTitle(p.message);
          if (!state.explicit) {
            if (state.open) close(previousAt, true); state.open = { start: at }; state.inferred = true;
          }
        }
        if (d.type === 'response_item' && p.type === 'message') {
          if (p.role === 'user') firstPrompt ||= promptTitle(textOf(p.content));
          if (p.role === 'assistant' && p.phase === 'final_answer') { state.summary = cleanText(textOf(p.content), 500); if (!state.explicit) close(at, true); }
        }
        if (d.type === 'event_msg' && p.type === 'agent_message') state.summary = cleanText(p.message, 500) || state.summary;
      } else {
        state.id ||= d.sessionId || d.session_id || ''; state.cwd ||= d.cwd || '';
        const msg = d.message || {};
        if (d.type === 'summary' || d.type === 'ai-title') state.title = cleanText(d.summary || d.aiTitle);
        const isPrompt = d.type === 'user' && !d.isMeta && (typeof msg.content === 'string' ||
          (Array.isArray(msg.content) && msg.content.some(x => x.type === 'text') && !msg.content.some(x => x.type === 'tool_result')));
        if (isPrompt) {
          if (state.open) close(previousAt, true);
          if (Number.isFinite(at)) state.open = { start: at };
          firstPrompt ||= promptTitle(textOf(msg.content)); state.inferred = true;
        }
        if (d.type === 'assistant') {
          state.model = msg.model || state.model;
          const summary = cleanText(textOf(msg.content), 500); if (summary) state.summary = summary;
          if (msg.stop_reason === 'end_turn') close(at);
        }
        if (d.type === 'system' && d.subtype === 'turn_duration') close(at);
      }
    },
    finish() {
      state.title ||= firstPrompt || `${agent} session`;
      state.turns = unionIntervals(state.turns);
      return state;
    }
  };
}

export function materialize(state, { now = Date.now(), modifiedAt = 0 } = {}) {
  const live = !!state.open && now - Math.max(modifiedAt, state.lastAt) < 3 * 60_000;
  const turns = [...state.turns];
  if (state.open && Number.isFinite(state.open.start)) {
    const end = live ? Math.max(state.lastAt, now) : state.lastAt;
    if (end > state.open.start) turns.push({ start: state.open.start, end, estimated: !live });
  }
  return { key: `${state.agent}:${state.id}`, id: state.id, agent: state.agent, title: state.title, summary: state.summary,
    cwd: state.cwd, project: projectFromPath(state.cwd), model: state.model, isSubagent: state.isSubagent,
    turns: unionIntervals(turns), live, inferred: state.inferred, lastAt: state.lastAt };
}
