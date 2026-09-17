/**
 * host-keys.js — trust on first use, then pin.
 *
 * Without a hostVerifier, ssh2 accepts whatever key the far end presents, so
 * anyone on the relay→server path could terminate the connection, collect the
 * password, and proxy the session on. This module gives the relay the same
 * posture as the OpenSSH client:
 *
 *   known key     → connect
 *   unknown key   → refuse, show the fingerprint, connect only when the user
 *                   explicitly trusts *that exact* fingerprint, then pin it
 *   changed key   → refuse, loudly, with no override in the browser
 *
 * Keys are looked up in two places: our own pin file, and the user's existing
 * ~/.ssh/known_hosts (plain and hashed entries), so a server you already reach
 * with `ssh` is not a "first use" all over again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

export function pinFilePath() {
  if (process.env.KNOWN_HOSTS_FILE) return process.env.KNOWN_HOSTS_FILE;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'su-ssh', 'known_hosts.json');
}

function sshKnownHostsPath() {
  return process.env.SSH_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts');
}

/** OpenSSH's names: bare host on port 22, "[host]:port" otherwise. */
export function hostId(host, port) {
  const h = String(host).toLowerCase();
  return Number(port) === 22 ? h : `[${h}]:${Number(port)}`;
}

/** The same string `ssh-keygen -lf` and the ssh client print. */
export function fingerprint(keyBlob) {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** A wire-format public key starts with its own type as an SSH string. */
export function keyType(keyBlob) {
  try {
    const len = keyBlob.readUInt32BE(0);
    return keyBlob.subarray(4, 4 + len).toString('ascii');
  } catch { return 'unknown'; }
}

/* -------------------------------------------------------------- pin file */

function loadPins() {
  try {
    const data = JSON.parse(fs.readFileSync(pinFilePath(), 'utf8'));
    return data && typeof data.hosts === 'object' ? data : { version: 1, hosts: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, hosts: {} };
    // A corrupt pin file must not quietly become "no pins": that would turn
    // every changed key into a first use. Fail closed and say where to look.
    throw new Error(`Cannot read the host key pin file at ${pinFilePath()}: ${err.message}`);
  }
}

function savePins(data) {
  const file = pinFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // Write-then-rename so a crash mid-write never leaves half a JSON file,
  // which loadPins would (rightly) refuse to read.
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
}

export function pinHostKey(host, port, keyBlob) {
  const data = loadPins();
  const id = hostId(host, port);
  const list = data.hosts[id] || [];
  list.push({ keyType: keyType(keyBlob), fingerprint: fingerprint(keyBlob), key: keyBlob.toString('base64'), addedAt: new Date().toISOString() });
  data.hosts[id] = list;
  savePins(data);
}

/** Remove every pin for host[:port]. Returns how many keys were dropped. */
export function forgetHost(host, port = 22) {
  const data = loadPins();
  const id = hostId(host, port);
  const count = (data.hosts[id] || []).length;
  delete data.hosts[id];
  if (count) savePins(data);
  return count;
}

/* ----------------------------------------------------- ~/.ssh/known_hosts */

/** Minimal glob: `*` and `?`, as known_hosts patterns use. */
function globMatch(pattern, value) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(value);
}

/**
 * Does one comma-separated host field name this host id? Hashed entries are
 * `|1|base64(salt)|base64(HMAC-SHA1(salt, id))`, so checking one is a single
 * HMAC. A negated pattern that matches vetoes the whole line.
 */
function hostFieldMatches(field, id) {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(id).digest('base64') === hash;
  }
  let matched = false;
  for (const pattern of field.split(',')) {
    const negated = pattern.startsWith('!');
    const p = (negated ? pattern.slice(1) : pattern).toLowerCase();
    if (globMatch(p, id)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

function knownHostsEntries(id) {
  let text;
  try { text = fs.readFileSync(sshKnownHostsPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = trimmed.split(/\s+/);
    let marker = null;
    if (cols[0].startsWith('@')) marker = cols.shift();
    if (marker === '@cert-authority') continue; // certificates are not supported here
    const [hosts, type, key] = cols;
    if (!key || !hostFieldMatches(hosts, id)) continue;
    out.push({ marker, keyType: type, key });
  }
  return out;
}

/* ---------------------------------------------------------------- verdict */

/**
 * Classify the key a server presented.
 * Returns { status: 'trusted' | 'unknown' | 'changed' | 'revoked', ... }.
 */
export function checkHostKey(host, port, keyBlob) {
  const id = hostId(host, port);
  const presented = keyBlob.toString('base64');
  const type = keyType(keyBlob);
  const info = { host, port: Number(port), id, keyType: type, fingerprint: fingerprint(keyBlob) };

  const system = knownHostsEntries(id);
  if (system.some((e) => e.marker === '@revoked' && e.key === presented)) {
    return { ...info, status: 'revoked', source: sshKnownHostsPath() };
  }

  const pins = loadPins().hosts[id] || [];
  if (pins.some((p) => p.key === presented)) return { ...info, status: 'trusted', source: 'pin' };
  if (system.some((e) => !e.marker && e.key === presented)) return { ...info, status: 'trusted', source: 'known_hosts' };

  // Any pin at all for this host means we have met it before. OpenSSH treats a
  // same-type mismatch as a change; we also treat a *different* type as one,
  // because "the server suddenly offers a key type we never saw" is exactly
  // what a MITM without the real key would present.
  if (pins.length) {
    return { ...info, status: 'changed', source: pinFilePath(), expected: pins.map((p) => ({ keyType: p.keyType, fingerprint: p.fingerprint })) };
  }
  const sameType = system.filter((e) => !e.marker && e.keyType === type);
  if (sameType.length) {
    return {
      ...info, status: 'changed', source: sshKnownHostsPath(),
      expected: sameType.map((e) => ({ keyType: e.keyType, fingerprint: fingerprint(Buffer.from(e.key, 'base64')) })),
    };
  }
  return { ...info, status: 'unknown' };
}
