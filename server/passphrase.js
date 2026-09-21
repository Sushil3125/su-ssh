/**
 * passphrase.js — the relay's one persistent secret, stored so it cannot leak.
 *
 * The owner chooses a passphrase once; every browser proves it knows it to get
 * an access cookie. What lands on disk, in ~/.config/su-ssh/auth.json:
 *
 *   {
 *     "version": 1,
 *     "passphrase": { "kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "keylen": 32,
 *                     "salt": "<base64, 16 bytes>", "hash": "<base64>", "setAt": "…" },
 *     "cookieKey": "<base64, 32 random bytes>"
 *   }
 *
 * Never the passphrase itself, and nothing reversible to it: a salted scrypt
 * output is only useful to someone willing to guess passphrases at 128 MiB and
 * a few hundred milliseconds per guess. The parameters travel with the hash, so
 * they can be raised later without invalidating what is stored — a successful
 * unlock under older, weaker parameters quietly re-hashes.
 *
 * `cookieKey` signs access cookies (see AccessGate in security.js). It is
 * random and unrelated to the passphrase, and it is persisted so a restart or
 * reboot does not log anybody out. Changing the passphrase rotates it, which
 * is what logs every other browser out. Deleting the file (su-ssh
 * --reset-passphrase) drops both, so the next visit shows setup again.
 *
 * Same conventions as profiles.js and host-keys.js: XDG_CONFIG_HOME honoured,
 * 0700 directory, 0600 file, write-then-rename, a corrupt file is an error and
 * never "no passphrase" (that would hand setup to whoever arrives first), and
 * an env override (SU_SSH_AUTH_FILE) so tests never touch the real one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 1024;

/**
 * OWASP's current scrypt recommendation (N=2^17, r=8, p=1): 128 MiB and about
 * a third of a second per guess on a laptop. Hashes are computed one at a time
 * (see `queue` below) so a burst of attempts costs time, not gigabytes.
 */
export const DEFAULT_PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 32 });

export function authFilePath() {
  if (process.env.SU_SSH_AUTH_FILE) return process.env.SU_SSH_AUTH_FILE;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'su-ssh', 'auth.json');
}

/* ------------------------------------------------------------------ hashing */

let queue = Promise.resolve();

function scrypt(secret, salt, { N, r, p, keylen }) {
  const run = () => new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r, or node refuses the parameters outright.
    scryptCb(secret, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/**
 * The same passphrase must match whichever keyboard or OS typed it: "é" can
 * arrive precomposed or as e + combining accent. NFC folds them together.
 * Nothing else is altered — no trimming, no case folding.
 */
export function normalise(passphrase) {
  return String(passphrase).normalize('NFC');
}

/** Returns null if acceptable, otherwise the reason. No character-class rules. */
export function checkStrength(passphrase) {
  if (typeof passphrase !== 'string') return 'Enter a passphrase.';
  const length = [...normalise(passphrase)].length;
  if (length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. Anything goes — words, spaces, symbols — it just has to be long enough that guessing it is slow.`;
  if (length > MAX_LENGTH) return `That is longer than ${MAX_LENGTH} characters; pick something shorter.`;
  return null;
}

export async function hashPassphrase(passphrase, params = DEFAULT_PARAMS) {
  const salt = randomBytes(16);
  const hash = await scrypt(normalise(passphrase), salt, params);
  return {
    kdf: 'scrypt', N: params.N, r: params.r, p: params.p, keylen: params.keylen,
    salt: salt.toString('base64'), hash: hash.toString('base64'), setAt: new Date().toISOString(),
  };
}

export async function verifyPassphrase(record, candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.length > MAX_LENGTH * 4) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scrypt(normalise(candidate), Buffer.from(record.salt, 'base64'), record);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isOutdated(record) {
  return record.N < DEFAULT_PARAMS.N || record.r < DEFAULT_PARAMS.r || record.p < DEFAULT_PARAMS.p || record.keylen < DEFAULT_PARAMS.keylen;
}

/* --------------------------------------------------------------------- file */

function corrupt(file, why) {
  return new Error(`The passphrase file at ${file} is unreadable (${why}). Fix or delete it — `
    + '`su-ssh --reset-passphrase` removes it, and the next visit from this machine chooses a new passphrase.');
}

function validate(data, file) {
  if (!data || typeof data !== 'object' || data.version !== 1) throw corrupt(file, 'unknown format');
  const key = typeof data.cookieKey === 'string' ? Buffer.from(data.cookieKey, 'base64') : null;
  if (!key || key.length < 32) throw corrupt(file, 'missing cookie key');
  const p = data.passphrase;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!p || p.kdf !== 'scrypt' || !int(p.N, 2 ** 10, 2 ** 20) || (p.N & (p.N - 1)) !== 0
    || !int(p.r, 1, 32) || !int(p.p, 1, 16) || !int(p.keylen, 16, 128)
    || typeof p.salt !== 'string' || typeof p.hash !== 'string' || Buffer.from(p.hash, 'base64').length !== p.keylen) {
    throw corrupt(file, 'bad passphrase record');
  }
  return { passphrase: p, cookieKey: key };
}

/**
 * Read the file, or return null when no passphrase has been chosen yet.
 * Cached on (inode, mtime, size), so `--reset-passphrase` run while the relay
 * is up takes effect on the very next request without a restart.
 */
let cache = { sig: null, value: null };

export function loadAuth() {
  const file = authFilePath();
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (err.code === 'ENOENT') { cache = { sig: null, value: null }; return null; }
    throw corrupt(file, err.code || err.message);
  }
  const sig = `${st.ino}:${st.mtimeMs}:${st.size}`;
  if (cache.sig === sig) return cache.value;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw corrupt(file, err.message); }
  cache = { sig, value: validate(data, file) };
  return cache.value;
}

function saveAuth(passphrase, cookieKey) {
  const file = authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const data = { version: 1, passphrase, cookieKey: cookieKey.toString('base64') };
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
  cache = { sig: null, value: null };
  return loadAuth();
}

/** First run. Fails if a passphrase already exists (checked after hashing, too). */
export async function setPassphrase(passphrase) {
  const record = await hashPassphrase(passphrase);
  if (loadAuth()) throw Object.assign(new Error('A passphrase is already set.'), { code: 'ALREADY_SET' });
  return saveAuth(record, randomBytes(32));
}

/** Change: new hash, new cookie key — every existing cookie stops verifying. */
export async function changePassphrase(passphrase) {
  return saveAuth(await hashPassphrase(passphrase), randomBytes(32));
}

/** Upgrade the stored hash's parameters without logging anybody out. */
export async function rehash(passphrase) {
  const current = loadAuth();
  if (!current) return null;
  return saveAuth(await hashPassphrase(passphrase), current.cookieKey);
}

/** `su-ssh --reset-passphrase`. Returns true if there was something to remove. */
export function resetPassphrase() {
  try { fs.unlinkSync(authFilePath()); cache = { sig: null, value: null }; return true; } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
