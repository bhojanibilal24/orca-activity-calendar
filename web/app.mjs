import { buildView, duration, clipped, unionIntervals, layoutOverlaps, timesheetCSV } from '../src/intervals.mjs';
import { dateKey, addDays, rangeDays } from '../src/dates.mjs';
import { createCalendarClient } from './client.mjs';

const client = createCalendarClient();

const root = document.getElementById('app');
const icons = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2"/>',
  arrow: '<path d="m14 7-5 5 5 5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9zM2 14l10 6 10-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>'
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.calendar}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (d, options) => new Intl.DateTimeFormat(undefined, options).format(new Date(d));
const time = d => fmt(d, { hour: 'numeric', minute: '2-digit' });
const hours = ms => (ms / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 1 });
const shortDuration = ms => { if (!ms) return '0m'; const minutes = Math.round(ms / 60_000); return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`; };
const palette = ['#3975c6', '#8a5bb6', '#168377', '#c67c2f', '#bb5276', '#557d3a', '#5b62bd', '#ad634a'];
const hash = value => [...value].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 0);
const worktreeKey = value => String(value.cwd || value.workspace || value.sessionKey || value.key || 'Unassigned').replaceAll('\\', '/').replace(/\/+$/, '');
const worktreeName = value => value.workspace || value.cwd?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || value.project || 'Unassigned';
let savedColors = [];
try { savedColors = await client.loadColors(); } catch {}
const colorAssignments = new Map(Array.isArray(savedColors) ? savedColors.filter(item => Array.isArray(item) && typeof item[0] === 'string' && Number.isInteger(item[1]) && item[1] >= 0 && item[1] < 10000) : []);
let colorSaveTimer;
function color(value) {
  const key = worktreeKey(value);
  if (!colorAssignments.has(key)) {
    const used = new Set(colorAssignments.values());
    let n = Math.abs(hash(key)) % palette.length;
    for (let offset = 0; offset < palette.length && used.has(n); offset++) n = (n + 1) % palette.length;
    if (used.has(n)) { n = palette.length; while (used.has(n)) n++; }
    colorAssignments.set(key, n);
    clearTimeout(colorSaveTimer);
    colorSaveTimer = setTimeout(() => { void client.saveColors([...colorAssignments]).catch(() => {}); }, 100);
  }
  const n = colorAssignments.get(key);
  return palette[n] || `hsl(${((n - palette.length) * 137.508 + 205) % 360} 62% 46%)`;
}
function worktreesInView(view) {
  const groups = new Map();
  for (const session of view.sessions) {
    const key = worktreeKey(session);
    if (!groups.has(key)) groups.set(key, { key, cwd: session.cwd, workspace: worktreeName(session), project: session.project, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()].map(group => ({ ...group, blocks: view.blocks.filter(b => worktreeKey(b) === group.key) }));
}
const state = { anchor: new Date(), span: 1, page: 'calendar', grouping: 'threads', gap: 30, project: '', worktree: '', agent: '', search: '',
  filtersOpen: false, subagents: false, allLocal: false, snapshot: null, drawer: null, sourcesOpen: false, loading: true, error: '', errorCount: 0 };
let renderPending, refreshInFlight = false;
function scheduleRender() { clearTimeout(renderPending); renderPending = setTimeout(render, 80); }
function currentDays() { return rangeDays(state.anchor, state.page === 'timesheet' ? 7 : state.span); }
function currentView() {
  const days = currentDays();
  return buildView((state.snapshot?.sessions || []).filter(s => !state.worktree || worktreeKey(s) === state.worktree), { start: days[0].start, end: days.at(-1).end, gap: state.gap,
    project: state.project, agent: state.agent, search: state.search, subagents: state.subagents });
}
function calendarDuration(blocks) {
  const groups = new Map();
  for (const b of blocks) { const key = b.sessionKey || b.key; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(b); }
  return [...groups.values()].reduce((sum, items) => sum + duration(items), 0);
}

function rangeLabel(days) {
  const first = days[0].start, last = days.at(-1).start;
  if (days.length === 1) return fmt(first, { month: 'long', day: 'numeric', year: 'numeric' });
  const sameMonth = new Date(first).getMonth() === new Date(last).getMonth() && new Date(first).getFullYear() === new Date(last).getFullYear();
  return `${fmt(first, { month: 'short', day: 'numeric' })} – ${sameMonth ? new Date(last).getDate() : fmt(last, { month: 'short', day: 'numeric' })}, ${new Date(last).getFullYear()}`;
}

async function fetchSnapshot() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const allLocal = state.allLocal;
  try {
    const snapshot = await client.snapshot(allLocal);
    if (allLocal !== state.allLocal) return;
    state.snapshot = snapshot; state.error = ''; state.loading = false;
    render();
  } catch (error) { state.error = error.message; state.loading = false; render(); }
  finally { refreshInFlight = false; if (allLocal !== state.allLocal) void fetchSnapshot(); }
}

function metric(name, value, detail) {
  return `<div class="metric" title="${esc(detail)}"><div class="metric-label">${esc(name)}</div><div class="metric-value">${esc(value)}</div></div>`;
}
function render() {
  const previous = document.querySelector('.calendar-scroll, .timesheet-scroll');
  const scroll = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
  const focused = document.activeElement?.id, selection = document.activeElement?.selectionStart;
  const days = currentDays(), view = currentView(), worktrees = worktreesInView(view), status = state.snapshot?.status;
  root.innerHTML = `<main class="main" aria-label="Activity Calendar">
    <header class="toolbar"><div class="date-controls"><button class="icon-button" data-step="-1" aria-label="Previous period">${icon('arrow')}</button><button class="today-button" data-action="today">Today</button><button class="icon-button next" data-step="1" aria-label="Next period">${icon('arrow')}</button><h1>${esc(rangeLabel(days))}</h1></div>
      <div class="toolbar-options"><div class="segmented" aria-label="Group calendar">${['threads', 'projects'].map(group => `<button data-group="${group}" class="${state.grouping === group ? 'active' : ''}" aria-pressed="${state.grouping === group}">${group === 'threads' ? 'Threads' : 'Projects'}</button>`).join('')}</div>
      <div class="segmented" aria-label="Merge gap">${[15, 30, 60, 120].map(n => `<button data-gap="${n}" title="Combine activity in the same thread when the gap is ${n} minutes or less" class="${state.gap === n ? 'active' : ''}" aria-pressed="${state.gap === n}">${n < 60 ? n + 'm' : n / 60 + 'h'}</button>`).join('')}</div>
      <div class="segmented" aria-label="Calendar range">${[[1, 'Day'], [3, '3 days'], [7, 'Week']].map(([n, label]) => `<button data-span="${n}" class="${state.page === 'calendar' && state.span === n ? 'active' : ''}" aria-pressed="${state.page === 'calendar' && state.span === n}">${label}</button>`).join('')}<button data-page="timesheet" class="${state.page === 'timesheet' ? 'active' : ''}" aria-pressed="${state.page === 'timesheet'}">Time sheet</button></div>
      <button class="icon-button ${state.filtersOpen ? 'active' : ''}" data-action="filters" title="Search and filters" aria-label="Search and filters" aria-expanded="${state.filtersOpen}">${icon('search')}</button><button class="icon-button" data-action="export" title="Export CSV" aria-label="Export CSV">${icon('download')}</button><button class="icon-button" data-action="sources" title="Data sources" aria-label="Data sources">${icon('layers')}</button><button class="icon-button" data-action="refresh" title="Refresh history" aria-label="Refresh history">${icon('refresh')}</button></div></header>
    ${state.error ? `<div class="notice error" role="alert">${esc(state.error)} <button data-action="retry">Retry</button></div>` : ''}
    <section class="metrics" aria-label="Activity summary">${metric('Threads', view.metrics.sessions, 'Distinct provider sessions in this period')}${metric('On the calendar', shortDuration(view.metrics.calendarMs), `Merged within ${state.gap} minutes, rounded to 15-minute slots`)}${metric('Agent turns', shortDuration(view.metrics.activeMs), 'Recorded turn spans; parallel agents count separately. May include waits or pauses.')}${metric('Peak in parallel', view.metrics.peak, 'Maximum distinct sessions with overlapping recorded turns')}</section>
    ${state.filtersOpen ? `<div class="filters"><label class="search-control">${icon('search')}<input id="search" type="search" placeholder="Find an agent or task…" value="${esc(state.search)}" aria-label="Search tasks"></label><select id="project-filter" aria-label="Filter project"><option value="">All projects</option>${[...new Set((state.snapshot?.sessions || []).map(s => s.project))].sort().map(p => `<option ${state.project === p ? 'selected' : ''} value="${esc(p)}">${esc(p)}</option>`).join('')}</select><select id="agent-filter" aria-label="Filter agent"><option value="">All agents</option><option ${state.agent === 'Codex' ? 'selected' : ''}>Codex</option><option ${state.agent === 'Claude' ? 'selected' : ''}>Claude</option></select><button class="text-button" data-action="clear-filters">Clear filters</button></div>` : ''}
    <div class="worktree-legend" aria-label="Worktrees">${worktrees.map(w => `<button data-worktree="${esc(w.key)}" title="${esc(w.project + ' / ' + w.workspace + '\n' + (w.cwd || ''))}"><span class="color-dot" style="--project:${color(w)}"></span>${esc(w.workspace)} <span class="quiet">${shortDuration(calendarDuration(w.blocks))}</span></button>`).join('')}${state.project || state.worktree || state.search || state.agent ? '<button class="text-button" data-action="clear-filters">Clear filters</button>' : ''}</div>
    <section id="view-content">${!view.sessions.length ? emptyState(status) : state.page === 'timesheet' ? timesheet(view, days) : calendar(view, days)}</section>
    <footer class="view-footer"><span>Local history · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}${status?.scanning ? ' · Indexing…' : ''}${status?.errors?.length ? ` · ${status.errors.length} import warnings` : ''}</span><span title="Agent turn spans can include waits and pauses. These are not personal working hours.">${status?.naming?.available ? 'Orca agent names' : 'Recorded task titles'} · Agent time</span><button class="text-button" data-action="recap" title="Copy task titles and latest responses for the selected period">${icon('copy')}Copy work recap</button></footer>
    </main>${state.drawer ? detailDrawer(view) : ''}${state.sourcesOpen ? sourcesModal() : ''}`;
  const next = document.querySelector('.calendar-scroll, .timesheet-scroll');
  if (scroll && next) { next.scrollTop = scroll.top; next.scrollLeft = scroll.left; }
  if (focused && document.getElementById(focused)) {
    const input = document.getElementById(focused); input.focus({ preventScroll: true });
    if (typeof selection === 'number' && input.setSelectionRange) { try { input.setSelectionRange(selection, selection); } catch {} }
  }
}

function emptyState(status) {
  const scanning = state.loading || status?.scanning;
  return `<div class="empty-state">${icon(scanning ? 'refresh' : 'calendar')}<h3>${scanning ? 'Gathering your agent history…' : 'A little quiet here.'}</h3><p>${scanning ? 'Reading local session timestamps. Your first import can take a moment.' : state.search || state.project || state.worktree || state.agent ? 'No activity matches these filters. Try another project or search.' : 'No agent turns in this period. Choose a recent active week or check your data sources.'}</p>${!scanning && (state.snapshot?.sessions || []).length ? '<button class="button" data-action="latest">Go to latest activity</button>' : ''}${!scanning ? '<button class="text-button" data-action="sources">Check data sources</button>' : ''}</div>`;
}

function calendar(view, days) {
  let blocks = view.blocks;
  if (state.grouping === 'projects') blocks = view.projects.flatMap(p => p.blocks.map((b, i) => {
    const contributors = view.sessions.filter(s => s.project === p.name && s.turns.some(t => t.start < b.end && t.end > b.start));
    const worktrees = [...new Map(contributors.map(s => [worktreeKey(s), s])).values()];
    return { ...b, key: `project:${p.name}:${i}`, project: p.name, title: p.name, count: contributors.length,
      worktreeColors: worktrees.map(s => color(s)), worktreeCount: worktrees.length };
  }));
  const localHour = (at, day) => at >= day.end ? 24 : new Date(at).getHours() + new Date(at).getMinutes() / 60 + new Date(at).getSeconds() / 3600;
  const parts = days.map(day => blocks.filter(b => b.start < day.end && b.end > day.start).map(b => ({ ...b,
    start: Math.max(b.start, day.start), end: Math.min(b.end, day.end) })));
  const all = parts.flatMap((items, i) => items.map(b => ({ from: localHour(b.start, days[i]), to: localHour(b.end, days[i]) })));
  const firstHour = Math.max(0, Math.min(8, Math.floor(Math.min(...all.map(b => b.from))) - 1));
  const lastHour = Math.min(24, Math.max(18, Math.ceil(Math.max(...all.map(b => b.to))) + 1));
  const rowHeight = 52, height = (lastHour - firstHour) * rowHeight;
  return `<div class="calendar-scroll"><div class="calendar-grid" style="--days:${days.length};--grid-height:${height}px;--hour-height:${rowHeight}px"><div class="calendar-corner">${esc(fmt(days[0].start, { month: 'short' }).toUpperCase())}</div>${days.map((d, i) => `<button class="day-header ${d.label === dateKey(Date.now()) ? 'is-today' : ''} ${[0, 6].includes(new Date(d.start).getDay()) ? 'weekend' : ''}" data-day="${d.label}"><span>${fmt(d.start, { weekday: 'short' })}</span><strong>${new Date(d.start).getDate()}</strong><small>${hours(calendarDuration(clipped(view.blocks, d.start, d.end)))}h</small></button>`).join('')}
    <div class="time-axis" style="height:${height}px">${Array.from({ length: lastHour - firstHour }, (_, i) => `<span style="top:${i * rowHeight}px">${String((firstHour + i) % 12 || 12).padStart(2, '0')}<small>${firstHour + i < 12 ? 'AM' : 'PM'}</small></span>`).join('')}</div>${days.map((d, i) => `<div class="day-column ${[0, 6].includes(new Date(d.start).getDay()) ? 'weekend' : ''}">${layoutOverlaps(parts[i]).map(b => {
      const top = (localHour(b.start, d) - firstHour) * rowHeight, h = Math.max(20, (localHour(b.end, d) - localHour(b.start, d)) * rowHeight);
      return `<button class="work-block ${b.worktreeColors ? 'project-summary' : ''} ${h < 48 ? 'compact' : ''}" style="--project:${b.worktreeColors ? (b.worktreeColors.length === 1 ? b.worktreeColors[0] : 'var(--muted)') : color(b)};top:${top}px;height:${h - 2}px;left:calc(${b.column / b.columns * 100}% + 3px);width:calc(${(b.span || 1) * 100 / b.columns}% - 6px)" ${b.sessionKey ? `data-session="${esc(b.sessionKey)}"` : `data-project-detail="${esc(b.project)}"`} title="${esc(`${b.title}\n${time(b.start)} – ${time(b.end)}\n${b.workspace || b.project}`)}"><strong>${b.live ? '<span class="live-dot"></span>' : ''}${esc(b.title)}</strong><span class="block-time">${time(b.start)}–${time(b.end)}${b.count ? ` · ${b.count} threads` : ''}</span><span class="block-project">${esc(b.workspace || (b.worktreeCount ? `${b.worktreeCount} worktree${b.worktreeCount === 1 ? '' : 's'}` : b.project))}</span>${b.worktreeColors ? `<span class="worktree-color-band" aria-hidden="true">${b.worktreeColors.map(c => `<i style="background:${c}"></i>`).join('')}</span>` : ''}</button>`;
    }).join('')}${d.label === dateKey(Date.now()) && new Date().getHours() >= firstHour && new Date().getHours() < lastHour ? `<div class="now-line" style="top:${(new Date().getHours() + new Date().getMinutes() / 60 - firstHour) * rowHeight}px"><span></span></div>` : ''}</div>`).join('')}</div></div>`;
}

function timesheet(view, days) {
  const totals = days.map(d => view.sessions.reduce((n, s) => n + duration(clipped(s.turns, d.start, d.end)), 0));
  return `<div class="timesheet-scroll"><table class="timesheet"><caption class="sr-only">Recorded agent hours per thread and day</caption><thead><tr><th>PROJECT / THREAD</th>${days.map(d => `<th class="${d.label === dateKey(Date.now()) ? 'today-cell' : ''}">${fmt(d.start, { weekday: 'short' })}<small>${fmt(d.start, { month: 'short', day: 'numeric' })}</small></th>`).join('')}<th>TOTAL</th></tr></thead><tbody>${view.projects.map(p => `<tr class="project-table-row"><th colspan="${days.length + 2}">${esc(p.name)}<small>${p.sessions} threads</small></th></tr>${view.sessions.filter(s => s.project === p.name).map(s => `<tr><td><button class="thread-table-title" data-session="${esc(s.key)}"><span class="color-dot" style="--project:${color(s)}"></span>${esc(s.title)}</button><span class="agent-label">${esc(s.agent)} · ${esc(worktreeName(s))}${s.isSubagent ? ' · subagent' : ''}</span></td>${days.map(d => {
    const n = duration(clipped(s.turns, d.start, d.end)) / 3_600_000;
    return `<td class="numeric ${n ? '' : 'zero'}">${n ? n.toFixed(2) : '—'}</td>`;
  }).join('')}<td class="numeric total">${(duration(s.turns) / 3_600_000).toFixed(2)}</td></tr>`).join('')}`).join('')}</tbody><tfoot><tr><th>Total agent hours</th>${totals.map(n => `<td class="numeric">${(n / 3_600_000).toFixed(2)}</td>`).join('')}<td class="numeric">${(view.metrics.activeMs / 3_600_000).toFixed(2)}</td></tr></tfoot></table></div><div class="timesheet-note">${icon('clock')}Recorded turn time in decimal hours. Parallel agents count separately. Pauses within a turn may be included; gaps between turns and calendar rounding are excluded.</div>`;
}

function detailDrawer(view) {
  if (state.drawer.project) {
    const name = state.drawer.project; const list = view.sessions.filter(s => s.project === name);
    return `<div class="overlay" data-action="close-drawer"></div><aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="Project details" tabindex="-1"><button class="icon-button drawer-close" data-action="close-drawer" aria-label="Close details">${icon('close')}</button><div class="eyebrow">PROJECT ACTIVITY</div><h2>${esc(name)}</h2><p class="quiet">${list.length} threads in this period</p>${list.map(s => `<button class="drawer-session" data-session="${esc(s.key)}"><strong><span class="color-dot" style="--project:${color(s)}"></span>${esc(s.title)}</strong><small>${esc(worktreeName(s))} · ${esc(s.agent)} · ${shortDuration(duration(s.turns))}</small></button>`).join('')}</aside>`;
  }
  const session = (state.snapshot?.sessions || []).find(s => s.key === state.drawer.session);
  if (!session) return '';
  const turns = unionIntervals(session.turns), selected = view.sessions.find(s => s.key === session.key);
  return `<div class="overlay" data-action="close-drawer"></div><aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="Thread details" tabindex="-1"><button class="icon-button drawer-close" data-action="close-drawer" aria-label="Close details">${icon('close')}</button><div class="eyebrow">THREAD DETAILS</div><div class="detail-project" style="--project:${color(session)}"><span class="color-dot"></span>${esc(worktreeName(session))}<span class="agent-pill">${esc(session.agent)}</span></div><h2>${esc(session.title)}</h2><div class="detail-metrics"><div><strong>${shortDuration(duration(selected?.turns || []))}</strong><span>In this period</span></div><div><strong>${turns.length}</strong><span>Recorded turns</span></div></div>${session.titleSource === 'orca' && session.prompt ? `<h3>Original request</h3><p class="original-request">${esc(session.prompt)}</p>` : ''}<h3>Latest response</h3><p class="response-text">${esc(session.summary || 'No final response is available yet.')}</p><h3>Session</h3><dl class="session-data"><dt>Agent</dt><dd>${esc(session.agent)}${session.model ? ` · ${esc(session.model)}` : ''}</dd><dt>First activity</dt><dd>${fmt(turns[0].start, { dateStyle: 'medium', timeStyle: 'short' })}</dd><dt>Last activity</dt><dd>${fmt(turns.at(-1).end, { dateStyle: 'medium', timeStyle: 'short' })}</dd><dt>Workspace</dt><dd>${esc(session.workspace || session.project)}</dd><dt>Path</dt><dd class="path-text">${esc(session.cwd)}</dd><dt>Name source</dt><dd>${session.titleSource === 'orca' ? 'Orca agent name' : 'First recorded request'}</dd><dt>Session ID</dt><dd class="path-text">${esc(session.id)}</dd></dl><button class="button" data-copy-session="${esc(session.key)}">${icon('copy')}Copy session ID</button><h3>Recent turns</h3><div class="turn-list">${[...turns].reverse().slice(0, 30).map(t => `<div><span>${fmt(t.start, { month: 'short', day: 'numeric' })} · ${time(t.start)}–${time(t.end)}</span><strong>${shortDuration(t.end - t.start)}</strong></div>`).join('')}</div><p class="quiet detail-note">Read from local provider transcripts. ${session.agent === 'Claude' ? 'Claude turn timing is reconstructed from messages.' : 'Codex uses recorded turn boundaries when available.'}</p></aside>`;
}

function sourcesModal() {
  const status = state.snapshot?.status;
  return `<div class="overlay" data-action="close-sources"></div><section class="sources-modal" role="dialog" aria-modal="true" aria-label="Data sources" tabindex="-1"><button class="icon-button drawer-close" data-action="close-sources" aria-label="Close data sources">${icon('close')}</button><h2>Data sources</h2><p class="modal-intro">The calendar reads timestamps, task titles, and short response excerpts from local Codex and Claude session logs. It never changes those logs or sends them to an external service.</p><p class="naming-status">${status?.naming?.available ? `Names match Orca’s active profile (${status.naming.namedSessions} named sessions).` : 'Orca names are unavailable. Task titles from transcripts are shown as a fallback.'}</p><div class="source-list">${status?.sources?.length ? status.sources.map(s => `<div class="source-item"><div>${icon(s.available ? 'check' : 'dot')}<strong>${esc(s.agent)}${s.managed ? ' · Orca managed' : ''}</strong><span>${s.available ? `${s.files} files` : 'Not found'}</span></div><code>${esc(s.path)}</code></div>`).join('') : '<p class="quiet">History sources appear here after the first scan.</p>'}</div><label class="setting-row"><div><strong>Include sessions outside Orca</strong><p>Show all sessions found in these provider folders.</p></div><input id="all-local" type="checkbox" ${state.allLocal ? 'checked' : ''}></label><label class="setting-row"><div><strong>Include subagents</strong><p>Include child sessions with their own transcript. They add to agent hours and concurrency.</p></div><input id="subagents" type="checkbox" ${state.subagents ? 'checked' : ''}></label><p class="coverage-note">Coverage: local Codex and Claude JSONL sessions. Other providers, remote hosts, deleted logs, and native chats without provider transcripts are not included. These are agent hours, not a measure of your personal attendance.</p>${status?.errors?.length ? `<div class="import-warnings">${status.errors.slice(0, 5).map(e => `<p>${esc(e)}</p>`).join('')}</div>` : ''}<button class="button primary" data-action="refresh">${icon('refresh')}Refresh history</button></section>`;
}

function toast(message) {
  const node = document.getElementById('toast'); node.textContent = message; node.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('visible'), 3000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable. Select and copy the text manually.'); }
}
async function exportCSV() {
  try {
    const result = await client.saveCSV(timesheetCSV(currentView().sessions, currentDays()), `orca-activity-${currentDays()[0].label}.csv`);
    if (result.status === 'saved') toast('Timesheet exported');
  } catch (error) { toast(error.message); }
}
function openModal() {
  render(); const modal = document.querySelector('[role="dialog"]'); modal?.focus();
}
root.addEventListener('click', async event => {
  const button = event.target.closest('button, [data-action]'); if (!button || button.disabled) return;
  const d = button.dataset;
  if (d.page) { state.page = d.page; state.drawer = null; render(); }
  else if (d.step) { state.anchor = addDays(state.anchor, Number(d.step) * currentDays().length); render(); }
  else if (d.span) { state.span = Number(d.span); state.page = 'calendar'; render(); }
  else if (d.group) { state.grouping = d.group; state.page = 'calendar'; render(); }
  else if (d.gap) { state.gap = Number(d.gap); render(); }
  else if (d.day) { state.anchor = new Date(d.day + 'T12:00:00'); state.span = 1; render(); }
  else if (d.worktree) { state.worktree = state.worktree === d.worktree ? '' : d.worktree; render(); }
  else if (d.project) { state.project = state.project === d.project ? '' : d.project; render(); }
  else if (d.session) { state.drawer = { session: d.session }; openModal(); }
  else if (d.projectDetail) { state.drawer = { project: d.projectDetail }; openModal(); }
  else if (d.copySession) copy((state.snapshot?.sessions || []).find(s => s.key === d.copySession)?.id || '');
  else if (d.action === 'filters') { state.filtersOpen = !state.filtersOpen; render(); if (state.filtersOpen) document.getElementById('search')?.focus(); }
  else if (d.action === 'clear-filters') { state.project = ''; state.worktree = ''; state.agent = ''; state.search = ''; render(); }
  else if (d.action === 'recap') { const view = currentView(); copy(`Agent work · ${rangeLabel(currentDays())}\n\n` + view.sessions.map(s => `- [${s.workspace || s.project}] ${s.title} (${s.agent}, ${shortDuration(duration(s.turns))})${s.summary ? `\n  Latest response: ${s.summary}` : ''}`).join('\n')); }
  else if (d.action === 'today') { state.anchor = new Date(); render(); }
  else if (d.action === 'latest') { state.anchor = new Date(Math.max(...(state.snapshot?.sessions || []).flatMap(s => s.turns.map(t => t.end)))); render(); }
  else if (d.action === 'sources') { state.sourcesOpen = true; openModal(); }
  else if (d.action === 'close-sources') { state.sourcesOpen = false; render(); }
  else if (d.action === 'close-drawer') { state.drawer = null; render(); }
  else if (d.action === 'export') exportCSV();
  else if (d.action === 'retry') fetchSnapshot();
  else if (d.action === 'refresh') {
    try { toast('Checking for new activity…'); await client.refresh(); await fetchSnapshot();
    } catch (error) { toast(error.message); }
  }
});
root.addEventListener('input', event => { if (event.target.id === 'search') { state.search = event.target.value; scheduleRender(); } });
root.addEventListener('change', event => {
  const { id, value, checked } = event.target;
  if (id === 'project-filter') state.project = value;
  if (id === 'agent-filter') state.agent = value;
  if (id === 'gap') state.gap = Number(value);
  if (id === 'all-local') { state.allLocal = checked; fetchSnapshot(); return; }
  if (id === 'subagents') state.subagents = checked;
  render();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { state.drawer = null; state.sourcesOpen = false; render(); }
  const dialog = document.querySelector('[role="dialog"]');
  if (event.key === 'Tab' && dialog) {
    const focusable = [...dialog.querySelectorAll('button, input, select, a[href]')].filter(x => !x.disabled);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
render();
try { client.onChange(() => { if (!document.hidden && !state.drawer && !state.sourcesOpen) void fetchSnapshot(); }); } catch (error) { state.error = error.message; }
await fetchSnapshot();
setInterval(() => { if (!document.hidden && !state.drawer && !state.sourcesOpen && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) fetchSnapshot(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.drawer && !state.sourcesOpen && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) fetchSnapshot(); });
