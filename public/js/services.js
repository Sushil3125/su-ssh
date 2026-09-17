/**
 * services.js — the Services app: find a unit, watch it, control it, edit it.
 *
 * Three decisions worth knowing before reading:
 *
 * · The unit list is fetched once per refresh and filtered in the browser.
 *   Searching 400 units is instant locally and would be a round trip per
 *   keystroke otherwise.
 * · Logs arrive over a WebSocket carrying `journalctl -f`, not by polling.
 *   Exactly one stream exists at a time; changing unit, scope, or leaving the
 *   Logs tab closes the old one, which is what stops journalctl on the server.
 * · A sudo password, when the server says it needs one, is asked for per
 *   action and held only for the lifetime of that request.
 */

import { createWindow, escapeHtml } from './wm.js';
import { promptSecret, confirmDialog, formatBytes } from './ui.js';
import { requireSession, hostPhrase, dangerOpts, markActivity, markDropped } from './sessions.js';

/** Buttons on the detail header, in the order they are useful. */
const PRIMARY_ACTIONS = [
  { action: 'start', label: 'Start' },
  { action: 'stop', label: 'Stop', danger: true },
  { action: 'restart', label: 'Restart' },
  { action: 'reload', label: 'Reload' },
];

const MORE_ACTIONS = [
  { action: 'enable', label: 'Enable at boot' },
  { action: 'disable', label: 'Disable at boot' },
  { action: 'mask', label: 'Mask', danger: true },
  { action: 'unmask', label: 'Unmask' },
  { action: 'reset-failed', label: 'Clear failed state' },
];

/** Destructive enough that a misclick should not be enough. */
const CONFIRM = { stop: 'Stop', restart: 'Restart', disable: 'Disable at boot', mask: 'Mask' };

const FILTERS = {
  all: () => true,
  running: (s) => s.sub === 'running',
  failed: (s) => s.active === 'failed',
  enabled: (s) => s.unitFileState === 'enabled',
  disabled: (s) => s.unitFileState === 'disabled',
  inactive: (s) => s.active === 'inactive',
};

const MAX_LOG_LINES = 5000;

/**
 * syslog severities, as journalctl reports them in PRIORITY. The words matter
 * as much as the colours: a red line has to say *why* it is red somewhere a
 * screenshot or a screen reader can reach.
 */
const PRIORITY_WORD = {
  0: 'emerg', 1: 'alert', 2: 'crit', 3: 'err', 4: 'warning', 5: 'notice', 6: 'info', 7: 'debug',
};

/**
 * `startTab`/`startScope` exist for restore.js: after a refresh a Services
 * window that was reading cron.service's journal on the user manager has to
 * come back reading exactly that, not the system scope's Status tab.
 */
export function openServices(startUnit = null,
  { scope: startScope = null, tab: startTab = null, filter: startFilter = null } = {}) {
  // Captured once: every systemctl call this window ever makes goes to this
  // host, and every confirm it raises names it.
  const session = requireSession();
  const { api, toast } = session;
  const win = createWindow({ title: 'Services', icon: '⚙', width: 960, height: 620, appId: 'services' });

  win.body.innerHTML = `
    <div class="svc">
      <aside class="svc__side">
        <div class="svc__tools">
          <div class="segmented segmented--sm" data-role="scope">
            <button type="button" class="segmented__btn is-active" data-scope="system">System</button>
            <button type="button" class="segmented__btn" data-scope="user">User</button>
          </div>
          <input class="svc__search" placeholder="Search services…" spellcheck="false" data-role="search">
          <div class="svc__toolrow">
            <select class="svc__filter" data-role="filter">
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="failed">Failed</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
              <option value="inactive">Inactive</option>
            </select>
            <button class="tbar__btn" data-role="refresh" title="Refresh the list">⟳</button>
            <button class="tbar__btn" data-role="daemon-reload" title="systemctl daemon-reload">↻ units</button>
          </div>
        </div>
        <div class="svc__counts" data-role="counts">Loading…</div>
        <div class="svc__list" data-role="list"></div>
      </aside>

      <section class="svc__main">
        <div class="svc__empty" data-role="placeholder">Pick a service on the left.</div>

        <div class="svc__detail is-hidden" data-role="detail">
          <header class="svc__head">
            <div class="svc__headline">
              <h2 class="svc__unit" data-role="unit">—</h2>
              <div class="svc__badges" data-role="badges"></div>
            </div>
            <p class="svc__desc" data-role="description"></p>
            <div class="svc__stats" data-role="stats"></div>
            <div class="svc__actions" data-role="actions"></div>
          </header>

          <div class="svc__tabs" data-role="tabs">
            <button class="svc__tab is-active" data-tab="status">Status</button>
            <button class="svc__tab" data-tab="logs">Logs</button>
            <button class="svc__tab" data-tab="file">Unit file</button>
          </div>

          <div class="svc__pane" data-pane="status">
            <pre class="svc__status" data-role="status"></pre>
            <table class="svc__props" data-role="props"></table>
          </div>

          <div class="svc__pane is-hidden" data-pane="logs">
            <div class="svc__logbar">
              <label class="svc__toggle"><input type="checkbox" data-role="follow" checked> Follow</label>
              <select class="svc__filter" data-role="logspan" aria-label="Time window">
                <option value="15m">last 15 min</option>
                <option value="1h">last hour</option>
                <option value="today">today</option>
                <option value="boot" selected>this boot</option>
                <option value="all">all boots</option>
              </select>
              <select class="svc__filter" data-role="loglines" aria-label="How many lines">
                <option value="100">last 100</option>
                <option value="500" selected>last 500</option>
                <option value="2000">last 2000</option>
              </select>
              <select class="svc__filter" data-role="logpri" aria-label="Minimum priority">
                <option value="7" selected>all priorities</option>
                <option value="6">info and worse</option>
                <option value="4">warnings and worse</option>
                <option value="3">errors only</option>
              </select>
              <input class="svc__search svc__search--sm" placeholder="Filter lines…" data-role="logfilter" spellcheck="false">
              <button class="tbar__btn" data-role="logcopy" title="Copy what is shown to the clipboard">Copy</button>
              <button class="tbar__btn" data-role="logdownload" title="Download what is shown as a .log file">Download</button>
              <button class="tbar__btn" data-role="logclear" title="Clear the view">Clear</button>
              <span class="svc__logstate" data-role="logstate">idle</span>
            </div>
            <div class="svc__logwrap">
              <div class="svc__log" data-role="log" tabindex="0" role="log" aria-label="Journal output"></div>
              <button class="svc__jump is-hidden" data-role="logjump" type="button">
                Jump to latest<span class="svc__jump__n" data-role="logjumpn"></span>
              </button>
            </div>
          </div>

          <div class="svc__pane is-hidden" data-pane="file">
            <div class="svc__filebar">
              <select class="svc__filter" data-role="which">
                <option value="fragment">Unit file</option>
                <option value="override">Drop-in override</option>
              </select>
              <code class="svc__path" data-role="path">—</code>
              <button class="tbar__btn" data-role="filereload" title="Re-read from the server">⟳</button>
              <button class="tbar__btn" data-role="filesave">Save + daemon-reload</button>
              <button class="tbar__btn" data-role="filesaverestart">Save + restart</button>
            </div>
            <p class="svc__filenote hint is-hidden" data-role="filenote"></p>
            <textarea class="svc__editor" spellcheck="false" data-role="editor"></textarea>
          </div>
        </div>
      </section>
    </div>`;

  const $ = (role) => win.body.querySelector(`[data-role="${role}"]`);
  const pane = (name) => win.body.querySelector(`[data-pane="${name}"]`);

  const state = {
    scope: startScope === 'user' ? 'user' : 'system',
    filter: FILTERS[startFilter] ? startFilter : 'all',
    query: '',
    services: [],
    privilege: null,
    selected: null,
    detail: null,
    tab: ['status', 'logs', 'file'].includes(startTab) ? startTab : 'status',
    file: null,
    fileDirty: false,
  };

  /** Show the tab `state` says we are on. Only ever differs from the markup's
   *  default when restore.js asked for one. */
  function syncTab() {
    win.body.querySelectorAll('.svc__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.tab));
    ['status', 'logs', 'file'].forEach((name) => pane(name).classList.toggle('is-hidden', name !== state.tab));
  }

  /* ─────────────────────────────────────────────────────────── privilege ─ */

  /**
   * Run something that may need root. If the relay says a password is needed,
   * ask once and retry; anything else is reported as-is. The password is a
   * local variable and dies with this call.
   */
  async function withSudo(run, what) {
    try {
      return await run(undefined);
    } catch (err) {
      if (!err.needsPassword && err.status !== 401) throw err;
      const password = await promptSecret({
        title: 'sudo password needed',
        message: `${what} needs root on ${state.scope === 'user' ? `this user manager on ${session.label}` : hostPhrase(session)}.`
          + ' It is used for this one command and never stored.',
        accent: session.color,
      });
      if (!password) throw new Error('Cancelled.');
      return run(password);
    }
  }

  /* ──────────────────────────────────────────────────────────── the list ─ */

  async function loadList() {
    $('counts').textContent = 'Loading…';
    try {
      const data = await api.services(state.scope);
      state.services = data.services;
      state.privilege = data.privilege;
      $('counts').innerHTML = `<strong>${data.counts.total}</strong> units ·
        <span class="ok">${data.counts.running} running</span> ·
        <span class="bad">${data.counts.failed} failed</span> ·
        ${data.counts.enabled} enabled`;
      renderList();
      if (startUnit && !state.selected) select(startUnit);
    } catch (err) {
      $('counts').textContent = err.message;
      $('list').innerHTML = `<p class="svc__empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function visibleServices() {
    const q = state.query.toLowerCase();
    const pass = FILTERS[state.filter] || FILTERS.all;
    return state.services.filter((s) =>
      pass(s) && (!q || s.unit.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)));
  }

  function renderList() {
    const rows = visibleServices();
    if (!rows.length) {
      $('list').innerHTML = '<p class="svc__empty">Nothing matches.</p>';
      return;
    }
    $('list').innerHTML = rows.map((s) => `
      <button class="svc__item${s.unit === state.selected ? ' is-selected' : ''}" data-unit="${escapeHtml(s.unit)}">
        <span class="svc__dot svc__dot--${dotClass(s)}"></span>
        <span class="svc__itemtext">
          <span class="svc__itemname">${escapeHtml(s.unit.replace(/\.service$/, ''))}</span>
          <span class="svc__itemdesc">${escapeHtml(s.description || s.unitFileState || '')}</span>
        </span>
        <span class="svc__itemstate">${escapeHtml(s.sub || s.active)}</span>
      </button>`).join('');
  }

  const dotClass = (s) =>
    s.active === 'failed' ? 'bad' : s.sub === 'running' ? 'ok' : s.active === 'activating' ? 'warn' : 'idle';

  /* ────────────────────────────────────────────────────────────── detail ─ */

  async function select(unit) {
    state.selected = unit;
    state.fileDirty = false;
    state.file = null;
    renderList();
    $('placeholder').classList.add('is-hidden');
    $('detail').classList.remove('is-hidden');
    $('unit').textContent = unit;
    win.setSubtitle(`— ${unit}`);
    await loadDetail();
    if (state.tab === 'logs') startLogs();
    if (state.tab === 'file') loadFile();
  }

  async function loadDetail() {
    try {
      state.detail = await api.service(state.selected, state.scope);
      renderDetail();
    } catch (err) {
      $('badges').innerHTML = `<span class="svc__badge svc__badge--bad">${escapeHtml(err.message)}</span>`;
    }
  }

  function renderDetail() {
    const { summary, props, statusOutput } = state.detail;

    $('description').textContent = summary.description || '(no description)';
    $('badges').innerHTML = [
      badge(summary.active, summary.active === 'failed' ? 'bad' : summary.active === 'active' ? 'ok' : 'idle'),
      badge(summary.sub, 'idle'),
      summary.unitFileState ? badge(summary.unitFileState, summary.unitFileState === 'enabled' ? 'ok' : 'idle') : '',
      summary.needsDaemonReload ? badge('needs daemon-reload', 'warn') : '',
    ].join('');

    $('stats').innerHTML = [
      summary.mainPid ? stat('PID', summary.mainPid) : '',
      summary.memory != null ? stat('Memory', formatBytes(summary.memory)) : '',
      summary.tasks != null ? stat('Tasks', `${summary.tasks}${props.TasksMax && props.TasksMax !== 'infinity' ? ` / ${props.TasksMax}` : ''}`) : '',
      summary.cpuNsec != null ? stat('CPU', formatDuration(summary.cpuNsec / 1e9)) : '',
      summary.restarts ? stat('Restarts', summary.restarts) : '',
      summary.since ? stat('Since', summary.since.replace(/^\w+ /, '')) : '',
      props.Type ? stat('Type', props.Type) : '',
      props.Restart && props.Restart !== 'no' ? stat('Restart policy', props.Restart) : '',
    ].join('');

    // A unit that cannot start is one systemd refuses to act on; showing the
    // button anyway would only produce a failure the user cannot fix here.
    $('actions').innerHTML = PRIMARY_ACTIONS
      .filter((a) => (a.action !== 'reload' || summary.canReload) && (a.action !== 'stop' || summary.canStop))
      .map((a) => `<button class="btn btn--sm${a.danger ? ' btn--danger' : ''}" data-action="${a.action}">${a.label}</button>`)
      .join('')
      + `<span class="svc__spacer"></span>`
      + MORE_ACTIONS.map((a) => `<button class="btn btn--sm btn--ghost" data-action="${a.action}">${a.label}</button>`).join('');

    $('status').textContent = statusOutput.trim() || '(no status output)';

    const interesting = ['FragmentPath', 'DropInPaths', 'ExecMainStartTimestamp', 'User', 'WorkingDirectory',
      'Documentation', 'Requires', 'After', 'TriggeredBy', 'Result', 'StatusText', 'ConditionResult'];
    $('props').innerHTML = interesting
      .filter((k) => props[k] && props[k] !== '[not set]' && props[k] !== 'n/a')
      .map((k) => `<tr><th>${k}</th><td>${escapeHtml(props[k])}</td></tr>`)
      .join('');
  }

  const badge = (text, kind) => (text ? `<span class="svc__badge svc__badge--${kind}">${escapeHtml(text)}</span>` : '');
  const stat = (label, value) => `<span class="svc__stat"><em>${label}</em>${escapeHtml(String(value))}</span>`;

  function formatDuration(seconds) {
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
    if (seconds < 90) return `${seconds.toFixed(1)} s`;
    return `${(seconds / 60).toFixed(1)} min`;
  }

  /* ───────────────────────────────────────────────────────────── actions ─ */

  async function act(action, { ask = true } = {}) {
    const unit = state.selected;
    if (ask && CONFIRM[action]) {
      const ok = await confirmDialog({
        title: `${CONFIRM[action]} ${unit} on ${session.label}?`,
        message: `This runs systemctl ${action} on ${hostPhrase(session)}`
          + `${state.scope === 'user' ? ' (your user manager there)' : ''}.`,
        confirmLabel: CONFIRM[action],
        danger: action !== 'restart',
        // restart is recoverable; stop/disable/mask are the ones that leave a
        // production box down until someone notices.
        ...dangerOpts(session, { typed: action !== 'restart' }),
      });
      if (!ok) return;
    }

    const buttons = $('actions').querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const result = await withSudo(
        (password) => api.serviceAction(unit, action, { scope: state.scope, password }),
        `${action} ${unit}`,
      );
      state.detail = result.detail;
      renderDetail();
      toast(result.output ? `${action}: ${result.output}` : `${unit} — ${action} done.`, 'good');
      // The list carries active/sub state, so it is stale the moment an action lands.
      loadList();
    } catch (err) {
      toast(err.message, 'bad', 7000);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  /* ──────────────────────────────────────────────────────────────── logs ─ */

  let socket = null;
  let logLines = [];
  let pending = '';

  /**
   * Scroll state, which is *not* the same thing as the Follow checkbox.
   *
   * Follow says whether journalctl is still tailing on the server. `pinned`
   * says whether the view is stuck to the bottom. Scrolling up to read
   * something pauses the view without stopping the stream — the lines keep
   * arriving, the buffer keeps growing, and the count on the jump button says
   * how many you have not seen. Before this the only control was Follow, so
   * reading a line meant either fighting the autoscroll or killing the stream
   * and losing everything after it.
   */
  let pinned = true;
  let unseen = 0;
  /**
   * Did journalctl finish on its own?
   *
   * With Follow off the command prints its lines and exits, which closes the
   * socket — a completely normal end. Treating every close as a drop painted a
   * red "Log stream disconnected · Reconnect" over a read that had just
   * succeeded, which is the same class of lie as the old always-green link dot.
   */
  let endedCleanly = false;

  /**
   * What the state word says once the stream is up.
   *
   * `journalctl -f` only ever replays the *current boot*, whatever `-n` says —
   * so "all boots" while following quietly means "this boot", and a state word
   * that just said "streaming" would let the user believe they were looking at
   * a history that is not on screen. Saying so is cheaper than pretending.
   */
  const readyWord = (follow, span) => (follow
    ? (span === 'all' ? 'streaming · this boot' : 'streaming')
    : 'loaded');

  function stopLogs() {
    if (!socket) return;
    const s = socket;
    socket = null;
    try { s.close(); } catch { /* already closing */ }
    $('logstate').textContent = 'stopped';
  }

  function startLogs() {
    stopLogs();
    if (!state.selected) return;

    logLines = [];
    pending = '';
    pinned = true;
    unseen = 0;
    endedCleanly = false;
    $('log').innerHTML = '';
    $('logstate').classList.remove('svc__logstate--lost');
    $('logstate').textContent = 'connecting…';
    updateJump();

    const lines = Number($('loglines').value);
    const follow = $('follow').checked;
    const ws = new WebSocket(api.journalUrl(state.selected, state.scope, lines, follow,
      { span: $('logspan').value, format: 'json' }));
    socket = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start' })));

    ws.addEventListener('message', async (event) => {
      if (typeof event.data !== 'string') return appendChunk(new TextDecoder().decode(event.data));

      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') $('logstate').textContent = readyWord(follow, msg.span);
      if (msg.type === 'exit') {
        endedCleanly = true;
        $('logstate').textContent = follow ? 'ended' : 'loaded';
      }
      if (msg.type === 'error') {
        $('logstate').textContent = 'error';
        if (msg.needsPassword) {
          // journalctl can be readable without root, so this is only reached
          // when it genuinely is not — ask, then reopen the stream with it.
          const password = await promptSecret({
            title: 'sudo password needed',
            message: 'Reading this unit’s journal needs root on the server.',
          });
          if (password) return restartLogsWith(password);
        }
        toast(msg.message, 'bad', 7000);
      }
    });

    ws.addEventListener('message', () => markActivity(session));

    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      // A read that ran to completion is not a drop, and must not be dressed as
      // one. Only an unexpected close gets the reconnect affordance.
      if (endedCleanly) {
        $('logstate').textContent = follow ? 'ended' : 'loaded';
        return;
      }
      // Same reasoning as the terminal: a stream that died is told to the user
      // with the one action that fixes it, not as a 10px grey word.
      showLogLost('Log stream disconnected');
      session.api.session().catch((err) => { if (err.status === 401) markDropped(session, 'connection lost'); });
    });
  }

  /** Replace the log status word with a reason and a Reconnect button. */
  function showLogLost(reason) {
    const el = $('logstate');
    el.innerHTML = '';
    el.classList.add('svc__logstate--lost');
    const text = document.createElement('span');
    text.textContent = reason;
    const again = document.createElement('button');
    again.className = 'tbar__btn';
    again.textContent = 'Reconnect';
    again.addEventListener('click', () => { el.classList.remove('svc__logstate--lost'); el.textContent = 'connecting…'; startLogs(); });
    el.append(text, again);
  }

  function restartLogsWith(password) {
    stopLogs();
    const lines = Number($('loglines').value);
    const follow = $('follow').checked;
    const ws = new WebSocket(api.journalUrl(state.selected, state.scope, lines, follow,
      { span: $('logspan').value, format: 'json' }));
    socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start', password })));
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return appendChunk(new TextDecoder().decode(event.data));
      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') $('logstate').textContent = readyWord(follow, msg.span);
      if (msg.type === 'error') toast(msg.message, 'bad', 7000);
    });
    ws.addEventListener('close', () => { if (socket === ws) { socket = null; $('logstate').textContent = 'disconnected'; } });
  }

  /**
   * Turn one line of the stream into an entry.
   *
   * With `-o json` a line is one journal record and PRIORITY is on it, which is
   * the whole point: the old code matched `/\b(error|failed)\b/i` against the
   * rendered text, which both misses a genuine `err` whose wording is polite and
   * paints an INFO line red for saying "failed to find optional config". systemd
   * already knows the severity; asking it is strictly better than guessing.
   *
   * Not every line is a record, though. journalctl writes `-- No entries --`,
   * boot separators and its own errors to the same stream (the command ends in
   * `2>&1` so a sudo complaint is visible rather than lost), so anything that is
   * not JSON is kept as a plain note instead of being dropped.
   */
  function parseLine(line) {
    const text = line.trim();
    if (!text) return null;
    if (text[0] !== '{') return { pri: null, ident: '', pid: '', time: null, msg: text, text };

    let rec;
    try { rec = JSON.parse(text); } catch { return { pri: null, ident: '', pid: '', time: null, msg: text, text }; }

    const msg = decodeMessage(rec.MESSAGE);
    const pri = Number.isFinite(Number(rec.PRIORITY)) ? Math.min(7, Math.max(0, Number(rec.PRIORITY))) : null;
    const ident = rec.SYSLOG_IDENTIFIER || rec._COMM || '';
    const pid = rec._PID || '';
    // __REALTIME_TIMESTAMP is microseconds since the epoch, always present.
    const micros = Number(rec.__REALTIME_TIMESTAMP);
    const time = Number.isFinite(micros) && micros > 0 ? new Date(micros / 1000) : null;

    const stamp = time ? time.toISOString().replace('T', ' ').slice(0, 19) : '';
    return {
      pri, ident, pid, time, msg,
      text: `${stamp} ${ident}${pid ? `[${pid}]` : ''}${ident ? ': ' : ''}${msg}`.trim(),
    };
  }

  /** A MESSAGE that is not valid UTF-8 arrives as an array of byte values. */
  function decodeMessage(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      try { return new TextDecoder().decode(Uint8Array.from(value)); } catch { return String(value); }
    }
    return value == null ? '' : String(value);
  }

  const clockOf = (entry) => (entry.time
    ? entry.time.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '');

  /** Does this entry survive the text filter and the priority floor? */
  function passes(entry) {
    const floor = Number($('logpri').value);
    if (entry.pri != null && entry.pri > floor) return false;
    const filter = $('logfilter').value.trim().toLowerCase();
    return !filter || entry.text.toLowerCase().includes(filter);
  }

  /**
   * One row. The timestamp and the identifier are their own columns and the
   * message is a flex child that wraps inside its own column — which is what
   * gives a wrapped line a hanging indent instead of the continuation running
   * back under the timestamp where it reads as a new entry (F5).
   */
  function logRow(entry) {
    const el = document.createElement('div');
    el.className = `jline jline--${entry.pri == null ? 'note' : `p${entry.pri}`}`;
    if (entry.pri == null) {
      el.textContent = entry.msg;
      return el;
    }
    const time = document.createElement('span');
    time.className = 'jline__t';
    time.textContent = clockOf(entry);
    if (entry.time) time.title = entry.time.toISOString();

    const who = document.createElement('span');
    who.className = 'jline__i';
    who.textContent = entry.ident ? `${entry.ident}${entry.pid ? `[${entry.pid}]` : ''}` : '';
    who.title = who.textContent;

    const msg = document.createElement('span');
    msg.className = 'jline__m';
    msg.textContent = entry.msg;

    // The severity as a word as well as a colour: colour is never the only
    // signal, and "err" in the tooltip is what makes a screenshot readable.
    el.title = `${PRIORITY_WORD[entry.pri] || 'log'}${entry.time ? ` · ${entry.time.toISOString()}` : ''}`;
    el.append(time, who, msg);
    return el;
  }

  /** A chunk can split a line anywhere, so the tail is held until it completes. */
  function appendChunk(text) {
    pending += text.replace(/\r/g, '');
    const parts = pending.split('\n');
    pending = parts.pop();

    const box = $('log');
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const line of parts) {
      const entry = parseLine(line);
      if (!entry) continue;
      logLines.push(entry);
      if (!passes(entry)) continue;
      frag.appendChild(logRow(entry));
      added += 1;
    }
    if (!added && !parts.length) return;
    box.appendChild(frag);

    if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
    while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstElementChild);

    if (pinned) box.scrollTop = box.scrollHeight;
    else unseen += added;
    updateJump();
  }

  function reflowLog() {
    const box = $('log');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const entry of logLines) {
      if (passes(entry)) frag.appendChild(logRow(entry));
    }
    box.appendChild(frag);
    // Re-filtering is a deliberate act, so it lands you at the newest match.
    pinned = true;
    unseen = 0;
    box.scrollTop = box.scrollHeight;
    updateJump();
  }

  /* ─────────────────────────────────── pause, jump, copy, download ─────── */

  function updateJump() {
    const jump = $('logjump');
    jump.classList.toggle('is-hidden', pinned);
    $('logjumpn').textContent = unseen ? ` · ${unseen > 999 ? '999+' : unseen} new` : '';
  }

  $('log').addEventListener('scroll', () => {
    const box = $('log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (atBottom === pinned && !(atBottom && unseen)) return;
    pinned = atBottom;
    if (atBottom) unseen = 0;
    updateJump();
  });

  $('logjump').addEventListener('click', () => {
    const box = $('log');
    box.scrollTop = box.scrollHeight;
    pinned = true;
    unseen = 0;
    updateJump();
    box.focus();
  });

  /** What Copy and Download hand over: exactly what is on screen, filters and
   *  priority floor included. Copying a buffer that differs from the view is a
   *  good way to paste the wrong thing into an incident channel. */
  const visibleText = () => logLines.filter(passes).map((e) => e.text).join('\n');

  $('logcopy').addEventListener('click', async () => {
    const body = visibleText();
    if (!body) return toast('Nothing to copy yet.', 'bad');
    const count = body.split('\n').length;
    try {
      await navigator.clipboard.writeText(body);
      return toast(`Copied ${count} line${count === 1 ? '' : 's'}.`, 'good');
    } catch { /* no async clipboard on a plain-http origin; fall back */ }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = body;
      scratch.style.cssText = 'position:fixed;top:-1000px';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      scratch.remove();
      toast(ok ? `Copied ${count} lines.` : 'Could not copy — use Download instead.', ok ? 'good' : 'bad');
    } catch {
      toast('Could not copy — use Download instead.', 'bad');
    }
  });

  $('logdownload').addEventListener('click', () => {
    const body = visibleText();
    if (!body) return toast('Nothing to download yet.', 'bad');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${state.selected || 'journal'}-${session.label.replace(/[^\w.-]+/g, '_')}-${stamp}.log`;
    const url = URL.createObjectURL(new Blob([`${body}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Saved ${name}`, 'good');
  });

  /* ─────────────────────────────────────────────────────────── unit file ─ */

  async function loadFile() {
    const which = $('which').value;
    $('editor').value = 'Loading…';
    try {
      const file = await withSudo(
        (password) => api.unitFile(state.selected, state.scope, which, password),
        `reading the unit file for ${state.selected}`,
      );
      state.file = file;
      state.fileDirty = false;
      $('path').textContent = file.path;
      $('editor').value = file.exists ? file.content : overrideTemplate(file);
      const notes = [];
      if (!file.exists) notes.push('This file does not exist yet — saving creates it.');
      if (file.vendor) {
        notes.push('This is a packaged vendor file under /lib; a package upgrade will overwrite it.'
          + ' Prefer the drop-in override, which systemd merges on top and upgrades leave alone.');
      }
      if (file.dropIns?.length) notes.push(`Active drop-ins: ${file.dropIns.join(', ')}`);
      $('filenote').textContent = notes.join(' ');
      $('filenote').classList.toggle('is-hidden', !notes.length);
    } catch (err) {
      $('editor').value = '';
      $('path').textContent = '—';
      $('filenote').textContent = err.message;
      $('filenote').classList.remove('is-hidden');
    }
  }

  /** An empty override is a blank page; a stub shows the shape systemd expects. */
  const overrideTemplate = (file) => (file.which !== 'override' ? '' :
    `# Drop-in override for ${state.selected}\n`
    + '# Values here are merged over the packaged unit file.\n'
    + '# To clear a list-valued setting first, assign it empty: ExecStart=\n\n'
    + '[Service]\n');

  async function saveFile({ restart = false } = {}) {
    if (!state.file) return;
    const path = state.file.path;
    const ok = await confirmDialog({
      title: restart ? `Save and restart ${state.selected} on ${session.label}?` : `Save ${state.selected} on ${session.label}?`,
      message: `Writes ${path} on ${hostPhrase(session)}, then runs daemon-reload`
        + (restart ? ' and restarts the service.' : '.'),
      confirmLabel: restart ? 'Save + restart' : 'Save',
      danger: restart,
      ...dangerOpts(session, { typed: true }),
    });
    if (!ok) return;

    try {
      await withSudo(
        (password) => api.saveUnitFile(state.selected, {
          scope: state.scope, path, content: $('editor').value, password, reload: true,
        }),
        `writing ${path}`,
      );
      state.fileDirty = false;
      toast('Saved and daemon-reloaded.', 'good');
      // The save dialog already asked about the restart; do not ask twice.
      if (restart) await act('restart', { ask: false });
      else await loadDetail();
      loadFile();
    } catch (err) {
      toast(err.message, 'bad', 8000);
    }
  }

  /* ────────────────────────────────────────────────────────────── wiring ─ */

  win.body.querySelector('[data-role="scope"]').addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented__btn');
    if (!btn || btn.dataset.scope === state.scope) return;
    state.scope = btn.dataset.scope;
    win.body.querySelectorAll('[data-role="scope"] .segmented__btn')
      .forEach((b) => b.classList.toggle('is-active', b === btn));
    stopLogs();
    state.selected = null;
    $('detail').classList.add('is-hidden');
    $('placeholder').classList.remove('is-hidden');
    loadList();
  });

  $('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); renderList(); });
  $('filter').addEventListener('change', (e) => { state.filter = e.target.value; renderList(); });
  $('refresh').addEventListener('click', () => { loadList(); if (state.selected) loadDetail(); });

  $('daemon-reload').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Run daemon-reload on ${session.label}?`,
      message: `systemd on ${hostPhrase(session)} re-reads every unit file.`,
      confirmLabel: 'daemon-reload',
      ...dangerOpts(session, { typed: true }),
    });
    if (!ok) return;
    try {
      await withSudo((password) => api.daemonReload({ scope: state.scope, password }), 'daemon-reload');
      toast('systemd re-read its unit files.', 'good');
      loadList();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-unit]');
    if (item) select(item.dataset.unit);
  });

  $('actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) act(btn.dataset.action);
  });

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.svc__tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    win.body.querySelectorAll('.svc__tab').forEach((b) => b.classList.toggle('is-active', b === btn));
    ['status', 'logs', 'file'].forEach((name) => pane(name).classList.toggle('is-hidden', name !== state.tab));

    if (state.tab === 'logs') startLogs();
    else stopLogs();                       // No tab open, no journalctl running.
    if (state.tab === 'file' && !state.file) loadFile();
  });

  // Follow, line count and time window all change what the server is asked for,
  // so they restart the stream. The text filter and the priority floor only
  // change what is shown, so they repaint the buffer we already have — which is
  // what makes narrowing to "errors only" instant instead of a round trip.
  $('follow').addEventListener('change', startLogs);
  $('loglines').addEventListener('change', startLogs);
  $('logspan').addEventListener('change', startLogs);
  $('logpri').addEventListener('change', reflowLog);
  $('logfilter').addEventListener('input', reflowLog);
  $('logclear').addEventListener('click', () => {
    logLines = [];
    $('log').innerHTML = '';
    pinned = true;
    unseen = 0;
    updateJump();
  });

  $('which').addEventListener('change', loadFile);
  $('filereload').addEventListener('click', loadFile);
  $('filesave').addEventListener('click', () => saveFile());
  $('filesaverestart').addEventListener('click', () => saveFile({ restart: true }));
  $('editor').addEventListener('input', () => { state.fileDirty = true; });

  win.onClose = async () => {
    if (state.fileDirty) {
      const ok = await confirmDialog({
        title: 'Discard unsaved unit file changes?',
        message: `${state.file?.path || 'The unit file'} has edits that have not been written to the server.`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return false;
    }
    stopLogs();
    return true;
  };
  win.onForceClose = stopLogs;

  // The unit, the scope and the tab: what "this window was showing" means here.
  win.restore = () => ({ app: 'services', unit: state.selected, scope: state.scope, tab: state.tab });

  // The scope segmented control is markup-default 'system'; a restore may have
  // asked for 'user', and the list below is about to be fetched for it.
  win.body.querySelectorAll('[data-role="scope"] .segmented__btn')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.scope === state.scope));
  // The overview card opens this window already narrowed to "failed": landing on
  // the full list of 400 units and being told to find the broken one yourself is
  // exactly the step the card exists to remove.
  $('filter').value = state.filter;
  syncTab();

  loadList();
  return win;
}
