/**
 * profiles.js — the browser's view of what the *relay* remembers.
 *
 * All of this used to be `localStorage`, which is per browser, per profile and
 * per machine. Configure a server in Chrome, open Firefox, and the app had
 * never heard of it. The relay process is the one thing both browsers talk to,
 * so the list of servers, their labels and colours, their saved tunnels and
 * their saved window layout now live in a file on the relay host
 * (`~/.config/su-ssh/profiles.json`) and every browser sees the same one.
 *
 * Still not stored, here or there: passwords, private keys, passphrases. The
 * relay enforces that with an allowlist on the way to disk (server/profiles.js);
 * this module simply never has them to send.
 *
 * A small in-memory cache backs the synchronous reads the greeter and the rail
 * do while painting. It is filled once at boot, refreshed after every write and
 * after every connect, and listeners are told when it changes.
 */

import { relayApi } from './api.js';

/** @type {Map<string, object>} id → profile, as the relay last reported it. */
const cache = new Map();
let loaded = false;
let storeFile = '';

const listeners = new Set();
export function onProfilesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function announce() { for (const fn of listeners) { try { fn(); } catch { /* one painter must not stop the rest */ } } }

function absorb(list) {
  cache.clear();
  for (const p of list || []) if (p?.id) cache.set(p.id, p);
  announce();
}

/** Put one profile the relay just returned back into the cache. */
export function absorbProfile(profile) {
  if (!profile?.id) return profile;
  cache.set(profile.id, profile);
  announce();
  return profile;
}

/* ─────────────────────────────────────────────────────────── reading ──── */

export const profilesLoaded = () => loaded;
export const profileStoreFile = () => storeFile;

/** Every profile, pinned first then most recent — the order the relay sorts in. */
export const allProfiles = () => [...cache.values()];

/** One profile by `user@host:port`, or null. Synchronous: reads the cache. */
export const profileFor = (id) => cache.get(id) || null;

/**
 * The identity half — label, colour, environment — of a profile, in the shape
 * sessions.js has always used. Null when the user has never named this server.
 */
export function identityOf(id) {
  const p = cache.get(id);
  if (!p) return null;
  if (!p.label && !p.color && !p.env && !p.production) return null;
  return { label: p.label || '', color: p.color || '', env: p.env || '', production: !!p.production };
}

export async function loadProfiles() {
  const { profiles, file } = await relayApi.profiles();
  storeFile = file || '';
  loaded = true;
  absorb(profiles);
  return allProfiles();
}

/* ─────────────────────────────────────────────────────────── writing ──── */

/**
 * Create or update a profile. `patch` either names an existing one by `id`, or
 * carries `username`/`host`/`port` for one that may not exist yet. Never send a
 * credential through here; the relay would drop it, but do not make it have to.
 */
export async function saveProfile(patch) {
  const { profile } = await relayApi.updateProfile(patch);
  return absorbProfile(profile);
}

export async function forgetProfile(id) {
  await relayApi.forgetProfile({ id });
  cache.delete(id);
  announce();
}

export async function forgetUnpinnedProfiles() {
  await relayApi.forgetProfile({ unpinned: true });
  await loadProfiles();
}

export async function forgetSavedForward(id, key) {
  const { profile } = await relayApi.forgetSavedForward({ id, key });
  return absorbProfile(profile);
}

/**
 * Identity of a saved forward: what it binds and where it goes, not what it is
 * called. Must match server/profiles.js's forwardKey exactly — it is how the
 * "forget this one" button names the row it is pointing at.
 */
export function forwardKeyOf(spec) {
  return [spec.kind, spec.bindAddr ?? '', spec.bindPort ?? '', spec.remoteAddr ?? '',
    spec.remotePort ?? '', spec.destHost ?? '', spec.destPort ?? ''].join('|');
}

/* ───────────────────────────────────────────── the one-time migration ──── */

const LEGACY = {
  recents: 'ssh-recent-targets',
  lastTarget: 'ssh-last-target',
  identity: 'ssh-host-identity',
  done: 'ssh-profiles-migrated',
};

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) || '') ?? fallback; } catch { return fallback; }
};

/**
 * Hand whatever this browser still has in localStorage to the relay, once, and
 * then stop using localStorage for it.
 *
 * The relay merges rather than overwrites, so a second browser arriving later
 * with its own stale copy cannot undo what the first one set up. The keys are
 * removed only after the relay has acknowledged the import: a failed migration
 * that had already deleted the source would be the one bug this whole change
 * exists to prevent.
 */
export async function migrateLocalStorage() {
  const recents = readJson(LEGACY.recents, null);
  const identities = readJson(LEGACY.identity, null);
  const legacyOne = readJson(LEGACY.lastTarget, null);

  const list = Array.isArray(recents) ? recents.filter((e) => e?.host && e?.username) : [];
  if (!list.length && legacyOne?.host && legacyOne?.username) list.push({ ...legacyOne, count: 0 });

  if (!list.length && (!identities || !Object.keys(identities).length)) {
    try { localStorage.setItem(LEGACY.done, '1'); } catch { /* private mode */ }
    return 0;
  }

  const { imported, profiles } = await relayApi.migrateProfiles({ recents: list, identities: identities || {} });
  absorb(profiles);
  storeFile = storeFile || '';
  loaded = true;
  for (const key of [LEGACY.recents, LEGACY.lastTarget, LEGACY.identity]) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
  try { localStorage.setItem(LEGACY.done, '1'); } catch { /* private mode */ }
  return imported;
}
