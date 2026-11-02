export const MINUTE = 60_000;
export const QUARTER = 15 * MINUTE;

export function unionIntervals(intervals) {
  const sorted = intervals.filter(x => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .map(x => ({ start: x.start, end: x.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const item of sorted) {
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push(item);
  }
  return result;
}

export function duration(intervals) {
  return unionIntervals(intervals).reduce((n, x) => n + x.end - x.start, 0);
}

export function clipped(intervals, start, end) {
  return intervals.map(x => ({ ...x, start: Math.max(start, x.start), end: Math.min(end, x.end) }))
    .filter(x => x.end > x.start);
}

export function mergeTurns(turns, gapMinutes = 30) {
  const result = [];
  for (const turn of unionIntervals(turns)) {
    const last = result.at(-1);
    if (last && turn.start - last.end <= gapMinutes * MINUTE) {
      last.end = Math.max(last.end, turn.end);
      last.activeMs += turn.end - turn.start;
    } else result.push({ ...turn, activeMs: turn.end - turn.start });
  }
  return result.map(x => ({ ...x, start: Math.floor(x.start / QUARTER) * QUARTER, end: Math.ceil(x.end / QUARTER) * QUARTER }));
}

export function peakConcurrency(sessions, start, end) {
  const events = [];
  // A session contributes at most one running agent, even if a transcript has duplicated turns.
  for (const session of sessions) for (const t of clipped(unionIntervals(session.turns), start, end)) {
    events.push([t.start, 1], [t.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, peak = 0;
  for (const [, delta] of events) { live += delta; peak = Math.max(peak, live); }
  return peak;
}

export function buildView(sessions, { start, end, gap = 30, project = '', agent = '', search = '', subagents = false } = {}) {
  const query = search.trim().toLowerCase();
  const filtered = sessions.filter(s => (subagents || !s.isSubagent) && (!project || s.project === project) &&
    (!agent || s.agent === agent) && (!query || [s.title, s.prompt, s.workspace, s.project, s.summary, s.id].some(v => v?.toLowerCase().includes(query))));
  const selected = filtered.map(s => ({ ...s, turns: clipped(s.turns, start, end) })).filter(s => s.turns.length);
  // Merge full turns before clipping: range boundaries must not alter block rounding or merging.
  const blocks = filtered.flatMap(s => clipped(mergeTurns(s.turns, gap), start, end).map((b, i) => ({
    ...b, key: `${s.key}:${b.start}:${i}`, sessionKey: s.key, title: s.title, project: s.project,
    agent: s.agent, workspace: s.workspace, cwd: s.cwd, live: s.live && b.end >= Date.now() - MINUTE, isSubagent: s.isSubagent
  })));
  const groups = new Map();
  for (const s of selected) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  const projects = [...groups].map(([name, list]) => ({ name, sessions: list.length,
    activeMs: list.reduce((n, s) => n + duration(s.turns), 0), wallMs: duration(list.flatMap(s => s.turns)),
    peak: peakConcurrency(list, start, end), blocks: unionIntervals(blocks.filter(b => b.project === name))
  })).sort((a, b) => b.activeMs - a.activeMs);
  return { sessions: selected, blocks, projects, metrics: {
    sessions: selected.length, activeMs: selected.reduce((n, s) => n + duration(s.turns), 0),
    wallMs: duration(selected.flatMap(s => s.turns)),
    calendarMs: filtered.reduce((n, s) => n + duration(clipped(mergeTurns(s.turns, gap), start, end)), 0),
    peak: peakConcurrency(selected, start, end)
  } };
}

export function layoutOverlaps(blocks) {
  const sorted = blocks.map(b => ({ ...b })).sort((a, b) => a.start - b.start || b.end - a.end);
  let group = [], groupEnd = -Infinity;
  const finish = () => {
    const lanes = [];
    for (const block of group) {
      let column = lanes.findIndex(end => end <= block.start);
      if (column < 0) column = lanes.length;
      lanes[column] = block.end; block.column = column;
    }
    for (const block of group) {
      block.columns = lanes.length; block.span = 1;
      // Use free lanes to the right until another block overlaps in time.
      for (let column = block.column + 1; column < lanes.length; column++) {
        if (group.some(other => other.column === column && other.start < block.end && other.end > block.start)) break;
        block.span++;
      }
    }
  };
  for (const block of sorted) {
    if (block.start >= groupEnd) { finish(); group = []; groupEnd = -Infinity; }
    group.push(block); groupEnd = Math.max(groupEnd, block.end);
  }
  finish();
  return sorted;
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function timesheetCSV(sessions, days) {
  const rows = [['Project', 'Thread', 'Agent', 'Session ID', ...days.map(d => d.label), 'Total hours']];
  for (const s of [...sessions].sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title))) {
    const values = days.map(d => duration(clipped(s.turns, d.start, d.end)) / 3_600_000);
    if (values.some(v => v > 0)) rows.push([s.project, s.title, s.agent, s.id,
      ...values.map(v => v.toFixed(2)), values.reduce((a, b) => a + b, 0).toFixed(2)]);
  }
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
