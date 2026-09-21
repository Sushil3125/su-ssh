/**
 * profiles.js — what the relay remembers about the servers you connect to.
 *
 * Everything the desktop used to keep in one browser's `localStorage` lives
 * here instead, in a file on the relay host. The relay process is the one thing
 * two browsers on the same machine share, so it is the only place "I set this
 * up in Chrome and it was gone in Firefox" can be fixed. A file, not memory, so
 * a relay restart or a reboot does not lose it either.
 *
 * A profile is keyed by `username@host:port` — the same string the browser
 * calls a target — and holds:
 *
 *   where and as whom      host, port, username, authMethod
 *   how you recognise it   label, color, env, production, pinned
 *   how often              count, lastConnected
 *   what to re-open        forwards[], layout, restore ('ask' | 'yes' | 'no')
 *
 * What it never holds is a password, a private key, a key passphrase or a sudo
 * password. That is not a convention here, it is enforced: every write goes
 * through sanitise(), which builds the stored object from an allowlist of
 * fields and copies nothing else, so a client that posts `{password: 'hunter2'}`
 * has it dropped on the floor rather than written to disk. The same rule the
 * recents list has always had — remember where you go, never how you prove it.
 *
 * File handling follows host-keys.js exactly: ~/.config/su-ssh (honouring
 * XDG_CONFIG_HOME), 0700 on the directory, 0600 on the file, write-then-rename
 * so a crash mid-write cannot leave half a JSON document, and a corrupt file is
 * an error that says where to look rather than a silent "you have no profiles"
 * that would quietly throw away everything the user configured.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpError } from './ssh-session.js';

/**
 * Tests (and anyone who wants a second, throwaway store) point
 * SU_SSH_PROFILES_FILE somewhere else. Same escape hatch as KNOWN_HOSTS_FILE.
 */
export function profileFilePath() {
  if (process.env.SU_SSH_PROFILES_FILE) return process.env.SU_SSH_PROFILES_FILE;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'su-ssh', 'profiles.json');
}

/** Ceilings, so a misbehaving or malicious client cannot grow the file forever. */
const MAX_PROFILES = 200;
const MAX_UNPINNED = 24;
const MAX_FORWARDS = 20;
const MAX_WINDOWS = 10;
const MAX_STR = 200;

const RESTORE_MODES = new Set(['ask', 'yes', 'no']);

/* ------------------------------------------------------------- scrubbing */

const str = (v, max = MAX_STR) => (typeof v === 'string' ? v.slice(0, max) : '');
const bool = (v) => v === true;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** ISO-8601 or nothing. Never a free-form string we would later print. */
function iso(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The profile key. Built from parts we have parsed ourselves, never taken from
 * the client verbatim: this string ends up as an object key and in log lines,
 * and `../../` in a username is not something to find out about later.
 */
export function profileId({ username, host, port }) {
  const u = str(username, 64).replace(/[^A-Za-z0-9._\-$]/g, '');
  const h = str(host, 255).toLowerCase().replace(/[^a-z0-9._:[\]-]/g, '');
  const p = num(port, 22) || 22;
  if (!u || !h) throw new HttpError(400, 'A connection profile needs a username and a host.');
  if (p < 1 || p > 65535) throw new HttpError(400, 'Port must be between 1 and 65535.');
  return `${u}@${h}:${p}`;
}

/** Accept an id the client sends back, by re-deriving it from its own parts. */
export function parseProfileId(value) {
  const m = /^([^@\s]{1,64})@([^:\s]{1,255}):(\d{1,5})$/.exec(String(value || ''));
  if (!m) throw new HttpError(400, 'That is not a connection profile id.');
  return profileId({ username: m[1], host: m[2], port: Number(m[3]) });
}

const AUTH_METHODS = new Set(['password', 'key', 'keyfile', 'agent']);
const FORWARD_KINDS = new Set(['local', 'remote', 'dynamic']);

/**
 * One saved forward, reduced to the fields port-forward.js's normaliseForward
 * actually reads. Deliberately not the live Forward's toJSON: traffic counters,
 * ids and statuses belong to a run, not to the intention we are remembering.
 */
export function sanitiseForward(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = str(input.kind, 16);
  if (!FORWARD_KINDS.has(kind)) return null;
  const spec = { kind, label: str(input.label, 60) };
  if (kind === 'local' || kind === 'dynamic') {
    spec.bindAddr = str(input.bindAddr, 255) || '127.0.0.1';
    spec.bindPort = num(input.bindPort, 0);
  }
  if (kind === 'local' || kind === 'remote') {
    spec.destHost = str(input.destHost, 255);
    spec.destPort = num(input.destPort, 0);
    if (!spec.destHost || spec.destPort < 1) return null;
  }
  if (kind === 'remote') {
    spec.remoteAddr = str(input.remoteAddr, 255);
    spec.remotePort = num(input.remotePort, 0);
  }
  return spec;
}

/**
 * Two saved forwards are "the same" when they would bind and reach the same
 * places. The name is not part of it — renaming a tunnel must not give you two.
 */
export function forwardKey(spec) {
  return [spec.kind, spec.bindAddr ?? '', spec.bindPort ?? '', spec.remoteAddr ?? '',
    spec.remotePort ?? '', spec.destHost ?? '', spec.destPort ?? ''].join('|');
}

/** One remembered window. The same shape restore.js has always written. */
function sanitiseWindow(input) {
  if (!input || typeof input !== 'object') return null;
  const app = str(input.app, 32);
  if (!/^[a-z]{1,32}$/.test(app)) return null;
  const g = input.geo && typeof input.geo === 'object' ? input.geo : {};
  return {
    app,
    // The few values that say what a window was *showing*. No file contents, no
    // scrollback, no command output — a stale copy is worse than no copy.
    ...(input.path !== undefined ? { path: str(input.path, 4096) || null } : {}),
    ...(input.cwd !== undefined ? { cwd: str(input.cwd, 4096) || null } : {}),
    ...(input.unit !== undefined ? { unit: str(input.unit, 255) || null } : {}),
    ...(input.scope !== undefined ? { scope: input.scope === 'user' ? 'user' : 'system' } : {}),
    ...(input.tab !== undefined ? { tab: str(input.tab, 32) || null } : {}),
    // Which renderer a Viewer window was using (image, markdown, hex, …).
    ...(input.mode !== undefined ? { mode: /^[a-z]{1,16}$/.test(str(input.mode, 16)) ? str(input.mode, 16) : null } : {}),
    geo: {
      left: num(g.left, 0), top: num(g.top, 0),
      width: num(g.width, 720), height: num(g.height, 460),
      max: bool(g.max), min: bool(g.min), z: num(g.z, 100),
    },
  };
}

function sanitiseLayout(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.windows)) return null;
  const windows = input.windows.map(sanitiseWindow).filter(Boolean).slice(0, MAX_WINDOWS);
  return { windows, savedAt: num(input.savedAt, Date.now()) };
}

/**
 * Build the object that is actually written. An allowlist, not a denylist:
 * anything the client sends that is not named here — `password`, `privateKey`,
 * `passphrase`, a sudo password, a token — simply does not survive this
 * function, and there is no path to the file that does not go through it.
 */
function sanitise(input, previous = null) {
  const base = previous || {};
  const id = profileId({
    username: input.username ?? base.username,
    host: input.host ?? base.host,
    port: input.port ?? base.port,
  });
  const [, username, host, port] = /^(.+)@(.+):(\d+)$/.exec(id);

  const authMethod = AUTH_METHODS.has(str(input.authMethod)) ? str(input.authMethod)
    : (AUTH_METHODS.has(base.authMethod) ? base.authMethod : 'password');

  const color = /^#[0-9a-f]{6}$/i.test(str(input.color, 7)) ? str(input.color, 7) : (base.color || '');
  const env = str(input.env, 32).toLowerCase().replace(/[^a-z0-9-]/g, '');

  const out = {
    id,
    host,
    port: Number(port),
    username,
    authMethod,
    label: input.label !== undefined ? str(input.label, 80) : (base.label || ''),
    color: input.color !== undefined ? color : (base.color || ''),
    env: input.env !== undefined ? env : (base.env || ''),
    production: input.production !== undefined
      ? bool(input.production)
      : (base.production === true),
    pinned: input.pinned !== undefined ? bool(input.pinned) : (base.pinned === true),
    count: input.count !== undefined ? Math.max(0, Math.trunc(num(input.count, 0))) : Math.max(0, Math.trunc(num(base.count, 0))),
    lastConnected: input.lastConnected !== undefined ? iso(input.lastConnected) : (iso(base.lastConnected) || null),
    restore: RESTORE_MODES.has(str(input.restore)) ? str(input.restore)
      : (RESTORE_MODES.has(base.restore) ? base.restore : 'ask'),
    forwards: [],
    layout: null,
  };
  // "prod" is not a label you can wear without the red treatment; keep the two
  // in step here as well as in the browser, so a second browser agrees.
  if (out.env === 'prod') out.production = true;

  const rawForwards = input.forwards !== undefined ? input.forwards : base.forwards;
  if (Array.isArray(rawForwards)) {
    const seen = new Set();
    for (const f of rawForwards) {
      const spec = sanitiseForward(f);
      if (!spec) continue;
      const key = forwardKey(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.forwards.push(spec);
      if (out.forwards.length >= MAX_FORWARDS) break;
    }
  }

  const rawLayout = input.layout !== undefined ? input.layout : base.layout;
  out.layout = sanitiseLayout(rawLayout);

  return out;
}

/* ------------------------------------------------------------- the file */

function emptyStore() { return { version: 1, profiles: {} }; }

function load() {
  let text;
  try {
    text = fs.readFileSync(profileFilePath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw new Error(`Cannot read the connection profile file at ${profileFilePath()}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // Silently starting over would throw away every label, pin and saved
    // forward the user configured. Say what is wrong and where it is instead.
    throw new Error(
      `The connection profile file at ${profileFilePath()} is not valid JSON (${err.message}). `
      + 'Move it aside to start fresh; nothing else in su-ssh depends on it.',
    );
  }
  if (!data || typeof data !== 'object' || typeof data.profiles !== 'object' || data.profiles === null) {
    throw new Error(`The connection profile file at ${profileFilePath()} is not in the expected format.`);
  }
  return data;
}

function save(data) {
  const file = profileFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
}

/**
 * Keep the file bounded the way the browser list always was: pinned profiles
 * live forever, the rest are a rolling window of the most recent.
 */
function prune(data) {
  const all = Object.values(data.profiles);
  const pinned = all.filter((p) => p.pinned);
  // Never seen a connection yet (a forward saved before the first connect)
  // sorts as "just now", not as "never": it is the newest thing here.
  const recency = (p) => String(p.lastConnected || '9999');
  const unpinned = all.filter((p) => !p.pinned).sort((a, b) => recency(b).localeCompare(recency(a)));
  const limit = Math.max(0, Math.min(MAX_UNPINNED, MAX_PROFILES - pinned.length));
  for (const stale of unpinned.slice(limit)) delete data.profiles[stale.id];
  return data;
}

/* -------------------------------------------------------------- read API */

export function listProfiles() {
  const data = load();
  return Object.values(data.profiles)
    .map((p) => sanitise(p, p))
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
      || String(b.lastConnected || '').localeCompare(String(a.lastConnected || '')));
}

export function getProfile(id) {
  const data = load();
  const found = data.profiles[id];
  return found ? sanitise(found, found) : null;
}

/** The profile a live session belongs to, or null. Never creates one. */
export function profileForSession(session) {
  try {
    return getProfile(profileId(session.meta));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- write API */

/**
 * Read–modify–write under one load/save. Two browsers editing two different
 * profiles is the common case and is safe; two editing the *same* profile in
 * the same second is last-writer-wins, which for a label or a pin is the right
 * trade against the complexity of a lock file.
 */
function mutate(fn) {
  const data = load();
  const result = fn(data);
  prune(data);
  save(data);
  return result;
}

/** Create or update one profile from a patch. Returns the stored profile. */
export function upsertProfile(patch) {
  return mutate((data) => {
    const id = profileId({
      username: patch.username,
      host: patch.host,
      port: patch.port,
    });
    const next = sanitise({ ...patch, id }, data.profiles[id] || null);
    data.profiles[id] = next;
    return next;
  });
}

/** Apply a patch to an existing profile, identified by its id alone. */
export function patchProfile(id, patch) {
  return mutate((data) => {
    const existing = data.profiles[id];
    if (!existing) throw new HttpError(404, 'There is no saved connection profile for that server.');
    const next = sanitise({ ...patch, username: existing.username, host: existing.host, port: existing.port }, existing);
    data.profiles[id] = next;
    return next;
  });
}

/** Record a successful connection: bump the counter, stamp the time. */
export function noteConnected({ username, host, port, authMethod }) {
  return mutate((data) => {
    const id = profileId({ username, host, port });
    const existing = data.profiles[id] || null;
    const next = sanitise({
      username, host, port, authMethod,
      count: Math.max(0, Math.trunc(num(existing?.count, 0))) + 1,
      lastConnected: new Date().toISOString(),
    }, existing);
    data.profiles[id] = next;
    return next;
  });
}

/**
 * Remember (or forget) a forward against a profile. Called from the forward
 * routes themselves, so opening a tunnel is all it takes for it to come back
 * next time — there is no second thing the user has to remember to press.
 *
 * A profile that does not exist yet is created: you can perfectly well open a
 * forward on a host you have not yet labelled.
 */
export function rememberForward({ username, host, port }, spec) {
  const clean = sanitiseForward(spec);
  if (!clean) return null;
  return mutate((data) => {
    const id = profileId({ username, host, port });
    const existing = data.profiles[id] || null;
    const forwards = (existing?.forwards || []).filter((f) => forwardKey(f) !== forwardKey(clean));
    forwards.unshift(clean);
    const next = sanitise({ username, host, port, forwards: forwards.slice(0, MAX_FORWARDS) }, existing);
    data.profiles[id] = next;
    return next;
  });
}

export function forgetForward(id, key) {
  return mutate((data) => {
    const existing = data.profiles[id];
    if (!existing) throw new HttpError(404, 'There is no saved connection profile for that server.');
    const forwards = (existing.forwards || []).filter((f) => forwardKey(f) !== String(key));
    const next = sanitise({ forwards, username: existing.username, host: existing.host, port: existing.port }, existing);
    data.profiles[id] = next;
    return next;
  });
}

export function forgetProfile(id) {
  return mutate((data) => {
    const had = Boolean(data.profiles[id]);
    delete data.profiles[id];
    return had;
  });
}

/** The greeter's "clear unpinned" button. Pinned servers are kept. */
export function forgetUnpinned() {
  return mutate((data) => {
    let dropped = 0;
    for (const p of Object.values(data.profiles)) {
      if (!p.pinned) { delete data.profiles[p.id]; dropped += 1; }
    }
    return dropped;
  });
}

/**
 * One-time import of whatever a browser still has in localStorage.
 *
 * Merged, never overwriting: a second browser that arrives with its own stale
 * recents must not clobber what is already on the relay. Existing profiles keep
 * their fields; only missing ones are filled in, and the highest connection
 * count and most recent timestamp win.
 */
export function migrate({ recents = [], identities = {} } = {}) {
  return mutate((data) => {
    let imported = 0;
    for (const entry of Array.isArray(recents) ? recents.slice(0, MAX_PROFILES) : []) {
      let id;
      try { id = profileId(entry); } catch { continue; }
      const existing = data.profiles[id] || null;
      const identity = (identities && typeof identities === 'object' ? identities[id] : null) || {};
      const merged = {
        username: entry.username, host: entry.host, port: entry.port,
        authMethod: existing?.authMethod || entry.authMethod,
        label: existing?.label || identity.label,
        color: existing?.color || identity.color,
        env: existing?.env || identity.env,
        production: existing?.production || identity.production,
        pinned: existing?.pinned || entry.pinned === true,
        count: Math.max(num(existing?.count, 0), num(entry.count, 0)),
        lastConnected: [iso(existing?.lastConnected), iso(entry.lastConnected)]
          .filter(Boolean).sort().pop() || null,
      };
      data.profiles[id] = sanitise(merged, existing);
      imported += 1;
    }
    // Identities for targets that never made it into the recents list still
    // describe a server the user named, so they are worth keeping.
    for (const [rawId, identity] of Object.entries(identities || {}).slice(0, MAX_PROFILES)) {
      let id;
      try { id = parseProfileId(rawId); } catch { continue; }
      if (data.profiles[id]) continue;
      const m = /^(.+)@(.+):(\d+)$/.exec(id);
      data.profiles[id] = sanitise({
        username: m[1], host: m[2], port: Number(m[3]),
        label: identity?.label, color: identity?.color, env: identity?.env,
        production: identity?.production,
      }, null);
      imported += 1;
    }
    return imported;
  });
}
