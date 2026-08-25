/** main.js — greeter, session lifecycle, desktop surface, dock. */

import { api, setToken, getToken } from './api.js';
import { openFiles, openEditor, openTerminal, openViewer, openForwards } from './apps.js';
import { closeAll, escapeHtml } from './wm.js';
import { toast, contextMenu, confirmDialog, GLYPH } from './ui.js';
import { forwardFormHtml, wireForwardForm, forwardRowHtml } from './forwards.js';
import { openServices } from './services.js';
import { startSystemMonitor } from './sysmon.js';

const greeter = document.getElementById('greeter');
const shell = document.getElementById('shell');
const form = document.getElementById('connect-form');
const errorBox = document.getElementById('connect-error');
const connectBtn = document.getElementById('connect-btn');

let authMethod = 'password';
let clockTimer = null;
let stopMonitor = null;

/* ══════════════════════════════════════════════════════════ greeter ════ */

/* ──────────────────────────────────────────────── recent connections ──── */

/**
 * Remember only what is safe to remember: where you connect and as whom, never
 * how you prove it. No password, no key, no passphrase is written here, which
 * is why this can live in localStorage at all.
 *
 * Pinned entries are kept forever and sort to the top; unpinned ones are a
 * rolling window of the last few, because a list you have to prune by hand
 * stops being a shortcut.
 */
const RECENTS_KEY = 'ssh-recent-targets';
const LEGACY_KEY = 'ssh-last-target';
const MAX_UNPINNED = 8;

const recentsBox = document.getElementById('recents');
const recentsList = document.getElementById('recents-list');

let recents = loadRecents();

function loadRecents() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];

  // Carry over the single target older builds remembered, so upgrading does
  // not look like the app forgot where you were working.
  if (!list.length) {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
      if (legacy.host) list = [makeEntry(legacy)];
    } catch { /* corrupt entry; start fresh */ }
  }
  return list.filter((e) => e && e.host && e.username);
}

function makeEntry(creds) {
  return {
    id: targetId(creds),
    host: creds.host,
    port: String(creds.port || 22),
    username: creds.username,
    authMethod: creds.authMethod || 'password',
    pinned: false,
    count: 0,
    lastConnected: null,
  };
}

const targetId = (c) => `${c.username}@${c.host}:${c.port || 22}`;

function saveRecents() {
  const pinned = recents.filter((e) => e.pinned);
  const rest = recents.filter((e) => !e.pinned)
    .sort(byRecency)
    .slice(0, MAX_UNPINNED);
  recents = [...pinned, ...rest];
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  localStorage.removeItem(LEGACY_KEY);
  renderRecents();
}

const byRecency = (a, b) => String(b.lastConnected || '').localeCompare(String(a.lastConnected || ''));

/** Record a successful connection. Only ever called after the relay said yes. */
function rememberTarget(creds) {
  const id = targetId(creds);
  const existing = recents.find((e) => e.id === id);
  const entry = existing || makeEntry(creds);
  entry.authMethod = creds.authMethod;
  entry.count = (entry.count || 0) + 1;
  entry.lastConnected = new Date().toISOString();
  if (!existing) recents.push(entry);
  saveRecents();
}

function sortedRecents() {
  return [...recents].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || byRecency(a, b));
}

const AUTH_LABEL = { password: 'password', key: 'private key', keyfile: 'key file', agent: 'agent' };

function renderRecents() {
  const rows = sortedRecents();
  recentsBox.classList.toggle('is-hidden', !rows.length);
  document.getElementById('recents-clear').classList.toggle('is-hidden', !rows.some((e) => !e.pinned));

  recentsList.innerHTML = rows.map((entry) => `
    <div class="recent${entry.pinned ? ' is-pinned' : ''}" data-id="${escapeHtml(entry.id)}">
      <button type="button" class="recent__pin" data-act="pin"
              title="${entry.pinned ? 'Unpin' : 'Pin to the top'}"
              aria-pressed="${entry.pinned}">${entry.pinned ? '★' : '☆'}</button>
      <button type="button" class="recent__main" data-act="use">
        <span class="recent__target">${escapeHtml(entry.username)}<span class="recent__at">@</span>${escapeHtml(entry.host)}${entry.port === '22' ? '' : `<span class="recent__at">:</span>${escapeHtml(entry.port)}`}</span>
        <span class="recent__meta">${escapeHtml(describeEntry(entry))}</span>
      </button>
      <button type="button" class="recent__x" data-act="forget" title="Forget this server">✕</button>
    </div>`).join('');
}

function describeEntry(entry) {
  const parts = [relativeTime(entry.lastConnected)];
  if (entry.count > 1) parts.push(`${entry.count} connections`);
  parts.push(AUTH_LABEL[entry.authMethod] || entry.authMethod);
  return parts.join(' · ');
}

/**
 * "3 minutes ago" beats a timestamp for the question this list answers, which
 * is "which of these was I just working on".
 */
function relativeTime(iso) {
  if (!iso) return 'never connected';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'never connected';

  const seconds = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800],
                 ['day', 86400], ['hour', 3600], ['minute', 60]];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Fill the form from a saved entry. Credentials are always left blank. */
function useRecent(entry) {
  document.getElementById('f-host').value = entry.host;
  document.getElementById('f-port').value = entry.port;
  document.getElementById('f-username').value = entry.username;
  setAuthMethod(entry.authMethod);

  const focusTarget = {
    password: 'f-password', key: 'f-privatekey', keyfile: 'f-keypath', agent: 'connect-btn',
  }[entry.authMethod] || 'f-password';
  document.getElementById(focusTarget)?.focus();
}

recentsList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.recent').dataset.id;
  const entry = recents.find((r) => r.id === id);
  if (!entry) return;

  if (btn.dataset.act === 'use') return useRecent(entry);
  if (btn.dataset.act === 'pin') { entry.pinned = !entry.pinned; return saveRecents(); }
  if (btn.dataset.act === 'forget') {
    recents = recents.filter((r) => r.id !== id);
    return saveRecents();
  }
});

document.getElementById('recents-clear').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Clear unpinned connections?',
    message: 'Pinned servers are kept. Nothing on the servers themselves changes.',
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  recents = recents.filter((e) => e.pinned);
  saveRecents();
});

renderRecents();

// Start on the most recent target, the way the previous build did — but only
// as a prefill, so the list above is still the way you switch between servers.
const lastUsed = sortedRecents()[0];
if (lastUsed) {
  document.getElementById('f-host').value = lastUsed.host;
  document.getElementById('f-port').value = lastUsed.port;
  document.getElementById('f-username').value = lastUsed.username;
}

/* ─────────────────────────────────────────────────────────────── auth ──── */

function setAuthMethod(name) {
  if (!AUTH_LABEL[name]) name = 'password';
  authMethod = name;
  document.querySelectorAll('#auth-tabs .segmented__btn')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.auth === name));
  document.querySelectorAll('.auth-pane')
    .forEach((p) => p.classList.toggle('is-hidden', p.dataset.pane !== name));
}

if (lastUsed) setAuthMethod(lastUsed.authMethod);

document.getElementById('auth-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (btn) setAuthMethod(btn.dataset.auth);
});

// Reading the key in the browser means it never touches the relay host's disk.
document.getElementById('f-keyupload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('f-privatekey').value = await file.text();
  toast(`Loaded ${file.name}`, 'good');
});

/* ─────────────────────────────────────── forwards queued before connecting ─ */

// Ports queued on the greeter are remembered like the host is: they describe
// where you are going, not how you get in, so there is no secret to leak.
const FWD_KEY = 'ssh-queued-forwards';
let queuedForwards = [];
try { queuedForwards = JSON.parse(localStorage.getItem(FWD_KEY) || '[]'); } catch { queuedForwards = []; }

const fwdQueueEl = document.getElementById('fwd-queue');
const fwdCountEl = document.getElementById('fwd-count');
document.getElementById('fwd-greeter-form').innerHTML = forwardFormHtml({ compact: true });

function renderQueue() {
  localStorage.setItem(FWD_KEY, JSON.stringify(queuedForwards));
  fwdCountEl.textContent = queuedForwards.length ? `· ${queuedForwards.length} queued` : '';
  fwdQueueEl.innerHTML = queuedForwards.length
    ? queuedForwards.map((f, i) => forwardRowHtml({ ...f, id: String(i) }, { queued: true })).join('')
    : '<p class="fwd-empty">Nothing queued. The session will come up with no tunnels.</p>';
  if (queuedForwards.length) document.getElementById('fwd-fold').open = true;
}

fwdQueueEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="remove"]');
  if (!btn) return;
  queuedForwards.splice(Number(btn.closest('.fwd-row').dataset.id), 1);
  renderQueue();
});

wireForwardForm(document.querySelector('#fwd-greeter-form .fwd-form'), (spec) => {
  // Validated properly by the relay on connect; this only catches the obvious.
  if (spec.kind !== 'dynamic' && !spec.destPort) throw new Error('Give the destination port.');
  queuedForwards.push(spec);
  renderQueue();
});

renderQueue();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('is-hidden');
  connectBtn.classList.add('is-busy');
  connectBtn.disabled = true;

  const creds = {
    host: document.getElementById('f-host').value.trim(),
    port: document.getElementById('f-port').value.trim() || 22,
    username: document.getElementById('f-username').value.trim(),
    authMethod,
    password: document.getElementById('f-password').value,
    privateKey: document.getElementById('f-privatekey').value,
    privateKeyPath: document.getElementById('f-keypath').value.trim(),
    passphrase: authMethod === 'keyfile'
      ? document.getElementById('f-passphrase2').value
      : document.getElementById('f-passphrase').value,
    forwards: queuedForwards,
  };

  try {
    const session = await api.connect(creds);
    setToken(session.token);
    rememberTarget(creds);

    // Clear the secrets from the DOM the moment they are no longer needed.
    document.getElementById('f-password').value = '';
    document.getElementById('f-privatekey').value = '';
    document.getElementById('f-passphrase').value = '';
    document.getElementById('f-passphrase2').value = '';

    enterDesktop(session);
    reportForwards(session.forwards);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('is-hidden');
  } finally {
    connectBtn.classList.remove('is-busy');
    connectBtn.disabled = false;
  }
});

/** Say plainly which queued tunnels came up and which did not. */
function reportForwards(forwards = []) {
  const failed = forwards.filter((f) => f.status === 'error');
  const ok = forwards.length - failed.length;
  if (ok) toast(`${ok} port forward${ok === 1 ? '' : 's'} open.`, 'good');
  for (const f of failed) toast(`Forward failed: ${f.error}`, 'bad', 8000);
  if (failed.length) openForwards();
}

/* ══════════════════════════════════════════════════════════ desktop ════ */

function enterDesktop(session) {
  greeter.classList.add('is-hidden');
  shell.classList.remove('is-hidden');

  document.getElementById('topbar-conn').textContent =
    `${session.username}@${session.host}${session.port === 22 ? '' : `:${session.port}`}`;

  startClock();
  stopMonitor = startSystemMonitor();
  loadSystemInfo();
  loadDesktopIcons(session.home);
}

function startClock() {
  const el = document.getElementById('topbar-clock');
  const tick = () => {
    el.textContent = new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 15_000);
}

async function loadSystemInfo() {
  try {
    const info = await api.system();
    const parts = [info.distro, info.kernel, info.memory && `RAM ${info.memory}`, info.disk]
      .filter((p) => p && p !== '-');
    const el = document.getElementById('topbar-sys');
    el.textContent = parts.slice(0, 2).join('  ·  ');
    el.title = parts.join('\n');
  } catch { /* non-essential; the desktop works without it */ }
}

/**
 * Desktop icons come from ~/Desktop if it exists. Falling back to the home
 * directory matters because a headless server almost never has a Desktop
 * folder — showing an empty desktop would look broken rather than accurate.
 */
async function loadDesktopIcons(home) {
  const container = document.getElementById('desktop-icons');
  const hint = document.getElementById('desktop-hint');

  let data;
  let source = `${home}/Desktop`;
  try {
    data = await api.list(source);
  } catch {
    source = home;
    try {
      data = await api.list(source);
      hint.textContent = 'No ~/Desktop on this server, so your home directory is shown instead.';
    } catch (err) {
      hint.textContent = `Could not read the home directory: ${err.message}`;
      return;
    }
  }

  if (source.endsWith('/Desktop')) hint.classList.add('is-hidden');

  const visible = data.entries.filter((e) => !e.name.startsWith('.'));
  if (!visible.length) {
    hint.classList.remove('is-hidden');
    hint.textContent = `${source} is empty. Open Files to look around.`;
    return;
  }

  container.innerHTML = '';
  for (const entry of visible.slice(0, 60)) {
    const el = document.createElement('div');
    el.className = 'dicon';
    el.tabIndex = 0;
    el.innerHTML = `<div class="dicon__glyph">${GLYPH[entry.kind] || GLYPH.binary}</div>
                    <div class="dicon__name">${escapeHtml(entry.name)}</div>`;

    const open = () => {
      if (entry.isDirectory) openFiles(entry.path);
      else if (entry.kind === 'image') openViewer(entry.path);
      else openEditor(entry.path);
    };

    el.addEventListener('click', () => {
      container.querySelectorAll('.dicon').forEach((n) => n.classList.remove('is-selected'));
      el.classList.add('is-selected');
    });
    el.addEventListener('dblclick', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open', onClick: open },
        { label: 'Show in Files', onClick: () => openFiles(entry.isDirectory ? entry.path : source) },
        { label: 'Download', onClick: () => window.open(api.downloadUrl(entry.path), '_blank') },
      ]);
    });
    container.appendChild(el);
  }
}

document.getElementById('desktop').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.dicon')) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Open Files', onClick: () => openFiles('~') },
    { label: 'Open Terminal', onClick: () => openTerminal() },
    { label: 'New text file', onClick: () => openEditor() },
    { label: 'Port forwarding', onClick: () => openForwards() },
    { label: 'Services', onClick: () => openServices() },
    'separator',
    { label: 'Refresh desktop', onClick: () => api.session().then((s) => loadDesktopIcons(s.home)) },
  ]);
});

/* ═════════════════════════════════════════════════════════════ dock ════ */

document.getElementById('dock').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-launch]');
  if (!btn) return;
  ({
    files: () => openFiles('~'),
    terminal: () => openTerminal(),
    ports: () => openForwards(),
    services: () => openServices(),
    editor: () => openEditor(),
  })[btn.dataset.launch]?.();
});

document.getElementById('btn-disconnect').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Disconnect from the server?',
    message: 'Open windows will close, and any port forwards this session opened will be released.',
    confirmLabel: 'Disconnect',
    danger: true,
  });
  if (!ok) return;
  try { await api.disconnect(); } catch { /* the socket may already be gone */ }
  closeAll();
  setToken(null);
  clearInterval(clockTimer);
  stopMonitor?.();
  stopMonitor = null;
  document.getElementById('desktop-icons').innerHTML = '';
  shell.classList.add('is-hidden');
  greeter.classList.remove('is-hidden');
});

/* ══════════════════════════════════════════════════ restore on reload ══ */

(async function restore() {
  if (!getToken()) return;
  try {
    enterDesktop(await api.session());
  } catch {
    setToken(null); // Relay restarted or the connection dropped; show the greeter.
  }
})();
