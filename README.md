# Activity Calendar for Orca

A local calendar of coding-agent work: see what ran, when threads overlapped, and what each session worked on. Inspired by the workflows in [BB’s Agent Calendar](https://getbb.app/marketplace/agent-calendar); this is an independent implementation for Orca, with no BB code or assets.

## Features

- Day, three-day, and Monday-starting week calendars, colored by worktree. Agents in the same worktree share a color; different worktrees use distinct colors. Color choices persist in the plugin’s own storage when switching dates or reopening the calendar.
- Threads and Projects grouping. Threads retain their worktree colors; merged project blocks show a color strip for each contributing worktree. Click to inspect task titles, response excerpts, session IDs, and recorded turns.
- Distinct thread count, recorded agent turn time, rounded calendar hours, and peak parallel agents.
- Weekly decimal-hour timesheets and spreadsheet-safe CSV export.
- Copyable work recaps made from Orca agent names and latest recorded responses.
- Project, provider, and text filters; optional inclusion of subagents and sessions outside Orca.
- Native calendar panel in Orca’s right sidebar, opening in Day view by default, with three-day, week, and timesheet views also available.
- Uses Orca’s saved agent names and workspace names, matched by provider session ID.
- Orca light/dark preference, neutral color tokens, and bundled Geist font.
- Incremental history import, live updates, keyboard-accessible controls, and responsive layouts.

## Install in Orca

Requires **Orca 1.4.246 or later**, with its supported panel-to-worker bridge. This release contributes a **calendar icon in Orca’s right sidebar**. Clicking it opens the live calendar inside that panel.

The [community listing](https://www.onorca.dev/plugins/bhojanibilal24/orca-activity-calendar) provides the install link once Orca’s directory has indexed the release. This plugin has been tested on macOS with Orca 1.4.246; Windows and Linux have not yet been verified.

To install from source, build the installable folder with Node.js 22.13 or later. No packages need to be installed.

1. Run `npm run package`.
2. In Orca, open **Settings → Plugins** and turn on plugins if needed.
3. Choose **Install plugin → Local folder** and select `dist/bhojanibilal24.activity-calendar`.
4. Review the worker access and enable it.
5. Click **Activity Calendar** (the calendar icon) in the **right sidebar**. Resize the panel to see more days.

The sidebar uses Orca’s supported worker bridge for local history, the native save dialog for CSV, and Orca’s live theme tokens. Day is preselected whenever the panel loads. The refresh button and **Activity Calendar: Refresh History** command rescan history; agent-status events and a 15-second incremental scan update an open calendar. Orca may stop an idle worker and restart it on the next panel request.

A folder may also be loaded during development using `orca plugin dev load . --json`. If Orca asks for approval, review its reported access before approving the exact fingerprint. `orca plugin open bhojanibilal24.activity-calendar --panel calendar --json` opens a loaded panel (the plugin key reported by Orca takes precedence).

## Data and access

The worker is ordinary Node code and has access to the user’s filesystem and processes, as Orca explains in its plugin review. Its host capabilities are **`agent:read`** (refresh when agent status changes) and **`storage:own`** (keep worktree colors in the plugin’s own store). This implementation:

- **Reads Orca naming metadata, read-only**, from the active profile’s `profile-state.db`: only the `workspaceSession`, `worktreeMeta`, and `settings` documents. Session IDs match Orca’s agent names, custom names take priority, and the original request remains in thread details. If a saved name is unavailable, the first recorded task is shown. No Orca state is modified. A future Orca schema change may need an adapter update.
- **Reads local provider JSONL files** under `~/.codex/sessions`, Orca’s managed `codex-runtime-home/home/sessions`, and `~/.claude/projects` (using the standard platform-specific Orca application-data directory).
- Stores a small derived index under **Orca Activity Calendar** in your operating system’s application-data directory. The cache contains task titles, short response excerpts, paths, model names, session IDs, and turn timestamps. It does not copy full transcripts or tool output.
- Sends derived history to its own sidebar through Orca’s bridge, in consistent chunks below its message-size limit. The installed plugin does not start a local HTTP server or open browser tabs. Worktree colors use the plugin’s own storage.

By default, only sessions in Orca workspace paths and Orca’s managed session home are shown. **Data sources → Include sessions outside Orca** shows other sessions in the same provider folders. SSH hosts, OpenCode, Pi, other providers, and native chats without provider JSONL transcripts are not indexed. Missing or deleted logs cannot be recovered. Symlinked session directories are not followed.

Cache files are private to the OS user (directory mode `0700`, file mode `0600` on POSIX). Deleting the derived cache directory clears it; the next import rebuilds it from the provider logs. The cache lives outside the repository and release package.

## What the numbers mean

**Threads** means distinct provider sessions with a recorded turn during the selected period, not the number of prompts or necessarily the number of distinct processes. Subagents are excluded by default.

**Agent turn time** sums recorded turn intervals for each thread. Two agents working simultaneously for an hour count as two agent hours. Duplicate or overlapping records of the same session count once. Codex uses explicit `task_started`/`task_complete` boundaries where available; older Codex and Claude turns are reconstructed from message timestamps. Missing completions end at the last recorded activity, rather than counting the following idle days. A recently active unfinished turn is provisionally live for up to three minutes after its last file modification; its duration settles when the completion is recorded.

A recorded turn can include permission waits, process suspension, or computer sleep. Turn time is the span between recorded boundaries, not CPU time; a provider’s separately reported computation duration may differ.

**Calendar blocks** merge turns separated by at most 30 minutes (configurable to 15m, 1h, or 2h), then round outward to 15-minute slots. These display hours include merged gaps and rounding. **Timesheets and CSV always use recorded turn time**, not calendar display time.

**Peak parallel** is the maximum number of distinct sessions with overlapping recorded turns. An end and a start at the same timestamp do not overlap. **Elapsed activity** unions all running intervals so simultaneous work counts once. Calendar days and timesheets use the browser’s local timezone, including daylight saving boundaries.

The work recap quotes agent names and latest response excerpts; it does not independently verify that a task completed or invent commit/PR outcomes. These metrics describe **agent work, not human attendance or personal working time**.

## Development and checks

```sh
npm test
npm run check
npm run package
```

Pure interval and parser tests cover overlap, duplicate transcripts, clipping, missing turn completions, midnight/DST boundaries, and CSV formula injection. History-index tests cover duplicate provider copies, partial transcript writes, cache reuse, and missing provider folders. Worker and client tests verify real-index transport, privacy scope, stable chunks for large Unicode histories, worker restarts, saved colors, and native CSV export. `npm run check` verifies entries, manifest fields, and JavaScript syntax. Use the target Orca’s `plugin validate`, `plugin check`, and native sidebar verification before release.

No runtime dependencies, CDN assets, or telemetry. Geist is bundled locally under the SIL Open Font License; see `web/fonts/OFL.txt`. The UI is plain ES modules and CSS; the worker uses Node’s standard library.

`npm run package` rebuilds the installable folder with only runtime modules, panel assets, and documentation/licenses. Tests, build scripts, and project configuration stay in the repository.

## Contributing / publishing

The source is MIT-licensed. Issues and contributions are welcome in [the GitHub repository](https://github.com/bhojanibilal24/orca-activity-calendar). To publish an update, validate against the target Orca release and push a new `vX.Y.Z` tag matching the manifest version. Keep the `orca-plugin` GitHub topic so the directory discovers releases. See [Orca’s publishing instructions](https://www.onorca.dev/plugins/add). Community listings are checked automatically and do not receive manual review.

Add release screenshots that do not expose personal session data. Do not commit personal transcripts or cache files. Nothing is uploaded or published by the included scripts.
