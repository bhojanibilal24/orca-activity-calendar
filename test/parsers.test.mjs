import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, materialize, projectFromPath, cleanText } from '../src/parsers.mjs';

const at = n => `2026-11-02T10:${String(n).padStart(2, '0')}:00Z`;
const record = (type, minute, payload) => ({ type, timestamp: at(minute), payload });
test('Codex uses explicit turn boundaries and ignores idle gaps', () => {
  const p = createParser('Codex', '/session.jsonl');
  p.consume(record('session_meta', 0, { id: 'one', cwd: '/home/me/orca/workspaces/Atlas/feature' }));
  p.consume(record('event_msg', 0, { type: 'task_started', turn_id: 't1' }));
  p.consume(record('response_item', 0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build search' }] }));
  p.consume(record('event_msg', 5, { type: 'task_complete', turn_id: 't1', last_agent_message: 'Added search.' }));
  p.consume(record('event_msg', 30, { type: 'task_started', turn_id: 't2' }));
  p.consume(record('event_msg', 40, { type: 'task_complete', turn_id: 't2' }));
  const s = materialize(p.finish());
  assert.equal(s.title, 'Build search'); assert.equal(s.summary, 'Added search.'); assert.equal(s.project, 'Atlas');
  assert.equal(s.turns.reduce((n, t) => n + t.end - t.start, 0), 15 * 60_000);
});
test('unfinished old turns end at last recorded activity and never accumulate idle days', () => {
  const p = createParser('Codex', 'session.jsonl');
  p.consume(record('session_meta', 0, { id: 'one' }));
  p.consume(record('event_msg', 0, { type: 'task_started' }));
  p.consume(record('event_msg', 4, { type: 'token_count' }));
  const s = materialize(p.finish(), { now: Date.parse('2026-12-01T00:00:00Z') });
  assert.equal(s.live, false); assert.equal(s.turns[0].end, Date.parse(at(4)));
});
test('unfinished recently modified turns are live and grow only until now', () => {
  const p = createParser('Codex', 'session.jsonl');
  p.consume(record('session_meta', 0, { id: 'one' })); p.consume(record('event_msg', 0, { type: 'task_started' }));
  const s = materialize(p.finish(), { now: Date.parse(at(2)), modifiedAt: Date.parse(at(1)) });
  assert.equal(s.live, true); assert.equal(s.turns[0].end, Date.parse(at(2)));
});
test('an unclosed previous turn does not bridge an idle gap into the next turn', () => {
  const p = createParser('Codex', 'session.jsonl');
  p.consume(record('event_msg', 0, { type: 'task_started' }));
  p.consume(record('event_msg', 3, { type: 'token_count' }));
  p.consume(record('event_msg', 30, { type: 'task_started' }));
  p.consume(record('event_msg', 35, { type: 'task_complete' }));
  const s = p.finish(); assert.equal(s.turns.length, 2); assert.equal(s.turns[0].end, Date.parse(at(3)));
});
test('Claude tool results do not create new user turns', () => {
  const p = createParser('Claude', '/sessions/one.jsonl');
  p.consume({ type: 'user', timestamp: at(0), sessionId: 'claude-one', cwd: '/repo/Atlas', message: { content: 'Fix navigation' } });
  p.consume({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use' }], stop_reason: 'tool_use' } });
  p.consume({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', content: 'done' }] } });
  p.consume({ type: 'assistant', timestamp: at(5), message: { content: [{ type: 'text', text: 'Fixed the drawer.' }], stop_reason: 'end_turn' } });
  const s = materialize(p.finish()); assert.equal(s.turns.length, 1); assert.equal(s.turns[0].end - s.turns[0].start, 5 * 60_000);
  assert.equal(s.summary, 'Fixed the drawer.'); assert.equal(s.title, 'Fix navigation');
});
test('environment metadata is removed from task titles', () => {
  assert.equal(cleanText('<environment_context>private details</environment_context>\nBuild a calendar'), 'Build a calendar');
  assert.equal(projectFromPath('C:\\Users\\me\\orca\\workspaces\\Atlas\\branch'), 'Atlas');
});
test('Codex titles skip injected setup records and use the actual task', () => {
  const p = createParser('Codex', 'session.jsonl');
  for (const text of ['# AGENTS.md instructions for /repo\nInstructions...', '<environment_context>cwd</environment_context>', 'Fix the mobile navigation drawer']) {
    p.consume(record('response_item', 0, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }));
  }
  assert.equal(p.finish().title, 'Fix the mobile navigation drawer');
});
test('Codex explicit-turn titles can come from user_message events', () => {
  const p = createParser('Codex', 'session.jsonl');
  p.consume(record('event_msg', 0, { type: 'task_started' }));
  p.consume(record('event_msg', 0, { type: 'user_message', message: 'Build a calendar' }));
  assert.equal(p.finish().title, 'Build a calendar');
});
