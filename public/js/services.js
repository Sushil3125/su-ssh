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

export function openServices(startUnit = null) {
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
              <select class="svc__filter" data-role="loglines">
                <option value="100">last 100</option>
                <option value="500" selected>last 500</option>
                <option value="2000">last 2000</option>
              </select>
              <input class="svc__search svc__search--sm" placeholder="Filter lines…" data-role="logfilter" spellcheck="false">
              <button class="tbar__btn" data-role="logclear" title="Clear the view">Clear</button>
              <span class="svc__logstate" data-role="logstate">idle</span>
            </div>
            <div class="svc__log" data-role="log"></div>
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
    scope: 'system',
    filter: 'all',
    query: '',
    services: [],
    privilege: null,
    selected: null,
    detail: null,
    tab: 'status',
    file: null,
    fileDirty: false,
  };

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
    $('log').innerHTML = '';
    $('logstate').textContent = 'connecting…';

    const lines = Number($('loglines').value);
    const follow = $('follow').checked;
    const ws = new WebSocket(api.journalUrl(state.selected, state.scope, lines, follow));
    socket = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start' })));

    ws.addEventListener('message', async (event) => {
      if (typeof event.data !== 'string') return appendChunk(new TextDecoder().decode(event.data));

      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') $('logstate').textContent = follow ? 'streaming' : 'loaded';
      if (msg.type === 'exit') $('logstate').textContent = 'ended';
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
    const ws = new WebSocket(api.journalUrl(state.selected, state.scope, lines, follow));
    socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start', password })));
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return appendChunk(new TextDecoder().decode(event.data));
      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') $('logstate').textContent = follow ? 'streaming' : 'loaded';
      if (msg.type === 'error') toast(msg.message, 'bad', 7000);
    });
    ws.addEventListener('close', () => { if (socket === ws) { socket = null; $('logstate').textContent = 'disconnected'; } });
  }

  /** A chunk can split a line anywhere, so the tail is held until it completes. */
  function appendChunk(text) {
    pending += text.replace(/\r/g, '');
    const parts = pending.split('\n');
    pending = parts.pop();

    const filter = $('logfilter').value.toLowerCase();
    const box = $('log');
    // "Am I at the bottom" is decided before appending, or every new line
    // would look like the user had scrolled away.
    const stick = $('follow').checked && box.scrollHeight - box.scrollTop - box.clientHeight < 60;

    const frag = document.createDocumentFragment();
    for (const line of parts) {
      if (!line.trim()) continue;
      logLines.push(line);
      if (filter && !line.toLowerCase().includes(filter)) continue;
      frag.appendChild(logRow(line));
    }
    box.appendChild(frag);

    if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
    while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstElementChild);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function logRow(line) {
    const el = document.createElement('div');
    el.className = `jline${/\b(error|failed|fatal|critical|denied)\b/i.test(line) ? ' jline--bad'
      : /\b(warn|warning|deprecated)\b/i.test(line) ? ' jline--warn' : ''}`;
    el.textContent = line;
    return el;
  }

  function reflowLog() {
    const filter = $('logfilter').value.toLowerCase();
    const box = $('log');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const line of logLines) {
      if (filter && !line.toLowerCase().includes(filter)) continue;
      frag.appendChild(logRow(line));
    }
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }

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

  $('follow').addEventListener('change', startLogs);
  $('loglines').addEventListener('change', startLogs);
  $('logfilter').addEventListener('input', reflowLog);
  $('logclear').addEventListener('click', () => { logLines = []; $('log').innerHTML = ''; });

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

  loadList();
  return win;
}
