/**
 * sessions.js — the tab's live SSH sessions, and who each one is.
 *
 * This module is the model half of multi-session switching: the ordered list of
 * connections, their identity (label, colour, environment tag), their status,
 * what is persisted across a refresh, and the liveness poll that notices a
 * server going away while you were looking at another one. It owns no DOM —
 * the rail is rail.js and the workspaces are wm.js — so the rules about which
 * host an action hits can be read in one place.
 *
 * Two things here are load-bearing for the "never act on the wrong box" goal:
 *
 * 1. Every session carries its own `api` client, created once from its token
 *    (see api.js). Code never looks up "the current token".
 * 2. Every session carries its own `toast`, which prefixes messages from a
 *    session you are not currently looking at with that session's label. A
 *    bare "Service stopped" from a background host is exactly the message that
 *    makes someone think they stopped it on the host in front of them.
 */

import { createApi, relayApi } from './api.js';
import { toast as rawToast } from './ui.js';
import { identityOf, saveProfile } from './profiles.js';

/* ───────────────────────────────────────────────────────────── identity ── */

/**
 * Eight host hues, and the one colour that is not in this list.
 *
 * Red means production. Nothing else may read as red, so the auto palette
 * reserves the whole red/pink band (Lab hue 330°–42°) rather than merely
 * keeping its distance from `PROD_COLOR` — a "close enough" orange handed to an
 * arbitrary host is exactly how a prod chip stops meaning anything.
 *
 * The eight were picked by search rather than by eye, over the in-gamut colours
 * that clear 3.5:1 on the rail chrome, maximising the smallest CIEDE2000
 * distance across all 9·8/2 pairs (the eight plus the prod red) under normal
 * vision *and* under simulated protanopia, deuteranopia and tritanopia:
 *
 *   min ΔE2000 between any two, prod included .... 21.5  (blue vs indigo)
 *   min ΔE2000 from any host colour to the red ... 32.3  (mauve)
 *   min ΔE2000 protan / deutan / tritan .......... 13.3 / 11.9 / 11.9
 *   contrast on #1B1719 .......................... 4.55 – 11.4
 *
 * For scale: the palette this replaced had #E95420 and #E66100 ΔE2000 6.55
 * apart — 1.66 under deuteranopia, which is to say the same colour — and handed
 * that same #E95420 to arbitrary hosts ΔE 17.8 from the production red.
 *
 * `npm run check:palette` (tools/check-palette.mjs) re-derives every number
 * above from this file and fails if the values drift.
 *
 * Colour is never the only signal — the label ships with it everywhere — but it
 * is the one that works in peripheral vision and in a screenshot, so two live
 * hosts must never be a glance apart.
 */
export const PALETTE = [
  '#DA800D', // orange
  '#E7D032', // yellow
  '#98D28D', // green
  '#00987E', // teal
  '#37E5E0', // cyan
  '#29ADEF', // blue
  '#5C77F3', // indigo
  '#AC7BAA', // mauve
];

/** Production is not a palette choice. It is always this, and always tagged. */
export const PROD_COLOR = '#C01C28';

export const ENV_TAGS = ['', 'dev', 'staging', 'prod'];

/** How many sessions one browser tab will hold. Eight = eight number shortcuts. */
export const MAX_PER_TAB = 8;

const SESSIONS_KEY = 'ssh-sessions';
const ACTIVE_KEY = 'ssh-active-session';
const LEGACY_TOKEN_KEY = 'ssh-token';

export const targetId = (c) => `${c.username}@${c.host}:${c.port || 22}`;

/**
 * Identity the user has chosen for a target. It lives in the relay's profile
 * store, not in this browser: naming a host "prod-db" and colouring it red is
 * exactly the configuration that used to vanish when you opened a second
 * browser. Reads come from the profile cache (synchronous, filled at boot);
 * the write is a round trip, and the live sessions are re-labelled immediately
 * rather than waiting for it.
 */
export function identityFor(target) {
  return identityOf(target);
}

export function saveIdentity(target, patch) {
  const next = { ...(identityOf(target) || {}), ...patch };
  // Re-label any live session on that target so the change lands everywhere at once.
  for (const s of sessions) {
    if (s.target === target) applyIdentity(s, next);
  }
  notify();

  const [username, rest] = target.split('@');
  const at = rest.lastIndexOf(':');
  return saveProfile({
    id: target,
    username, host: rest.slice(0, at), port: Number(rest.slice(at + 1)) || 22,
    label: next.label ?? '',
    color: next.color ?? '',
    env: next.env ?? '',
    production: !!next.production,
  }).then(() => { notify(); });
}

/**
 * Pick a colour for a target. Stable per `user@host:port` so the same server is
 * the same colour tomorrow, but nudged off a colour another live session is
 * already using — two identical chips would defeat the entire point.
 */
function assignColor(target) {
  let hash = 0;
  for (const ch of target) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const taken = new Set(sessions.map((s) => s.color));
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = PALETTE[(hash + i) % PALETTE.length];
    if (!taken.has(candidate)) return candidate;
  }
  return PALETTE[hash % PALETTE.length];
}

/** `user@host` is the default; a duplicate gets " (2)" so two chips never read alike. */
function defaultLabel(meta) {
  const base = `${meta.username}@${meta.host}${Number(meta.port) === 22 ? '' : `:${meta.port}`}`;
  const clashes = sessions.filter((s) => s.label === base || s.label.startsWith(`${base} (`)).length;
  return clashes ? `${base} (${clashes + 1})` : base;
}

function applyIdentity(session, identity = {}) {
  if (identity.label) session.label = identity.label;
  session.env = identity.env || session.env || '';
  session.production = identity.production ?? (session.env === 'prod');
  if (session.production) session.color = PROD_COLOR;
  else if (identity.color) session.color = identity.color;
  if (session.workspace) {
    session.workspace.label = session.label;
    session.workspace.color = session.color;
    for (const win of session.workspace.windows.values()) {
      win.el.style.setProperty('--session-color', session.color);
      win.el.querySelector('.win__host').textContent = session.label;
    }
  }
}

/* ────────────────────────────────────────────────────────────── the list ── */

/** @type {Array} ordered exactly as the rail shows them. */
const sessions = [];
let activeId = null;
let seq = 0;

const listeners = new Set();
/** Anything that paints sessions (the rail, the top bar, the title) subscribes. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() { for (const fn of listeners) fn(); }

export const allSessions = () => sessions;
export const sessionCount = () => sessions.length;
export const activeSession = () => sessions.find((s) => s.id === activeId) || null;
export const sessionById = (id) => sessions.find((s) => s.id === id) || null;
export const sessionByToken = (token) => sessions.find((s) => s.token === token) || null;
export const indexOfSession = (session) => sessions.indexOf(session);
export const atFull = () => sessions.length >= MAX_PER_TAB;

/**
 * Build a session record from what /api/connect (or /api/sessions/validate)
 * returned. Nothing here touches the DOM; main.js gives it a workspace next.
 */
export function addSession(meta, { position = null } = {}) {
  const target = targetId(meta);
  const session = {
    id: `s${++seq}`,
    token: meta.token,
    api: createApi(meta.token),
    target,
    host: meta.host,
    port: Number(meta.port) || 22,
    username: meta.username,
    home: meta.home,
    connectedAt: meta.connectedAt || new Date().toISOString(),
    label: '',
    color: '',
    env: '',
    production: false,
    status: 'connected',      // connecting | connected | dropped
    dropReason: null,
    activity: false,          // background output since you last looked
    workspace: null,
    stopMonitor: null,
    iconsLoaded: false,
    lastActive: Date.now(),
  };
  session.label = defaultLabel(meta);
  session.color = assignColor(target);
  session.toast = (message, kind, ms) =>
    rawToast(session.id === activeId ? message : `${session.label}: ${message}`, kind, ms);

  applyIdentity(session, identityFor(target) || {});
  if (position == null || position >= sessions.length) sessions.push(session);
  else sessions.splice(position, 0, session);
  persist();
  return session;
}

export function removeSession(session) {
  const at = sessions.indexOf(session);
  if (at !== -1) sessions.splice(at, 1);
  if (activeId === session.id) activeId = null;
  persist();
}

export function setActive(session) {
  activeId = session ? session.id : null;
  if (session) {
    session.lastActive = Date.now();
    session.activity = false;
  }
  persist();
}

/** Most recently used session other than `except` — who gets focus after a disconnect. */
export function mostRecentOther(except) {
  return sessions.filter((s) => s !== except).sort((a, b) => b.lastActive - a.lastActive)[0] || null;
}

export function markDropped(session, reason = 'connection lost') {
  if (!session || session.status === 'dropped') return false;
  session.status = 'dropped';
  session.dropReason = reason;
  session.stopMonitor?.();
  session.stopMonitor = null;
  notify();
  return true;
}

export function markActivity(session) {
  if (!session || session.id === activeId || session.activity) return;
  session.activity = true;
  notify();
}

/* ─────────────────────────────────────────────────────── persistence ──── */

/**
 * Only what is needed to find the sessions again: tokens and identity. Window
 * layout is deliberately not persisted (spec F7) — a restored workspace opens
 * empty, which is honest about the fact that the PTYs behind those windows did
 * not survive either.
 */
function persist() {
  try {
    sessionStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.map((s) => ({
      token: s.token, label: s.label, color: s.color, env: s.env, production: s.production,
      host: s.host, port: s.port, username: s.username,
    }))));
    const active = activeSession();
    if (active) sessionStorage.setItem(ACTIVE_KEY, active.token);
    else sessionStorage.removeItem(ACTIVE_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch { /* private mode; the tab still works, it just will not restore */ }
}

/**
 * What the previous page load left behind, including the single `ssh-token` a
 * 0.1.0 tab would have written — upgrading must not look like the app forgot
 * where you were working.
 */
export function savedSessions() {
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(SESSIONS_KEY) || '[]'); } catch { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  saved = saved.filter((e) => e && typeof e.token === 'string');

  if (!saved.length) {
    const legacy = sessionStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) saved = [{ token: legacy, legacy: true }];
  }
  return { entries: saved, activeToken: sessionStorage.getItem(ACTIVE_KEY) || saved[0]?.token || null };
}

export function clearPersisted() {
  sessionStorage.removeItem(SESSIONS_KEY);
  sessionStorage.removeItem(ACTIVE_KEY);
  sessionStorage.removeItem(LEGACY_TOKEN_KEY);
}

/** Re-apply a saved label/colour to a session restored after a refresh. */
export function restoreIdentity(session, saved) {
  if (!saved) return;
  if (saved.label) session.label = saved.label;
  if (saved.env) session.env = saved.env;
  if (saved.production) session.production = true;
  if (saved.color) session.color = saved.color;
  if (session.production) session.color = PROD_COLOR;
  applyIdentity(session, {});
}

/* ────────────────────────────────────────────────── naming the host ────── */

/**
 * How a session is named in a destructive confirmation. Label *and*
 * `user@host`, never one or the other: the label is what you recognise, the
 * host is what you can check against the thing you believe you are doing.
 */
export const hostPhrase = (s) => `${s.label} (${s.username}@${s.host}${s.port === 22 ? '' : `:${s.port}`})`;

/**
 * The extra confirmDialog options a destructive action gets: the session colour
 * on the dialog edge, and — for a host the user marked production — a typed
 * host name before the button will enable. `typed` is set by the actions the
 * spec lists as irreversible enough to deserve it (stop/disable/mask, unit-file
 * save, delete), not by every confirm.
 */
export function dangerOpts(session, { typed = false } = {}) {
  return {
    accent: session.color,
    ...(typed && session.production
      ? { requireText: session.host, requireLabel: `Type the host name “${session.host}” to confirm` }
      : {}),
  };
}

/** The session an app window belongs to, captured once when the window opens. */
export function requireSession() {
  const session = activeSession();
  if (!session) throw new Error('No active connection.');
  return session;
}

/* ─────────────────────────────────────────────────────── liveness poll ─── */

/**
 * Ask the relay, in one request, which of *our* tokens are still live.
 *
 * This is the only way a background session's death is noticed when it has no
 * open WebSocket — an SSH connection killed at the far end leaves the browser
 * with nothing to observe. Ten seconds is well inside the 35s the spec allows
 * and is one small POST, so it costs less than the per-session /api/session
 * polling it replaces.
 */
const POLL_MS = 10_000;
let pollTimer = null;

export function startLivenessPoll(onDrop) {
  clearInterval(pollTimer);
  const sweep = async () => {
    const live = sessions.filter((s) => s.status !== 'dropped');
    if (!live.length) return;
    let answer;
    try {
      answer = await relayApi.validateSessions(live.map((s) => s.token));
    } catch {
      return;  // The relay itself is unreachable; a request-level 401 will tell us more.
    }
    for (const session of live) {
      if (!answer.sessions[session.token]) onDrop(session, 'connection lost');
    }
  };
  pollTimer = setInterval(sweep, POLL_MS);
  return () => clearInterval(pollTimer);
}

/** Used by the restore path: which of these tokens does the relay still know? */
export async function validateTokens(tokens) {
  if (!tokens.length) return {};
  try {
    const { sessions: live } = await relayApi.validateSessions(tokens);
    return live || {};
  } catch {
    return {};   // Relay restarted or unreachable: treat everything as gone.
  }
}
