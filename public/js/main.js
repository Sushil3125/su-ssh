/** main.js — greeter, session lifecycle, desktop surface, dock, host rail. */

// First, and with a top-level await inside: nothing below runs until this
// browser has proved it arrived through the relay's access link.
import './access.js';

import { setTokenRejectedHandler } from './api.js';
import { connectWithTrust, presentConnectError, isThrottled } from './host-trust.js';
import { openFiles, openEditor, openTerminal, openViewer, openForwards } from './apps.js';
import {
  createWorkspace, destroyWorkspace, showWorkspace, useWorkspace, closeAll,
  setWorkspaceFrozen, setWindowCountListener, escapeHtml,
} from './wm.js';
import { toast, contextMenu, confirmDialog, openDialog, modalOpen, GLYPH } from './ui.js';
import { forwardFormHtml, wireForwardForm, forwardRowHtml } from './forwards.js';
import { openServices } from './services.js';
import { startSystemMonitor } from './sysmon.js';
import { initRail, renderRail, railShortcut } from './rail.js';
import {
  installTerminalKeyClaims, initCapture, toggleCapture, openShortcutsPanel, makeUnloadGuard,
} from './keyboard.js';
import {
  addSession, removeSession, setActive, activeSession, allSessions, sessionByToken,
  mostRecentOther, markDropped, notify, onChange, atFull, MAX_PER_TAB, targetId,
  savedSessions, clearPersisted, restoreIdentity, saveIdentity, identityFor,
  startLivenessPoll, validateTokens, hostPhrase, dangerOpts, PALETTE, PROD_COLOR, ENV_TAGS,
} from './sessions.js';

const greeter = document.getElementById('greeter');
const shell = document.getElementById('shell');
const form = document.getElementById('connect-form');
const errorBox = document.getElementById('connect-error');
const connectBtn = document.getElementById('connect-btn');
const greeterCancel = document.getElementById('greeter-cancel');

let authMethod = 'password';
let clockTimer = null;

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

/** Agent auth needs no secret, so the row can simply connect. Everything else prefills. */
const needsNoSecret = (entry) => entry.authMethod === 'agent';

function renderRecents() {
  const rows = sortedRecents();
  recentsBox.classList.toggle('is-hidden', !rows.length);
  document.getElementById('recents-clear').classList.toggle('is-hidden', !rows.some((e) => !e.pinned));

  recentsList.innerHTML = rows.map((entry) => {
    const identity = identityFor(entry.id);
    const color = identity?.production ? PROD_COLOR : identity?.color;
    return `
    <div class="recent${entry.pinned ? ' is-pinned' : ''}" data-id="${escapeHtml(entry.id)}"${color ? ` style="--chip-color:${escapeHtml(color)}"` : ''}>
      <button type="button" class="recent__pin" data-act="pin"
              title="${entry.pinned ? 'Unpin' : 'Pin to the top'}"
              aria-pressed="${entry.pinned}">${entry.pinned ? '★' : '☆'}</button>
      <button type="button" class="recent__main" data-act="use"
              title="${needsNoSecret(entry) ? 'Connect now (agent authentication needs no secret)' : 'Fill the form with this server'}">
        <span class="recent__target">${color ? '<i class="recent__swatch" aria-hidden="true"></i>' : ''}${identity?.label ? `${escapeHtml(identity.label)} — ` : ''}${escapeHtml(entry.username)}<span class="recent__at">@</span>${escapeHtml(entry.host)}${entry.port === '22' ? '' : `<span class="recent__at">:</span>${escapeHtml(entry.port)}`}</span>
        <span class="recent__meta">${escapeHtml(describeEntry(entry))}</span>
      </button>
      ${needsNoSecret(entry)
        ? '<button type="button" class="recent__go" data-act="connect" title="Connect now" aria-label="Connect now">→</button>'
        : ''}
      <button type="button" class="recent__x" data-act="forget" title="Forget this server">✕</button>
    </div>`;
  }).join('');
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

  if (btn.dataset.act === 'connect') { useRecent(entry); return form.requestSubmit(); }
  if (btn.dataset.act === 'use') {
    // One click is enough when there is no secret to type. For every other
    // method the row still only prefills — asking for a password we then do
    // not use would be worse than one extra click.
    useRecent(entry);
    if (needsNoSecret(entry)) form.requestSubmit();
    return;
  }
  if (btn.dataset.act === 'pin') { entry.pinned = !entry.pinned; return saveRecents(); }
  if (btn.dataset.act === 'forget') {
    recents = recents.filter((r) => r.id !== id);
    return saveRecents();
  }
});

recentsList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest('[data-act="use"]')) return;
  // Enter on the row is the keyboard equivalent of the → button.
  const entry = recents.find((r) => r.id === e.target.closest('.recent').dataset.id);
  if (entry && needsNoSecret(entry)) { e.preventDefault(); useRecent(entry); form.requestSubmit(); }
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

const authTabs = document.getElementById('auth-tabs');

function setAuthMethod(name) {
  if (!AUTH_LABEL[name]) name = 'password';
  authMethod = name;
  // aria-selected, not just a class: a tab list that never says which tab is
  // selected tells a screen reader nothing about the state of the form.
  authTabs.querySelectorAll('.segmented__btn').forEach((b) => {
    const on = b.dataset.auth === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
    // Roving tabindex: one Tab stop for the whole group, arrows move inside it.
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.auth-pane')
    .forEach((p) => p.classList.toggle('is-hidden', p.dataset.pane !== name));
}

if (lastUsed) setAuthMethod(lastUsed.authMethod);
else setAuthMethod('password');

authTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (btn) setAuthMethod(btn.dataset.auth);
});

authTabs.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  const buttons = [...authTabs.querySelectorAll('.segmented__btn')];
  const at = buttons.indexOf(document.activeElement);
  if (at === -1) return;
  let next = null;
  if (step) next = buttons[(at + step + buttons.length) % buttons.length];
  if (e.key === 'Home') next = buttons[0];
  if (e.key === 'End') next = buttons[buttons.length - 1];
  if (!next) return;
  e.preventDefault();
  setAuthMethod(next.dataset.auth);
  next.focus();
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

/* ══════════════════════════════════ greeter as a page and as an overlay ═ */

/**
 * The greeter is the app's front door on a cold start and an "add a host"
 * overlay once something is connected. It is the same form either way — the
 * recents, the auth methods and the queued forwards are exactly what you want
 * when adding a second server, so there is no second component to keep in sync.
 */
let overlay = false;
/** Set while reconnecting a dropped entry, so the new session lands in its slot. */
let replacing = null;

function openGreeter({ asOverlay = false, prefill = null, replace = null } = {}) {
  overlay = asOverlay;
  replacing = replace;
  errorBox.classList.add('is-hidden');
  greeter.classList.toggle('greeter--overlay', asOverlay);
  greeterCancel.classList.toggle('is-hidden', !asOverlay);
  greeter.classList.remove('is-hidden');
  renderRecents();
  if (prefill) useRecent(prefill);
  else document.getElementById('f-host').focus();
}

function closeGreeter() {
  greeter.classList.add('is-hidden');
  greeter.classList.remove('greeter--overlay');
  overlay = false;
  replacing = null;
}

greeterCancel.addEventListener('click', () => { if (overlay) closeGreeter(); });

greeter.addEventListener('keydown', (e) => {
  // Esc backs out of the overlay only; on the front door there is nothing to
  // back out to, and swallowing Escape there would be a small mystery.
  if (e.key === 'Escape' && overlay && !modalOpen()) { e.preventDefault(); closeGreeter(); }
});

async function requestAddConnection() {
  if (atFull()) {
    return toast(`Limit of ${MAX_PER_TAB} connections reached. Disconnect one first.`, 'bad', 6000);
  }
  openGreeter({ asOverlay: allSessions().length > 0 });
}

/* ───────────────────────────────────────────────────────── connecting ──── */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('is-hidden');

  if (atFull() && !replacing) {
    errorBox.textContent = `Limit of ${MAX_PER_TAB} connections in this tab. Disconnect one first.`;
    errorBox.classList.remove('is-hidden');
    return;
  }

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

  // Connecting twice to the same target is allowed — two users' views of one
  // box is a real thing — but never by accident.
  const already = allSessions().find((s) => s.target === targetId(creds) && s.status !== 'dropped');
  if (already && !replacing) {
    const again = await openDialog({
      title: `Already connected to ${already.label}`,
      message: `This tab already holds a session as ${hostPhrase(already)}.`
        + ' You can switch to it, or open a second, independent session to the same server.',
      confirmLabel: 'Connect again',
      cancelLabel: 'Switch to it',
      accent: already.color,
    });
    if (again === null) { closeGreeter(); return activate(already); }
  }

  connectBtn.classList.add('is-busy');
  connectBtn.disabled = true;

  try {
    // Not relayApi.connect: this resolves a first-use host key prompt and
    // refuses a changed one. See host-trust.js.
    const meta = await connectWithTrust(creds);
    rememberTarget(creds);

    // Clear the secrets from the DOM the moment they are no longer needed.
    document.getElementById('f-password').value = '';
    document.getElementById('f-privatekey').value = '';
    document.getElementById('f-passphrase').value = '';
    document.getElementById('f-passphrase2').value = '';

    const slot = replacing ? allSessions().indexOf(replacing) : null;
    if (replacing) discardSession(replacing);
    const session = createSession(meta, { position: slot });
    closeGreeter();
    activate(session);
    reportForwards(session, meta.forwards);
    toast(`Connected to ${session.label}.`, 'good');
  } catch (err) {
    // The overlay stays open with the error and the form intact; whatever was
    // active underneath is untouched and still active.
    presentConnectError(err, { errorBox, connectBtn });
  } finally {
    connectBtn.classList.remove('is-busy');
    // Stays disabled while the relay is rate limiting us.
    connectBtn.disabled = isThrottled();
  }
});

/** Say plainly which queued tunnels came up and which did not. */
function reportForwards(session, forwards = []) {
  const failed = forwards.filter((f) => f.status === 'error');
  const ok = forwards.length - failed.length;
  if (ok) session.toast(`${ok} port forward${ok === 1 ? '' : 's'} open.`, 'good');
  for (const f of failed) session.toast(`Forward failed: ${f.error}`, 'bad', 8000);
  if (failed.length) openForwards();
}

/* ══════════════════════════════════════════════════════════ desktop ════ */

function createSession(meta, { position = null, saved = null } = {}) {
  const session = addSession(meta, { position });
  if (saved) restoreIdentity(session, saved);
  session.workspace = createWorkspace({
    id: session.id, label: session.label, color: session.color, host: `${session.username}@${session.host}`,
  });
  buildBanner(session);
  notify();
  return session;
}

/**
 * Switch to a session: hide one workspace, show another. Nothing closes.
 *
 * Refused while a modal is open, because a confirm or a sudo prompt was raised
 * by the session you are looking at, and answering it while looking at a
 * different desktop is the exact mistake this feature exists to prevent.
 */
function activate(session) {
  if (!session) return false;
  if (modalOpen()) {
    toast('Answer the open dialog before switching servers.', 'bad');
    return false;
  }
  const previous = activeSession();
  if (previous === session) return true;

  // Only the active session streams metrics (spec §3.3): a backgrounded host
  // keeps its terminals, journals and forwards, but stops sampling /proc.
  previous?.stopMonitor?.();
  if (previous) previous.stopMonitor = null;

  greeter.classList.add('is-hidden');
  shell.classList.remove('is-hidden');

  setActive(session);
  useWorkspace(session.workspace);
  showWorkspace(session.workspace);

  startClock();
  if (session.status === 'connected') {
    session.stopMonitor = startSystemMonitor(session.api);
    loadSystemInfo(session);
    if (!session.iconsLoaded) { session.iconsLoaded = true; loadDesktopIcons(session); }
  }
  paintIdentity();
  paintDesktopHint(session);
  notify();
  return true;
}

function paintDesktopHint(session) {
  const hint = document.getElementById('desktop-hint');
  const saved = session.hint || { text: 'Reading ~/Desktop over SFTP…', hidden: false };
  hint.textContent = saved.text;
  hint.classList.toggle('is-hidden', saved.hidden);
}

/** The top bar, the colour line, the tab title — all four identity places at once. */
function paintIdentity() {
  const session = activeSession();
  const chip = document.getElementById('topbar-chip');
  const dot = document.getElementById('link-dot');
  const line = document.getElementById('hostline');

  if (!session) {
    document.title = 'su-ssh — Remote Desktop over SSH';
    return;
  }
  chip.style.setProperty('--chip-color', session.color);
  document.getElementById('topbar-conn').textContent = session.label;
  document.getElementById('topbar-conn').title = hostPhrase(session);
  const env = document.getElementById('topbar-env');
  env.textContent = session.env || '';
  env.classList.toggle('is-hidden', !session.env);
  line.style.background = session.color;

  // #link-dot used to be hard-coded "live" and never changed. It is now the
  // session's real state, with the word in the tooltip so it is not colour alone.
  const state = session.status === 'dropped' ? 'dropped'
    : session.status === 'connecting' ? 'reconnecting' : 'live';
  dot.className = `dot dot--${state}`;
  dot.title = { live: 'Connected', reconnecting: 'Reconnecting…', dropped: 'Connection lost' }[state];
  dot.setAttribute('aria-label', dot.title);

  document.title = `${session.label} · su-ssh`;
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

async function loadSystemInfo(session) {
  try {
    const info = await session.api.system();
    if (activeSession() !== session) return;   // Switched away while we waited.
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
 *
 * They are painted into the session's own icon surface, so switching hosts
 * swaps them along with everything else.
 */
async function loadDesktopIcons(session) {
  const api = session.api;
  const container = session.workspace.icons;
  const hint = document.getElementById('desktop-hint');
  // The hint element is shared chrome, so what it says is remembered per
  // session and repainted on activation — otherwise switching hosts leaves you
  // reading a sentence about a different machine.
  const setHint = (text, hidden = false) => {
    session.hint = { text, hidden };
    if (activeSession() !== session) return;
    hint.textContent = text;
    hint.classList.toggle('is-hidden', hidden);
  };

  let data;
  let source = `${session.home}/Desktop`;
  try {
    data = await api.list(source);
  } catch {
    source = session.home;
    try {
      data = await api.list(source);
      setHint('No ~/Desktop on this server, so your home directory is shown instead.');
    } catch (err) {
      setHint(`Could not read the home directory on ${session.label}: ${err.message}`);
      return;
    }
  }

  if (source.endsWith('/Desktop')) setHint('', true);

  const visible = data.entries.filter((e) => !e.name.startsWith('.'));
  if (!visible.length) {
    setHint(`${source} is empty. Open Files to look around.`);
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
      if (activeSession() !== session) return;
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
  if (e.target.closest('.dicon') || !activeSession()) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Open Files', onClick: () => openFiles('~') },
    { label: 'Open Terminal', onClick: () => openTerminal() },
    { label: 'New text file', onClick: () => openEditor() },
    { label: 'Port forwarding', onClick: () => openForwards() },
    { label: 'Services', onClick: () => openServices() },
    'separator',
    { label: 'Add connection…', onClick: () => requestAddConnection() },
    { label: 'Refresh desktop', onClick: () => loadDesktopIcons(activeSession()) },
  ]);
});

/* ═════════════════════════════════════════════════════════════ dock ════ */

document.getElementById('dock').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-launch]');
  if (!btn) return;
  const session = activeSession();
  if (!session) return;
  if (session.status === 'dropped') {
    return toast(`${session.label} is disconnected. Reconnect it first.`, 'bad');
  }
  ({
    files: () => openFiles('~'),
    terminal: () => openTerminal(),
    ports: () => openForwards(),
    services: () => openServices(),
    editor: () => openEditor(),
  })[btn.dataset.launch]?.();
});

/* ═══════════════════════════════════════════════ drops and reconnection ═ */

/** The "connection lost" banner that lives on a workspace, per spec F2/F6/F29. */
function buildBanner(session) {
  const banner = document.createElement('div');
  banner.className = 'ws-banner is-hidden';
  banner.innerHTML = `<span class="ws-banner__text"></span>
    <button class="btn btn--sm btn--primary" data-act="reconnect">Reconnect</button>
    <button class="btn btn--sm" data-act="close">Close</button>`;
  banner.querySelector('[data-act="reconnect"]').addEventListener('click', () => reconnect(session));
  banner.querySelector('[data-act="close"]').addEventListener('click', () => closeDropped(session));
  session.workspace.layer.appendChild(banner);
  session.banner = banner;
}

/**
 * A session died without the user asking. Never auto-switch: the spec is
 * explicit, and being moved to another host mid-keystroke is how a command
 * lands on the wrong box.
 */
function handleDrop(session, reason = 'connection lost') {
  if (!markDropped(session, reason)) return;
  setWorkspaceFrozen(session.workspace, true);
  session.banner.querySelector('.ws-banner__text').textContent =
    `Connection to ${hostPhrase(session)} lost (${reason}). Its windows are frozen — nothing here is live.`;
  session.banner.classList.remove('is-hidden');
  toast(`${session.label} disconnected (${reason}).`, 'bad', 8000);
  if (activeSession() === session) paintIdentity();
  renderRail();
}

/** Reconnect a dropped entry: same rail slot, new token, fresh workspace. */
function reconnect(session) {
  const entry = recents.find((r) => r.id === session.target)
    || makeEntry({ host: session.host, port: session.port, username: session.username, authMethod: 'password' });
  openGreeter({ asOverlay: allSessions().length > 1, prefill: entry, replace: session });
}

async function closeDropped(session) {
  discardSession(session);
  await afterSessionRemoved();
}

/** Tear down a session's client-side state. Does not talk to the relay. */
function discardSession(session) {
  session.stopMonitor?.();
  destroyWorkspace(session.workspace);
  removeSession(session);
  notify();
}

/** After a session goes away: pick the next one, or fall back to the greeter. */
async function afterSessionRemoved() {
  // Removing a background session must not move you off the one you are on.
  if (activeSession()) { renderRail(); paintIdentity(); return; }
  const next = mostRecentOther(null);
  if (next) {
    activate(next);
  } else {
    shell.classList.add('is-hidden');
    document.getElementById('topbar-sys').textContent = '—';
    clearInterval(clockTimer);
    paintIdentity();
    openGreeter({ asOverlay: false });
  }
  renderRail();
}

/* ─────────────────────────────────────────────────────── disconnecting ── */

async function disconnectOne(session) {
  const windows = session.workspace.windows.size;
  let forwards = 0;
  try { forwards = (await session.api.forwards()).forwards.filter((f) => f.status === 'active').length; } catch { /* unknown; say nothing */ }

  const ok = await confirmDialog({
    title: `Disconnect ${session.label}?`,
    message: `${hostPhrase(session)}. ${windows} window${windows === 1 ? '' : 's'} will close`
      + (forwards ? ` and ${forwards} port forward${forwards === 1 ? '' : 's'} will be released.` : '.')
      + ' Other connections are unaffected.',
    confirmLabel: 'Disconnect',
    danger: true,
    ...dangerOpts(session),
  });
  if (!ok) return;

  // Editors with unsaved work get their say first, naming the session.
  if (!await closeWindowsWithConsent(session)) return;

  try { await session.api.disconnect(); } catch { /* the socket may already be gone */ }
  discardSession(session);
  await afterSessionRemoved();
  toast(`Disconnected ${session.label}.`, 'good');
}

/**
 * Close a session's windows honouring each window's own veto (the editor's
 * unsaved-changes prompt), so disconnecting never silently discards work.
 * Returns false if any window refused.
 */
async function closeWindowsWithConsent(session) {
  useWorkspace(session.workspace);
  for (const id of [...session.workspace.windows.keys()]) {
    const win = session.workspace.windows.get(id);
    if (!win) continue;
    if (await win.onClose?.() === false) {
      toast(`${session.label}: kept connected — unsaved changes.`, 'bad');
      useWorkspace(activeSession()?.workspace || session.workspace);
      return false;
    }
  }
  closeAll(session.workspace);
  useWorkspace(activeSession()?.workspace || session.workspace);
  return true;
}

async function disconnectAll() {
  const sessions = [...allSessions()];
  if (!sessions.length) return;
  const ok = await confirmDialog({
    title: `Disconnect all ${sessions.length} connection${sessions.length === 1 ? '' : 's'}?`,
    message: sessions.map((s) => `• ${hostPhrase(s)}`).join('\n')
      + '\n\nEvery window closes and every port forward these sessions opened is released.',
    confirmLabel: 'Disconnect all',
    danger: true,
  });
  if (!ok) return;

  for (const session of sessions) {
    if (!await closeWindowsWithConsent(session)) return;
  }
  for (const session of sessions) {
    try { await session.api.disconnect(); } catch { /* already gone */ }
    discardSession(session);
  }
  clearPersisted();
  await afterSessionRemoved();
  toast('All connections closed.', 'good');
}

document.getElementById('btn-disconnect').addEventListener('click', () => {
  const session = activeSession();
  if (session) disconnectOne(session);
});

/* ─────────────────────────────────────────────── naming and colouring ── */

async function renameSession(session) {
  const result = await openDialog({
    title: `Name for ${session.username}@${session.host}`,
    message: 'The label and colour are how this server is told apart from the others — in the rail, '
      + 'the top bar, every window title and every confirmation. They are remembered for this target '
      + 'on this browser only.',
    fields: [
      { name: 'label', label: 'Label', value: session.label },
      { name: 'env', label: 'Environment tag (optional)', value: session.env, placeholder: ENV_TAGS.filter(Boolean).join(' / '),
        hint: 'Tagging a host "prod" forces the red colour and makes destructive confirmations ask you to type its host name.' },
      { name: 'color', label: 'Colour', value: session.color, placeholder: PALETTE.join(' ') },
    ],
    confirmLabel: 'Save',
    accent: session.color,
  });
  if (!result) return;
  const env = result.env.trim().toLowerCase();
  saveIdentity(session.target, {
    label: result.label.trim() || session.label,
    env,
    production: env === 'prod',
    color: /^#[0-9a-f]{6}$/i.test(result.color.trim()) ? result.color.trim() : session.color,
  });
  paintIdentity();
  renderRail();
  renderRecents();
}

/* ══════════════════════════════════════════════════════════ the rail ═══ */

initRail({
  onSwitch: (session) => activate(session),
  onAdd: () => requestAddConnection(),
  onDisconnect: (session) => disconnectOne(session),
  onDisconnectAll: () => disconnectAll(),
  onReconnect: (session) => reconnect(session),
  onCloseDropped: (session) => closeDropped(session),
  onRename: (session) => renameSession(session),
});

/**
 * Ctrl+W is the browser's in a normal tab, so the only defence left is to make
 * leaving cost one extra keystroke — and only when there is a live shell to
 * lose. See keyboard.js for why the scope is this narrow.
 */
const syncUnloadGuard = makeUnloadGuard(allSessions);

onChange(() => { renderRail(); paintIdentity(); syncUnloadGuard(); });
setWindowCountListener(() => { renderRail(); syncUnloadGuard(); });

/* ════════════════════════════════════════════════════════ keyboard ═════ */

/**
 * Capture phase at `window`, before anything else sees the key. xterm gets the
 * same test through attachCustomKeyEventHandler (apps.js) so nothing reaches
 * the PTY; every other chord — Ctrl+C, Ctrl+D, Alt+B, Alt+F, Alt+. — is
 * untouched.
 */
window.addEventListener('keydown', (e) => {
  const hit = railShortcut(e);
  if (!hit) return;
  e.preventDefault();
  e.stopImmediatePropagation();

  if (hit.kind === 'add') return void requestAddConnection();
  if (hit.kind === 'capture') return void toggleCapture();
  if (hit.kind === 'help') return void openShortcutsPanel();

  const sessions = allSessions();
  if (!sessions.length) return;
  const at = sessions.indexOf(activeSession());

  if (hit.kind === 'jump') {
    const target = sessions[hit.index];
    if (!target) return void toast(`There is no connection ${hit.index + 1}.`, 'bad');
    return void activate(target);
  }
  const step = hit.kind === 'next' ? 1 : -1;
  activate(sessions[(at + step + sessions.length) % sessions.length]);
}, true);

// Registered *after* the rail listener, so the Alt+Shift family — which stops
// propagation entirely — is always consumed first and capture mode can never
// shadow it. This one only ever calls preventDefault().
installTerminalKeyClaims();
initCapture();

// F1 opens the shortcuts panel, but never while a terminal has focus: nano
// binds F1 to its own help, and stealing it would be precisely the bug this
// whole feature exists to fix.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (document.activeElement?.closest?.('.termhost')) return;
  e.preventDefault();
  openShortcutsPanel();
});

/* ══════════════════════════════════════════════════ restore on reload ══ */

// A 401 on any call with a session token is one of the three drop signals.
setTokenRejectedHandler((token) => {
  const session = sessionByToken(token);
  if (session) handleDrop(session, 'expired or closed');
});

startLivenessPoll((session, reason) => handleDrop(session, reason));

(async function restore() {
  const { entries, activeToken } = savedSessions();
  if (!entries.length) return;

  const live = await validateTokens(entries.map((e) => e.token));
  const restored = [];
  const lost = [];

  for (const saved of entries) {
    const meta = live[saved.token];
    if (!meta) { lost.push(saved.label || `${saved.username || '?'}@${saved.host || 'unknown host'}`); continue; }
    restored.push(createSession(meta, { saved: saved.legacy ? null : saved }));
  }

  if (!restored.length) {
    clearPersisted();
    if (lost.length) {
      toast(lost.length === 1
        ? `${lost[0]} is no longer connected.`
        : `${lost.length} sessions were no longer connected: ${lost.join(', ')}.`, 'bad', 8000);
    }
    return;
  }

  activate(restored.find((s) => s.token === activeToken) || restored[0]);
  if (lost.length) {
    toast(lost.length === 1
      ? `${lost[0]} was no longer connected.`
      : `${lost.length} sessions were no longer connected: ${lost.join(', ')}.`, 'bad', 8000);
  }
})();
