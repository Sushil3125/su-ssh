/**
 * restore.js — put the windows back after a refresh, and say what came back.
 *
 * Before this, F5 kept every SSH session alive on the relay and destroyed every
 * window in the browser without a word (UX research F3/M3): five windows in,
 * one accidental Ctrl+R, empty desktop, no message. The sessions were never the
 * fragile part — the layout was, and it lived only in the DOM.
 *
 * What is persisted is deliberately small: per session, per window, which app
 * it was, the rectangle it occupied, whether it was minimised or maximised,
 * where it sat in the stack, and the few values that say what it was *showing*
 * (a directory, a file, a unit and which of its tabs). No content, no buffers,
 * no scrollback — sessionStorage is a few megabytes and shared with the session
 * tokens, and a stale copy of a file is worse than no copy.
 *
 * ── Terminals ────────────────────────────────────────────────────────────
 * A terminal window is remembered but never reopened, and this is the one
 * decision here worth arguing for. The window was a view onto a PTY on the far
 * side; `journalctl -f` and a shell both die when the WebSocket closes, which a
 * page reload guarantees. Re-opening the window would spawn a *different* shell
 * — new PID, no history, no `cd`, no half-typed command, nothing that was on
 * the screen — while looking exactly like the one that was there before. For an
 * audience whose failure mode is "my command went somewhere", a terminal that
 * silently is not the terminal you left is worse than no terminal at all. So
 * the restore notice says how many ended, offers to open a fresh one, and
 * remembers the directory the old one was opened at so that offer is useful.
 *
 * Everything is keyed by session token, so a restored window can only ever
 * belong to the session it was opened on: the token is the session's identity
 * on the relay, and two tabs on the same host have two tokens.
 */

import {
  allWorkspaces, withGeometry, windowGeometry, applyWindowState, clampWindows, focus,
} from './wm.js';
import { openFiles, openEditor, openViewer, openForwards, openTerminal } from './apps.js';
import { openServices } from './services.js';
import { activeSession, sessionById } from './sessions.js';
import { openDialog } from './ui.js';
import { profileFor, saveProfile } from './profiles.js';

const KEY = 'ssh-window-layout';

/**
 * A ceiling on both ends. Ten is more windows than the cascade can place
 * without overlap anyway, and a layout blob that grows without limit would
 * eventually push the session tokens out of sessionStorage — trading a lost
 * layout for a lost session, which is the wrong way round.
 */
const MAX_WINDOWS = 10;

/** What a saved window may be. Anything else in storage is ignored. */
const APPS = {
  files: {
    label: 'Files',
    describe: (s) => s.path || '~',
    open: (s) => openFiles(s.path || '~'),
  },
  editor: {
    label: 'Editor',
    describe: (s) => `${s.path || 'new file'}${s.dirty ? ' (unsaved edits were lost)' : ''}`,
    open: (s) => openEditor(s.path || null),
  },
  viewer: {
    label: 'Viewer',
    describe: (s) => s.path,
    open: (s) => (s.path ? openViewer(s.path, { mode: typeof s.mode === 'string' ? s.mode : null }) : null),
  },
  ports: {
    label: 'Port forwarding',
    describe: () => 'forwards',
    open: () => openForwards(),
  },
  services: {
    label: 'Services',
    describe: (s) => (s.unit ? `${s.unit}${s.tab && s.tab !== 'status' ? ` · ${s.tab}` : ''}` : 'all units'),
    open: (s) => openServices(s.unit || null, { scope: s.scope, tab: s.tab }),
  },
  /**
   * A terminal is *counted* on a refresh and reopened on a reconnect.
   *
   * The two are genuinely different. A refresh is seconds long and the PTY on
   * the far side died with the WebSocket; resurrecting the window there would
   * put a different shell — new PID, no history, no `cd` — exactly where the
   * old one was, which for an audience whose failure mode is "my command went
   * somewhere" is worse than an empty desktop. A reconnect is the user asking
   * for the screen they left, and the whole SSH session is new anyway, so
   * nothing is being impersonated. It is reopened with `fresh: true`, which
   * writes a banner into the terminal and marks the window "new shell" — see
   * openTerminal in apps.js. Nobody can mistake one for the shell they left.
   */
  terminal: {
    label: 'Terminal',
    describe: (s) => s.cwd || 'shell',
    open: null,
    reopen: (s) => openTerminal(s.cwd || null, { fresh: true }),
  },
};

/* ───────────────────────────────────────────────────────────── writing ─── */

function readAll() {
  try {
    const all = JSON.parse(sessionStorage.getItem(KEY) || '{}');
    return all && typeof all === 'object' ? all : {};
  } catch { return {}; }
}

/** One window, as it will be read back. Returns null for anything unsaveable. */
function describeWindow(win) {
  let state = {};
  try { state = win.restore?.() || {}; } catch { state = {}; }
  const app = state.app || win.appId;
  if (!app || !APPS[app]) return null;
  return { app, ...state, geo: windowGeometry(win) };
}

/** One workspace's windows, oldest first — creation order, so the cascade
 *  fallback lands the same way it did originally. */
function layoutOf(ws) {
  return [...ws.windows.values()].map(describeWindow).filter(Boolean).slice(0, MAX_WINDOWS);
}

function snapshot() {
  const all = {};
  for (const ws of allWorkspaces()) {
    const session = sessionById(ws.id);
    if (!session?.token) continue;
    const windows = layoutOf(ws);
    if (windows.length) all[session.token] = { windows, savedAt: Date.now() };
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: no restore, but the tab still works */ }
}

/* ─────────────────────────────────────────── the relay's copy ─────────── */

/**
 * The same snapshot, keyed by *profile* rather than by token, sent to the relay.
 *
 * sessionStorage above answers "I pressed F5": it is per tab, it dies with the
 * tab, and that is right for it. It cannot answer "I disconnected yesterday and
 * came back in a different browser", because it is neither shared nor durable.
 * So the layout is written twice — once per tab for the refresh path, once per
 * server on the relay for the reconnect path.
 *
 * Only for sessions that are still connected: freezing a dropped session's
 * windows into the profile would restore a layout the user never chose to leave.
 */
const lastSent = new Map();   // profile id → the JSON we last wrote, to skip no-ops
const hadWindows = new Set(); // targets this tab has actually seen windows on

function sendLayouts({ beacon = false } = {}) {
  for (const ws of allWorkspaces()) {
    const session = sessionById(ws.id);
    if (!session?.target || session.status !== 'connected') continue;
    const profile = profileFor(session.target);
    // Never against the user's wishes, and never before they have been asked.
    if (profile?.restore === 'no') continue;

    const windows = layoutOf(ws);
    if (windows.length) hadWindows.add(session.target);
    // A freshly connected session is empty for the moment between the desktop
    // appearing and the restore running. Writing that emptiness would destroy
    // the very layout we are about to put back, so an empty desktop only
    // clears a saved layout once this tab has actually had windows on it —
    // which is what "I closed them all" looks like and "I have not restored
    // yet" does not.
    else if ((profile?.layout?.windows?.length || 0) && !hadWindows.has(session.target)) continue;

    const body = { id: session.target, layout: { windows, savedAt: Date.now() } };
    const fingerprint = JSON.stringify(windows);
    if (lastSent.get(session.target) === fingerprint) continue;
    lastSent.set(session.target, fingerprint);

    if (beacon && navigator.sendBeacon) {
      // On the way out there is no time for a round trip. A beacon is a POST
      // with our own cookie, which is all the relay needs.
      try {
        navigator.sendBeacon('/api/profiles/update', new Blob([JSON.stringify(body)], { type: 'application/json' }));
        continue;
      } catch { /* fall through to fetch */ }
    }
    saveProfile(body).catch(() => { lastSent.delete(session.target); });
  }
}

let timer = null;
let relayTimer = null;

/** Coalesce: a drag ends, a window focuses and the dock repaints in one gesture. */
export function noteLayoutChange() {
  clearTimeout(timer);
  timer = setTimeout(snapshot, 250);
  // The relay's copy is coalesced harder: it is a network round trip, and
  // nothing reads it until the next connect.
  clearTimeout(relayTimer);
  relayTimer = setTimeout(() => sendLayouts(), 1200);
}

/** Write synchronously on the way out — `pagehide` is the only event a reload,
 *  a tab close and a navigation all fire, and it may be the last one we get. */
export function installLayoutPersistence() {
  window.addEventListener('pagehide', () => {
    clearTimeout(timer); clearTimeout(relayTimer);
    snapshot(); sendLayouts({ beacon: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    snapshot();
    clearTimeout(relayTimer);
    sendLayouts();
  });
}

/** Write one session's layout to the relay now — used just before a disconnect,
 *  which is precisely the moment the user is telling us what to come back to. */
export function flushLayout(session) {
  if (!session?.target || session.status !== 'connected') return;
  const ws = session.workspace;
  if (!ws) return;
  const profile = profileFor(session.target);
  if (profile?.restore === 'no') return;
  const layout = { windows: layoutOf(ws), savedAt: Date.now() };
  if (layout.windows.length) hadWindows.add(session.target);
  else if ((profile?.layout?.windows?.length || 0) && !hadWindows.has(session.target)) return;
  lastSent.set(session.target, JSON.stringify(layout.windows));
  return saveProfile({ id: session.target, layout }).catch(() => { /* reported by the caller's toast */ });
}

/** A session that went away for good should not leave its layout behind. */
export function forgetLayout(token) {
  const all = readAll();
  if (!(token in all)) return;
  delete all[token];
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* nothing to do */ }
}

export function clearLayouts() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/* ───────────────────────────────────────────────────────────── reading ─── */

/**
 * Re-open one session's windows.
 *
 * The caller must have made `session` both the active session and the active
 * workspace first, because the app openers capture the session they belong to
 * from exactly those two places — the same rule every other window follows.
 * Nothing here takes a token or a session as an argument for that reason: a
 * window that could be "pointed at" a session is a window that can be pointed
 * at the wrong one.
 *
 * Returns a summary, or null if there was nothing saved for this session.
 */
export function restoreWindows(session) {
  return putBack(session, readAll()[session.token], { reopenTerminals: false });
}

/**
 * Re-open one session's windows from the *relay's* copy, after a fresh connect.
 *
 * Same machinery, one difference: terminals come back, because this is the user
 * asking for the screen they left rather than a page reload. Returns null when
 * there is nothing saved, when the user said no for this server, or when they
 * have not been asked yet — askAboutRestore is what turns 'ask' into an answer.
 */
export function restoreProfileWindows(session) {
  const profile = profileFor(session.target);
  if (!profile || profile.restore !== 'yes') return null;
  return putBack(session, profile.layout, { reopenTerminals: true, fromProfile: true });
}

/** Is there anything worth offering to restore for this session's server? */
export function hasSavedLayout(session) {
  return (profileFor(session.target)?.layout?.windows?.length || 0) > 0;
}

function putBack(session, saved, { reopenTerminals = false, fromProfile = false } = {}) {
  if (!saved?.windows?.length) return null;

  const restored = [];
  const terminals = [];
  const skipped = [];
  const opened = [];

  for (const entry of saved.windows.slice(0, MAX_WINDOWS)) {
    const app = APPS[entry.app];
    if (!app) continue;
    const opener = app.open || (reopenTerminals ? app.reopen : null);
    if (!opener) { terminals.push(entry); continue; }

    let win = null;
    try {
      win = withGeometry(entry.geo, () => opener(entry));
    } catch (err) {
      skipped.push(`${app.label}: ${err.message}`);
      continue;
    }
    if (!win) { skipped.push(app.label); continue; }
    if (!app.open) terminals.push(entry);   // reopened, but still worth naming

    applyWindowState(win, entry.geo || {});
    opened.push({ win, entry });
    restored.push(`${app.label} — ${app.describe(entry)}`);
  }

  // Raise the one that was on top last, so the session comes back looking at
  // what it was looking at rather than at whatever opened last.
  const top = opened
    .filter(({ entry }) => !entry.geo?.min)
    .sort((a, b) => (a.entry.geo?.z || 0) - (b.entry.geo?.z || 0))
    .pop();
  if (top) focus(top.win.id);

  clampWindows();
  return { restored, terminals, skipped, session, reopenedTerminals: reopenTerminals, fromProfile };
}

/* ────────────────────────────────────────────── asking, exactly once ──── */

/**
 * "Do you want your windows back on this server?" — asked once per profile.
 *
 * Once, because a question on every connect is a question nobody reads, and
 * because the owner asked for it to be remembered. Default yes: it is the
 * primary action and what Enter does, which is what "by default the things
 * should persist" has to mean in a dialog. The answer is stored on the relay
 * with everything else, so a second browser inherits it instead of asking
 * again, and it is changeable afterwards from the rename dialog and from the
 * restore notice.
 *
 * Returns the mode now in force ('yes' | 'no'), or null if nothing was asked.
 */
export async function askAboutRestore(session) {
  const profile = profileFor(session.target);
  if (!profile) return null;
  if (profile.restore === 'yes' || profile.restore === 'no') return profile.restore;
  if (!profile.layout?.windows?.length) return null;   // nothing worth asking about yet

  const windows = profile.layout.windows;
  const names = windows.map((w) => APPS[w.app]?.label || w.app);
  const terms = windows.filter((w) => w.app === 'terminal').length;

  const answer = await openDialog({
    title: `Reopen your windows on ${session.label}?`,
    message: `Last time you were on ${session.username}@${session.host}, `
      + `${windows.length} window${windows.length === 1 ? ' was' : 's were'} open: ${names.join(', ')}. `
      + 'su-ssh can put them back where they were every time you connect to this server.'
      + (terms
        ? `\n\n${terms === 1 ? 'The terminal comes' : 'Terminals come'} back as a brand-new shell in the same `
          + 'directory — no scrollback, no history, nothing still running from last time. It is labelled as such.'
        : '')
      + '\n\nThis is asked once per server. You can change it later from the connection’s name dialog.',
    confirmLabel: 'Reopen them',
    cancelLabel: 'Start empty',
    accent: session.color,
    // Not dismissable, so "null" can only mean the Start empty button. Asked
    // once per server, the answer has to be an answer — and an Escape that
    // quietly recorded "never again" would be the worst possible reading.
    dismissable: false,
  });

  // openDialog resolves the (empty) field set on confirm and null on cancel.
  // Confirm is the primary button and holds focus, so Enter is yes: that is
  // what "by default the things should persist" means in a dialog.
  const mode = answer === null ? 'no' : 'yes';
  await setRestoreMode(session.target, mode);
  return mode;
}

/** Change the answer later. 'ask' puts the question back for this server. */
export function setRestoreMode(target, mode) {
  return saveProfile({ id: target, restore: mode });
}

export const restoreModeOf = (target) => profileFor(target)?.restore || 'ask';

/* ────────────────────────────────────────────────────── the notice ────── */

/**
 * A strip inside the session's own window layer — not a toast.
 *
 * It has to be per session (a restored Services window on staging must not be
 * announced on the prod desktop), it has to survive longer than four seconds
 * because it carries the one thing the user might want to act on, and the
 * terminal line needs a button. A toast is none of those things.
 */
export function showRestoreNotice(summary) {
  if (!summary) return;
  const { restored, terminals, skipped, session, reopenedTerminals, fromProfile } = summary;
  if (!restored.length && !terminals.length && !skipped.length) return;

  const lines = [];
  if (restored.length) {
    lines.push(`Reopened ${restored.length} window${restored.length === 1 ? '' : 's'}: ${restored.join(', ')}.`);
  }
  if (terminals.length && reopenedTerminals) {
    // Said here as well as inside the terminal itself. Two places, because
    // "this is not the shell you left" is the one thing that must not be missed.
    lines.push(`${terminals.length === 1 ? 'The terminal is a NEW shell' : `${terminals.length} terminals are NEW shells`}`
      + ' in the same directory — no scrollback, no history, nothing still running from last time.');
  } else if (terminals.length) {
    lines.push(`${terminals.length} terminal${terminals.length === 1 ? '' : 's'} could not come back —`
      + ` the shell${terminals.length === 1 ? '' : 's'} ended when the page reloaded.`);
  }
  if (skipped.length) lines.push(`Could not reopen: ${skipped.join(', ')}.`);

  const el = document.createElement('div');
  el.className = 'ws-notice';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="ws-notice__text"></span>
    <span class="ws-notice__acts"></span>
    <button class="ws-notice__x" data-act="dismiss" title="Dismiss" aria-label="Dismiss">✕</button>`;
  el.querySelector('.ws-notice__text').textContent = `${session.label}: ${lines.join(' ')}`;

  const acts = el.querySelector('.ws-notice__acts');

  // The way to change the ask-once answer without hunting for it: right where
  // the consequence of that answer just appeared.
  if (fromProfile) {
    const stop = document.createElement('button');
    stop.className = 'btn btn--sm';
    stop.textContent = 'Don’t reopen next time';
    stop.title = `Stop reopening windows when you connect to ${session.username}@${session.host}`;
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try { await setRestoreMode(session.target, 'no'); } catch { /* the toast below is enough */ }
      el.querySelector('.ws-notice__text').textContent =
        `${session.label}: windows will not be reopened on this server again. `
        + 'You can turn it back on from this connection’s name dialog.';
      stop.remove();
    });
    acts.appendChild(stop);
  }

  if (terminals.length && !reopenedTerminals) {
    const cwd = terminals.find((t) => t.cwd)?.cwd || null;
    const button = document.createElement('button');
    button.className = 'btn btn--sm';
    button.textContent = cwd ? `New terminal in ${cwd}` : 'New terminal';
    button.addEventListener('click', () => {
      // The notice lives in one session's layer, and only the active session's
      // layer is on screen — but assert it anyway rather than trust the DOM.
      if (activeSession()?.id !== session.id) return;
      openTerminal(cwd);
      el.remove();
    });
    acts.appendChild(button);
  }

  el.querySelector('[data-act="dismiss"]').addEventListener('click', () => el.remove());
  session.workspace.layer.appendChild(el);
}
