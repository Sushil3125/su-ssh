/** main.js — greeter, session lifecycle, desktop surface, dock, host rail. */

// First, and with a top-level await inside: nothing below runs until this
// browser has proved it arrived through the relay's access link.
import './access.js';

import { setTokenRejectedHandler } from './api.js';
import { connectWithTrust, presentConnectError, isThrottled } from './host-trust.js';
import { openFiles, openEditor, openTerminal, openViewer, openForwards } from './apps.js';
import {
  createWorkspace, destroyWorkspace, showWorkspace, useWorkspace, closeAll,
  setWorkspaceFrozen, setWindowCountListener, setLayoutChangeListener, escapeHtml,
} from './wm.js';
import {
  noteLayoutChange, installLayoutPersistence, restoreWindows, showRestoreNotice,
  forgetLayout, clearLayouts, restoreProfileWindows, askAboutRestore,
  hasSavedLayout, setRestoreMode, restoreModeOf, flushLayout,
} from './restore.js';
import {
  loadProfiles, migrateLocalStorage, allProfiles, profileFor, saveProfile,
  forgetProfile as forgetProfileOnRelay, forgetUnpinnedProfiles, absorbProfile,
  onProfilesChange,
} from './profiles.js';
import { toast, contextMenu, confirmDialog, openDialog, modalOpen, fileIcon } from './ui.js';
import { icon, iconButton } from './icon.js';
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
const recentsBox = document.getElementById('recents');
const recentsList = document.getElementById('recents-list');

/**
 * Fill the profile cache from the relay before anything paints, importing
 * whatever this browser still had in localStorage on the way. Top-level await:
 * the greeter with an empty recents list, followed a beat later by the real
 * one, reads as "it forgot" — which is the exact complaint being fixed.
 */
let profileError = null;
try {
  await loadProfiles();
  await migrateLocalStorage();
} catch (err) {
  // Loudly, not silently: an unreadable profile file means saved servers,
  // tunnels and layouts are not there, and the user has to know that before
  // they wonder where their pins went.
  profileError = err;
  console.error('[profiles]', err);
}

/** A profile as the recents list renders it — the port as a string, as the markup expects. */
const asEntry = (p) => ({ ...p, port: String(p.port || 22) });

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

const byRecency = (a, b) => String(b.lastConnected || '').localeCompare(String(a.lastConnected || ''));

function sortedRecents() {
  return allProfiles().map(asEntry)
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || byRecency(a, b));
}

const recentById = (id) => {
  const p = profileFor(id);
  return p ? asEntry(p) : null;
};

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
      ${iconButton(entry.pinned ? 'pin' : 'pin-off', entry.pinned ? 'Unpin' : 'Pin to the top',
        { size: 15, className: 'recent__pin', attrs: `data-act="pin" aria-pressed="${entry.pinned}"` })}
      <button type="button" class="recent__main" data-act="use"
              title="${needsNoSecret(entry) ? 'Connect now (agent authentication needs no secret)' : 'Fill the form with this server'}">
        <span class="recent__target">${color ? '<i class="recent__swatch" aria-hidden="true"></i>' : ''}${identity?.label ? `${escapeHtml(identity.label)} — ` : ''}${escapeHtml(entry.username)}<span class="recent__at">@</span>${escapeHtml(entry.host)}${entry.port === '22' ? '' : `<span class="recent__at">:</span>${escapeHtml(entry.port)}`}</span>
        <span class="recent__meta">${escapeHtml(describeEntry(entry))}</span>
      </button>
      ${needsNoSecret(entry)
        ? iconButton('arrow-right', 'Connect now', { size: 15, className: 'recent__go', attrs: 'data-act="connect"' })
        : ''}
      ${iconButton('x', `Forget ${entry.username}@${entry.host}`, { size: 15, className: 'recent__x', attrs: 'data-act="forget"' })}
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

recentsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.recent').dataset.id;
  const entry = recentById(id);
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
  // Pinning and forgetting are relay-side now, so they hold for every browser.
  if (btn.dataset.act === 'pin') {
    try { await saveProfile({ id, pinned: !entry.pinned }); }
    catch (err) { toast(`Could not save that: ${err.message}`, 'bad', 8000); }
    return;
  }
  if (btn.dataset.act === 'forget') {
    try { await forgetProfileOnRelay(id); }
    catch (err) { toast(`Could not forget that server: ${err.message}`, 'bad', 8000); }
  }
});

recentsList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest('[data-act="use"]')) return;
  // Enter on the row is the keyboard equivalent of the → button.
  const entry = recentById(e.target.closest('.recent').dataset.id);
  if (entry && needsNoSecret(entry)) { e.preventDefault(); useRecent(entry); form.requestSubmit(); }
});

document.getElementById('recents-clear').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Clear unpinned connections?',
    message: 'Pinned servers are kept, with their labels, saved tunnels and saved windows. '
      + 'This clears them on the relay, so it clears them for every browser. '
      + 'Nothing on the servers themselves changes.',
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  try { await forgetUnpinnedProfiles(); }
  catch (err) { toast(`Could not clear those: ${err.message}`, 'bad', 8000); }
});

// The list repaints whenever the relay's answer changes — including after a
// pin, a rename made from the rail, or a forward saved by another window.
onProfilesChange(() => renderRecents());
renderRecents();

if (profileError) {
  toast(`Saved servers could not be read from the relay: ${profileError.message}`, 'bad', 15000);
}

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

/**
 * Refused while a modal is open, for the same reason `activate()` is.
 *
 * Without this the Alt+Shift+N path walked straight past the guard: the connect
 * form is not a modal, so it opened over the dialog, the SSH session was really
 * established, and then `activate()` refused it — leaving a live session to a
 * second host that the top bar, the tab title and the workspace all denied
 * existed. There is no acceptable version of "connected and invisible".
 */
async function requestAddConnection() {
  if (modalOpen()) {
    return toast('Answer the open dialog before adding a connection.', 'bad');
  }
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
    // The relay counted this connection and handed back the profile it now
    // holds — label, colour, saved forwards, saved layout. Nothing is written
    // to this browser's storage; that is the whole point.
    if (meta.profile) absorbProfile(meta.profile);

    // Clear the secrets from the DOM the moment they are no longer needed.
    document.getElementById('f-password').value = '';
    document.getElementById('f-privatekey').value = '';
    document.getElementById('f-passphrase').value = '';
    document.getElementById('f-passphrase2').value = '';

    const slot = replacing ? allSessions().indexOf(replacing) : null;
    if (replacing) discardSession(replacing);
    const session = createSession(meta, { position: slot });
    closeGreeter();
    activate(session, { force: true });
    reportForwards(session, meta.forwards);
    toast(`Connected to ${session.label}.`, 'good');
    // Last, and awaited: the windows go back on top of a desktop that is
    // already live, and the ask-once dialog is the only thing on screen.
    await offerWorkspaceRestore(session);
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

/**
 * Say plainly which tunnels came up and which did not — queued on the greeter
 * and reopened from this server's saved list alike. A saved forward whose port
 * has been taken since is a normal, expected outcome and must not look like a
 * broken connection, so it is named as one failure among several rather than
 * swallowed or escalated.
 */
function reportForwards(session, forwards = []) {
  const failed = forwards.filter((f) => f.status === 'error');
  const ok = forwards.filter((f) => f.status !== 'error');
  const reopened = ok.filter((f) => f.saved).length;
  if (ok.length) {
    session.toast(`${ok.length} port forward${ok.length === 1 ? '' : 's'} open`
      + `${reopened ? ` (${reopened} reopened from last time)` : ''}.`, 'good');
  }
  for (const f of failed) {
    session.toast(f.saved
      ? `Saved forward could not reopen: ${f.error}`
      : `Forward failed: ${f.error}`, 'bad', 9000);
  }
  if (failed.length) openForwards();
}

/**
 * Put this server's windows back, asking first if we never have.
 *
 * Wrapped whole: a failed restore must cost the layout, never the session the
 * user just successfully opened.
 */
async function offerWorkspaceRestore(session) {
  try {
    if (!hasSavedLayout(session)) return;
    await askAboutRestore(session);
    const summary = restoreProfileWindows(session);
    if (summary) showRestoreNotice(summary);
  } catch (err) {
    console.warn('[restore]', err);
    session.toast(`Could not reopen the saved windows: ${err.message}`, 'bad', 8000);
  }
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
function activate(session, { force = false } = {}) {
  if (!session) return false;
  // `force` is for a session that was created a moment ago: refusing to show it
  // does not undo the connection, it only hides it. Nothing else passes it.
  if (!force && modalOpen()) {
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
  paintOverview(session);
  if (session.status === 'connected') loadOverview(session);
  notify();
  return true;
}

/* ══════════════════════════════════════════ per-session overview card ══ */

/**
 * What the empty desktop says about this host (research C1).
 *
 * Four numbers a sysadmin opens a box to check — anything failed, how long it
 * has been up, how full the disk is, what tunnels are open — each one a link
 * into the app that can do something about it. Every figure comes from an
 * endpoint the desktop already calls (`/api/system`, `/api/services`,
 * `/api/forwards`); nothing new is polled. It is refreshed when you switch to
 * the session and no more often than every 30 seconds, plus on demand from the
 * card's own button, because a summary that updates itself every two seconds is
 * a second system monitor, and there is already one in the top bar.
 *
 * The card lives per session and carries the session's colour and label, so the
 * "failed: 2" you are reading can only ever belong to the host named on it.
 */
const OVERVIEW_MAX_AGE = 30_000;

function overviewHost() { return document.getElementById('desktop-cards'); }

function paintOverview(session) {
  for (const el of overviewHost().children) {
    el.classList.toggle('is-hidden', el.dataset.session !== session?.id);
  }
}

function overviewCard(session) {
  let card = overviewHost().querySelector(`[data-session="${session.id}"]`);
  if (card) return card;

  card = document.createElement('section');
  card.className = 'ovcard';
  card.dataset.session = session.id;
  card.innerHTML = `
    <header class="ovcard__head">
      <h2 class="ovcard__title"></h2>
      <span class="ovcard__sub"></span>
      <button class="ovcard__refresh" data-act="refresh" title="Refresh this summary" aria-label="Refresh this summary">⟳</button>
    </header>
    <div class="ovcard__tiles" data-role="tiles"></div>`;

  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    // The card belongs to one session and is only on screen while that session
    // is active, but assert it rather than trust the DOM: every other app
    // window in this codebase captures its session, and so does this.
    if (act !== 'refresh' && activeSession()?.id !== session.id) return;
    if (act === 'refresh') return void loadOverview(session, { force: true });
    if (act === 'services-failed') return void openServices(null, { filter: 'failed' });
    if (act === 'services') return void openServices();
    if (act === 'files') return void openFiles('~');
    if (act === 'ports') return void openForwards();
  });

  overviewHost().appendChild(card);
  return card;
}

const tile = ({ act = null, tone = '', label, value, note = '' }) => {
  const cls = `ovtile${tone ? ` ovtile--${tone}` : ''}`;
  const body = `<em>${escapeHtml(label)}</em><strong>${escapeHtml(String(value))}</strong>`
    + `<span>${escapeHtml(note)}</span>`;
  return act
    ? `<button type="button" class="${cls}" data-act="${act}">${body}</button>`
    : `<div class="${cls} ovtile--static">${body}</div>`;
};

/**
 * `uptime -p` says "up 5 hours, 21 minutes", which wraps onto two lines in a
 * 140px tile and shoves the row out of alignment. The two largest units in the
 * shortest form say the same thing: "5h 21m".
 */
function compactUptime(raw) {
  if (!raw || raw === '-') return '—';
  const parts = [];
  for (const [, n, unit] of String(raw).matchAll(/(\d+)\s*(year|month|week|day|hour|minute|second)/g)) {
    parts.push(`${n}${unit[0] === 'm' && unit !== 'month' ? 'm' : unit === 'month' ? 'mo' : unit[0]}`);
  }
  return parts.length ? parts.slice(0, 2).join(' ') : String(raw).replace(/^up /, '');
}

async function loadOverview(session, { force = false } = {}) {
  const card = overviewCard(session);
  card.style.setProperty('--session-color', session.color);
  card.querySelector('.ovcard__title').textContent = session.label;
  // hostPhrase is "label (user@host)", which reads as a stutter here because the
  // label is already the heading. Show the target, and only when it adds
  // something the heading does not already say.
  const target = `${session.username}@${session.host}${session.port === 22 ? '' : `:${session.port}`}`;
  const sub = card.querySelector('.ovcard__sub');
  sub.textContent = target === session.label ? (session.env || '') : target;
  sub.title = hostPhrase(session);

  if (session.status === 'dropped') {
    card.querySelector('[data-role="tiles"]').innerHTML =
      '<p class="ovcard__note">Disconnected — these figures are from before the drop.</p>';
    return;
  }
  if (!force && session.overviewAt && Date.now() - session.overviewAt < OVERVIEW_MAX_AGE) return;
  session.overviewAt = Date.now();

  const tiles = card.querySelector('[data-role="tiles"]');
  if (!tiles.childElementCount) tiles.innerHTML = '<p class="ovcard__note">Reading…</p>';

  // One settled batch: a box with no systemd should still show its uptime.
  const [system, services, forwards] = await Promise.allSettled([
    session.api.system(), session.api.services('system'), session.api.forwards(),
  ]);
  if (activeSession() !== session && !force) return;   // Switched away mid-flight.

  const info = system.status === 'fulfilled' ? system.value : {};
  const counts = services.status === 'fulfilled' ? services.value.counts : null;
  const fwd = forwards.status === 'fulfilled' ? forwards.value.forwards : null;

  const disk = /\((\d+)%\)/.exec(info.disk || '');
  const diskPct = disk ? Number(disk[1]) : null;
  const active = fwd ? fwd.filter((f) => f.status === 'active').length : null;
  const failing = fwd ? fwd.filter((f) => f.status === 'error').length : 0;

  tiles.innerHTML = [
    counts
      ? tile({
        act: counts.failed ? 'services-failed' : 'services',
        tone: counts.failed ? 'bad' : 'ok',
        label: 'Failed units',
        value: counts.failed,
        note: `of ${counts.total} loaded · ${counts.running} running`,
      })
      : tile({ act: 'services', label: 'Failed units', value: '—', note: 'systemd did not answer' }),

    tile({
      label: 'Uptime',
      value: compactUptime(info.uptime),
      note: info.distro && info.distro !== '-' ? info.distro : (info.kernel || ''),
    }),

    tile({
      act: 'files',
      tone: diskPct == null ? '' : diskPct >= 90 ? 'bad' : diskPct >= 75 ? 'warn' : 'ok',
      label: 'Disk',
      value: diskPct == null ? '—' : `${diskPct}%`,
      note: info.disk && info.disk !== '-' ? info.disk.replace(/\s*\(\d+%\)$/, '') : 'home filesystem',
    }),

    tile({
      act: 'ports',
      tone: failing ? 'bad' : active ? 'ok' : '',
      label: 'Forwards',
      value: active == null ? '—' : active,
      note: active == null ? 'unavailable' : failing ? `${failing} failed` : 'open tunnels',
    }),
  ].join('');
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
  // Split at the last "@" so the host half can be the one that survives a
  // squeeze (spec §3.6.3); a renamed session with no "@" is all host.
  const at = session.label.lastIndexOf('@');
  const conn = document.getElementById('topbar-conn');
  conn.querySelector('.conn__lead').textContent = at > 0 ? session.label.slice(0, at + 1) : '';
  conn.querySelector('.conn__host').textContent = at > 0 ? session.label.slice(at + 1) : session.label;
  conn.title = hostPhrase(session);
  const env = document.getElementById('topbar-env');
  env.textContent = session.env || '';
  env.classList.toggle('is-hidden', !session.env);
  line.style.background = session.color;

  // #link-dot used to be hard-coded "live" and never changed. It is now the
  // session's real state, with the word in the tooltip so it is not colour alone.
  const state = session.status === 'dropped' ? 'dropped'
    : session.status === 'connecting' ? 'reconnecting' : 'live';
  const DOT = {
    live:         { name: 'circle-dot', text: 'Connected' },
    reconnecting: { name: 'loader', text: 'Reconnecting…', className: 'icon--spin' },
    dropped:      { name: 'unplug', text: 'Connection lost' },
  }[state];
  dot.className = `dot dot--${state}`;
  dot.title = DOT.text;
  dot.setAttribute('aria-label', DOT.text);
  // A spinning loader is silent to a screen reader unless its container says so.
  dot.setAttribute('role', state === 'reconnecting' ? 'status' : 'img');
  dot.innerHTML = icon(DOT.name, { size: 13, className: DOT.className || '' });

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
    el.innerHTML = `<div class="dicon__glyph" aria-hidden="true">${fileIcon(entry, 33)}</div>
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
  loadOverview(session, { force: true });
  if (activeSession() === session) paintIdentity();
  renderRail();
}

/** Reconnect a dropped entry: same rail slot, new token, fresh workspace. */
function reconnect(session) {
  const entry = recentById(session.target)
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
  overviewHost().querySelector(`[data-session="${session.id}"]`)?.remove();
  forgetLayout(session.token);   // Its windows are gone on purpose, not by accident.
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

  // Write the layout to the relay *before* the windows close. Pressing
  // Disconnect is the clearest possible statement of "this is the screen I am
  // leaving"; a debounced write that has not fired yet would lose it.
  try { await flushLayout(session); } catch { /* the layout is not worth failing a disconnect */ }

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
    try { await flushLayout(session); } catch { /* as above */ }
    if (!await closeWindowsWithConsent(session)) return;
  }
  for (const session of sessions) {
    try { await session.api.disconnect(); } catch { /* already gone */ }
    discardSession(session);
  }
  clearPersisted();
  clearLayouts();
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
      + 'the top bar, every window title and every confirmation. They are stored on the relay, so '
      + 'every browser that reaches this relay sees them.',
    fields: [
      { name: 'label', label: 'Label', value: session.label },
      { name: 'env', label: 'Environment tag (optional)', value: session.env, placeholder: ENV_TAGS.filter(Boolean).join(' / '),
        hint: 'Tagging a host "prod" forces the red colour and makes destructive confirmations ask you to type its host name.' },
      { name: 'color', label: 'Colour', value: session.color, placeholder: PALETTE.join(' ') },
      // Where the ask-once answer is changed afterwards. It sits with the other
      // per-server settings because that is the only place someone would look.
      { name: 'restore', label: 'Reopen windows on connect', value: restoreModeOf(session.target),
        placeholder: 'yes / no / ask',
        hint: 'yes = put the windows back every time · no = always start empty · ask = ask me once more. '
          + 'Reopened terminals are always new shells and are labelled as such.' },
    ],
    confirmLabel: 'Save',
    accent: session.color,
  });
  if (!result) return;
  const env = result.env.trim().toLowerCase();
  try {
    await saveIdentity(session.target, {
      label: result.label.trim() || session.label,
      env,
      production: env === 'prod',
      color: /^#[0-9a-f]{6}$/i.test(result.color.trim()) ? result.color.trim() : session.color,
    });
    const mode = result.restore.trim().toLowerCase();
    if (['yes', 'no', 'ask'].includes(mode) && mode !== restoreModeOf(session.target)) {
      await setRestoreMode(session.target, mode);
    }
  } catch (err) {
    toast(`Could not save that on the relay: ${err.message}`, 'bad', 9000);
  }
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

// Every window move, resize, raise, open and close makes the saved layout
// stale; restore.js coalesces them and writes once, plus once more on the way
// out of the page. See restore.js for what is kept and what deliberately is not.
setLayoutChangeListener(noteLayoutChange);
installLayoutPersistence();

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
    clearLayouts();
    if (lost.length) {
      toast(lost.length === 1
        ? `${lost[0]} is no longer connected.`
        : `${lost.length} sessions were no longer connected: ${lost.join(', ')}.`, 'bad', 8000);
    }
    return;
  }

  // Put each session's windows back before showing anything.
  //
  // restoreWindows reads the active session and the active workspace, exactly
  // as a hand-opened window does, so each one is made current in turn. Their
  // layers are still hidden at this point — restoring into a hidden layer is
  // why saved geometry is passed through rather than measured (see wm.js
  // withGeometry). A window can therefore only land on the session it was
  // opened on, because that is the only session that was current when it ran.
  const target = restored.find((s) => s.token === activeToken) || restored[0];
  const summaries = [];
  for (const session of restored) {
    setActive(session);
    useWorkspace(session.workspace);
    try { summaries.push(restoreWindows(session)); } catch { /* one bad entry must not cost the rest */ }
  }
  setActive(null);
  activate(target);
  // After activate, so the notice for the visible session is painted into a
  // layer that is on screen; the others wait in their own layers.
  for (const summary of summaries) showRestoreNotice(summary);

  if (lost.length) {
    toast(lost.length === 1
      ? `${lost[0]} was no longer connected.`
      : `${lost.length} sessions were no longer connected: ${lost.join(', ')}.`, 'bad', 8000);
  }
})();
