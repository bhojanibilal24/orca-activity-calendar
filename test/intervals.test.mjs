import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, unionIntervals, mergeTurns, peakConcurrency, buildView, layoutOverlaps, timesheetCSV, clipped } from '../src/intervals.mjs';
import { rangeDays } from '../src/dates.mjs';

const hour = 3_600_000;
const session = (id, turns, project = 'Test') => ({ key: id, id, title: id, project, agent: 'Codex', turns });
test('duplicate and overlapping turns count once per session', () => {
  assert.equal(duration([{ start: 0, end: 10 }, { start: 0, end: 10 }, { start: 5, end: 15 }]), 15);
  assert.deepEqual(unionIntervals([{ start: 10, end: 5 }, { start: NaN, end: 20 }]), []);
});
test('merging and rounding affects calendar time but not agent running time', () => {
  const turns = [{ start: hour + 60_000, end: hour + 120_000 }, { start: hour + 20 * 60_000, end: hour + 22 * 60_000 }];
  const merged = mergeTurns(turns, 30);
  assert.equal(merged.length, 1); assert.equal(duration(merged), hour / 2); assert.equal(duration(turns), 180_000);
  assert.equal(mergeTurns(turns, 15).length, 2);
});
test('adjacent agents do not contribute to peak concurrency', () => {
  assert.equal(peakConcurrency([session('a', [{ start: 0, end: hour }]), session('b', [{ start: hour, end: 2 * hour }])], 0, 2 * hour), 1);
});
test('parallel time is summed while elapsed time is unioned', () => {
  const view = buildView([session('a', [{ start: 0, end: hour }]), session('b', [{ start: 0, end: hour }])], { start: 0, end: 2 * hour });
  assert.equal(view.metrics.activeMs, 2 * hour); assert.equal(view.metrics.wallMs, hour); assert.equal(view.metrics.peak, 2);
  assert.equal(view.projects[0].blocks.length, 1); assert.equal(view.projects[0].sessions, 2);
});
test('date range clipping prevents outside turns and blocks from adding hours', () => {
  const view = buildView([session('a', [{ start: -hour, end: 3 * hour }])], { start: 0, end: hour });
  assert.equal(view.metrics.activeMs, hour); assert.equal(view.metrics.calendarMs, hour);
  assert.deepEqual(clipped([{ start: -2, end: 5 }], 0, 3), [{ start: 0, end: 3 }]);
});
test('subagents are excluded by default and included explicitly', () => {
  const s = { ...session('child', [{ start: 0, end: hour }]), isSubagent: true };
  assert.equal(buildView([s], { start: 0, end: hour }).metrics.sessions, 0);
  assert.equal(buildView([s], { start: 0, end: hour, subagents: true }).metrics.sessions, 1);
});
test('filters affect all metrics and blocks consistently', () => {
  const list = [session('Fix settings', [{ start: 0, end: hour }], 'One'), session('Review', [{ start: 0, end: hour }], 'Two')];
  const v = buildView(list, { start: 0, end: hour, project: 'One', search: 'SETTINGS', agent: 'Codex' });
  assert.equal(v.metrics.sessions, 1); assert.equal(v.blocks.length, 1); assert.equal(v.projects.length, 1);
});
test('overlap layout assigns enough lanes for a connected group and resets afterward', () => {
  const a = layoutOverlaps([{ start: 0, end: 10 }, { start: 1, end: 4 }, { start: 3, end: 7 }, { start: 10, end: 15 }]);
  assert.deepEqual(a.map(x => [x.column, x.columns]), [[0, 3], [1, 3], [2, 3], [0, 1]]);
  const expanded = layoutOverlaps([{ start: 0, end: 10 }, { start: 1, end: 5 }, { start: 2, end: 4 }, { start: 6, end: 8 }]);
  assert.equal(expanded[3].span, 2); // Two lanes are free after the early overlapping turns end.
  assert.equal(expanded[0].span, 1);
});
test('timesheet divides cross-midnight turns at civil day boundaries', () => {
  const days = rangeDays(new Date(2026, 10, 2), 3);
  const s = session('overnight', [{ start: days[0].end - hour / 2, end: days[1].start + hour }]);
  const csv = timesheetCSV([s], days);
  assert.match(csv, /"0.50","1.00","0.00","1.50"/);
});
test('CSV escapes spreadsheet formulas, quotes, and line breaks', () => {
  const csv = timesheetCSV([{ ...session('x', [{ start: 0, end: hour }], '=HYPERLINK("evil")'), title: '+SUM(1,2)\nnext' }], [{ label: 'day', start: 0, end: hour }]);
  assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"')); assert.ok(csv.includes('"\'+SUM(1,2)\nnext"'));
});
test('Monday weeks and calendar-day increments remain correct across daylight saving changes', () => {
  const old = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const days = rangeDays(new Date(2026, 10, 1), 3);
    assert.equal(days[0].end - days[0].start, 25 * hour);
    assert.equal(days[1].label, '2026-11-02');
    assert.equal(rangeDays(new Date(2026, 10, 1), 7)[0].label, '2026-10-26');
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
