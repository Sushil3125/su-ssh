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
    label: 'Image',
    describe: (s) => s.path,
    open: (s) => (s.path ? openViewer(s.path) : null),
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
  // Present so a terminal is *counted* and reported, never so it is reopened.
  terminal: { label: 'Terminal', describe: (s) => s.cwd || 'shell', open: null },
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

function snapshot() {
  const all = {};
  for (const ws of allWorkspaces()) {
    const session = sessionById(ws.id);
    if (!session?.token) continue;
    // Oldest first: ids are monotonic, so this is creation order, and restoring
    // in it means the cascade fallback lands the same way it did originally.
    const windows = [...ws.windows.values()]
      .map(describeWindow)
      .filter(Boolean)
      .slice(0, MAX_WINDOWS);
    if (windows.length) all[session.token] = { windows, savedAt: Date.now() };
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: no restore, but the tab still works */ }
}

let timer = null;
/** Coalesce: a drag ends, a window focuses and the dock repaints in one gesture. */
export function noteLayoutChange() {
  clearTimeout(timer);
  timer = setTimeout(snapshot, 250);
}

/** Write synchronously on the way out — `pagehide` is the only event a reload,
 *  a tab close and a navigation all fire, and it may be the last one we get. */
export function installLayoutPersistence() {
  window.addEventListener('pagehide', () => { clearTimeout(timer); snapshot(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(); });
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
  const saved = readAll()[session.token];
  if (!saved?.windows?.length) return null;

  const restored = [];
  const terminals = [];
  const skipped = [];
  const opened = [];

  for (const entry of saved.windows.slice(0, MAX_WINDOWS)) {
    const app = APPS[entry.app];
    if (!app) continue;
    if (!app.open) { terminals.push(entry); continue; }

    let win = null;
    try {
      win = withGeometry(entry.geo, () => app.open(entry));
    } catch (err) {
      skipped.push(`${app.label}: ${err.message}`);
      continue;
    }
    if (!win) { skipped.push(app.label); continue; }

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
  return { restored, terminals, skipped, session };
}

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
  const { restored, terminals, skipped, session } = summary;
  if (!restored.length && !terminals.length && !skipped.length) return;

  const lines = [];
  if (restored.length) {
    lines.push(`Reopened ${restored.length} window${restored.length === 1 ? '' : 's'}: ${restored.join(', ')}.`);
  }
  if (terminals.length) {
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
  if (terminals.length) {
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
