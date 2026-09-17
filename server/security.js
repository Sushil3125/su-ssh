/**
 * security.js — who may talk to this relay, and how often they may try.
 *
 * Two separate threats live here.
 *
 * 1. DNS rebinding and cross-site requests. The relay is a web server on
 *    localhost that can authenticate with the user's ssh-agent. Any page the
 *    user visits can point its own hostname at 127.0.0.1 after load; from then
 *    on the browser treats the relay as same-origin with that page, and the
 *    attacker can POST /api/connect with authMethod=agent. Browsers also do not
 *    apply CORS to WebSocket handshakes at all. What the attacker cannot change
 *    is the Host header (it still says their domain) or the Origin header (it
 *    still says their site). So both are checked against an allowlist.
 *
 * 2. Brute force. /api/connect is an oracle against the target's sshd, so it is
 *    throttled per client address, with a backoff that grows on each
 *    authentication failure.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/* ============================================================ host allowlist */

/**
 * Parse "name", "name:port", "[v6]" or "[v6]:port" into { name, port }.
 * A trailing dot is dropped, because "localhost." resolves the same as
 * "localhost" and must not be a way around the list.
 */
export function parseHostPort(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  let name, port = null;
  const v6 = raw.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/);
  if (v6) {
    name = `[${v6[1]}]`;
    port = v6[2] ?? null;
  } else {
    const parts = raw.match(/^([^:\s/@]+)(?::(\d+))?$/);
    if (!parts) return null;
    name = parts[1];
    port = parts[2] ?? null;
  }
  name = name.replace(/\.$/, '');
  return { name, port: port === null ? null : Number(port) };
}

/**
 * Build the allowlist from the listening port, the bind address and any extra
 * names the operator supplied (comma or space separated).
 *
 * Defaults carry the listening port. User-supplied entries without a port match
 * that name on any port: behind a reverse proxy the Host header usually has no
 * port, or the proxy's port, and the rebinding attack is defeated by the *name*
 * alone — an attacker cannot make the browser send Host: localhost.
 */
export function buildAllowlist({ port, bind, extra = '' }) {
  const entries = [];
  const add = (name, p) => {
    const parsed = parseHostPort(p == null ? name : `${name}:${p}`);
    if (parsed && !entries.some((e) => e.name === parsed.name && e.port === parsed.port)) entries.push(parsed);
  };

  for (const name of ['localhost', '127.0.0.1', '[::1]']) add(name, port);

  // A wildcard bind is not a name anyone can type into a browser, so it adds
  // nothing; reaching the relay by its LAN address then needs --allowed-host.
  if (bind && !['0.0.0.0', '::', '[::]'].includes(bind)) {
    add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind, port);
  }

  for (const item of String(extra).split(/[\s,]+/).filter(Boolean)) {
    const parsed = parseHostPort(item);
    if (!parsed) throw new Error(`Invalid allowed host "${item}". Use a hostname or IP, optionally with :port.`);
    add(parsed.name, parsed.port);
  }
  return entries;
}

const describe = (e) => (e.port == null ? e.name : `${e.name}:${e.port}`);

export function describeAllowlist(list) {
  return list.map(describe).join(', ');
}

function isAllowed(list, value) {
  const parsed = parseHostPort(value);
  if (!parsed) return false;
  return list.some((e) => e.name === parsed.name && (e.port == null || e.port === parsed.port));
}

/**
 * Decide whether one request may proceed. Returns null when it may, or the
 * human-readable reason it may not.
 *
 * `checkOrigin` is set for WebSocket upgrades and for anything that is not a
 * GET/HEAD. A missing Origin is accepted: curl and other non-browser clients
 * do not send one, and they are not the confused deputy this defends against —
 * every browser attaches Origin to cross-origin POSTs and to WS handshakes.
 * The literal "null" origin (sandboxed iframes, file://) is refused.
 */
export function checkRequestOrigin(list, { host, origin }, { checkOrigin }) {
  if (!host || !isAllowed(list, host)) {
    return `Refused: this relay does not answer to the host name "${host || '(none)'}". `
      + `Allowed: ${describeAllowlist(list)}. If you reach it through a reverse proxy or another `
      + `name, start it with --allowed-host <name> (or ALLOWED_HOSTS). This check blocks DNS-rebinding attacks.`;
  }
  if (checkOrigin && origin !== undefined) {
    let originHost = null;
    try { originHost = origin === 'null' ? null : new URL(origin).host; } catch { originHost = null; }
    if (!originHost || !isAllowed(list, originHost)) {
      return `Refused: cross-site request from origin "${origin}". Only pages served by this relay `
        + `(${describeAllowlist(list)}) may use it.`;
    }
  }
  return null;
}

/** Express middleware wrapping checkRequestOrigin. */
export function hostGuard(list) {
  return (req, res, next) => {
    const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const problem = checkRequestOrigin(list, { host: req.headers.host, origin: req.headers.origin }, { checkOrigin: stateChanging });
    if (!problem) return next();
    console.warn(`[guard] ${req.method} ${req.path} host=${req.headers.host} origin=${req.headers.origin ?? '-'}`);
    res.status(403).type('application/json').send(JSON.stringify({ error: problem, code: 'FORBIDDEN_HOST' }));
  };
}

/* ============================================================= rate limiting */

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;          // per address per window, whatever the outcome
const FREE_FAILURES = 3;          // auth failures before backoff starts
const BASE_BACKOFF_MS = 5_000;    // then 5s, 10s, 20s, ... per further failure
const MAX_BACKOFF_MS = 15 * 60_000;
const FORGET_AFTER_MS = 60 * 60_000;

/**
 * Sliding window plus escalating lockout, in memory. In memory is enough: the
 * relay is a single process, and a restart resetting the counters costs an
 * attacker a restart they cannot trigger.
 *
 * Only authentication failures escalate. A typo in a hostname, or the
 * unknown-host-key round trip, is an attempt but not a failure — otherwise the
 * normal first connection to a new server would push you toward a lockout.
 */
export class ConnectLimiter {
  constructor({ windowMs = WINDOW_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.clients = new Map(); // ip -> { attempts: number[], failures, blockedUntil, lastSeen }
    setInterval(() => this.prune(), 5 * 60_000).unref();
  }

  entry(ip) {
    let e = this.clients.get(ip);
    if (!e) { e = { attempts: [], failures: 0, blockedUntil: 0, lastSeen: 0 }; this.clients.set(ip, e); }
    return e;
  }

  /** Returns milliseconds to wait, or 0 if the attempt may go ahead (and records it). */
  take(ip, now = Date.now()) {
    const e = this.entry(ip);
    e.lastSeen = now;
    e.attempts = e.attempts.filter((t) => now - t < this.windowMs);
    if (e.blockedUntil > now) return e.blockedUntil - now;
    if (e.attempts.length >= this.maxAttempts) return e.attempts[0] + this.windowMs - now;
    e.attempts.push(now);
    return 0;
  }

  failure(ip, now = Date.now()) {
    const e = this.entry(ip);
    e.failures += 1;
    if (e.failures >= FREE_FAILURES) {
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (e.failures - FREE_FAILURES), MAX_BACKOFF_MS);
      e.blockedUntil = now + backoff;
    }
  }

  success(ip) {
    const e = this.entry(ip);
    e.failures = 0;
    e.blockedUntil = 0;
  }

  prune(now = Date.now()) {
    for (const [ip, e] of this.clients) {
      if (now - e.lastSeen > FORGET_AFTER_MS && e.blockedUntil < now) this.clients.delete(ip);
    }
  }
}

export function rateLimitMessage(waitMs) {
  const s = Math.max(1, Math.ceil(waitMs / 1000));
  const human = s < 90 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minutes`;
  return `Too many sign-in attempts from this address. Wait ${human} before trying again.`;
}

/* ============================================================ access secret */

/**
 * A per-launch secret, the way Jupyter does it. Binding to localhost keeps the
 * network out, but not other users on the same machine, other processes, or a
 * WSL/Docker port mapping that quietly republishes 127.0.0.1:3000. The secret is
 * printed once in the terminal that started the relay; whoever can read that
 * terminal is the person who is meant to use it.
 *
 * It rides in the URL *fragment*, which browsers never send to a server, so it
 * does not land in access logs or Referer headers. The page trades it for an
 * httpOnly cookie and strips the fragment. Nothing is written to disk, so a
 * restart revokes every browser that had it.
 *
 * This gates access to the relay as a whole. It is independent of the
 * X-Session-Token, which still selects *which* SSH session a call acts on.
 */

export class AccessGate {
  constructor({ enabled = true, port, tls = false } = {}) {
    this.enabled = enabled;
    this.secret = enabled ? randomBytes(24).toString('base64url') : null;
    // Cookies are not port-scoped, so two relays on one machine would overwrite
    // each other's cookie without the port in its name.
    this.cookieName = `su_ssh_access_${port}`;
    this.tls = tls;
  }

  matches(candidate) {
    if (!this.enabled) return true;
    if (typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Does this raw Cookie header carry the secret? */
  allows(cookieHeader) {
    if (!this.enabled) return true;
    for (const part of String(cookieHeader || '').split(';')) {
      const at = part.indexOf('=');
      if (at === -1) continue;
      if (part.slice(0, at).trim() === this.cookieName && this.matches(decodeURIComponent(part.slice(at + 1).trim()))) return true;
    }
    return false;
  }

  cookie() {
    return `${this.cookieName}=${encodeURIComponent(this.secret)}; HttpOnly; SameSite=Strict; Path=/${this.tls ? '; Secure' : ''}`;
  }

  static get refusal() {
    return 'This relay needs its access link. Open the URL printed in the terminal where su-ssh was started '
      + '(it ends in #k=…). Restarting the relay issues a new link.';
  }

  /** Express middleware for /api routes. */
  middleware(openPaths = []) {
    return (req, res, next) => {
      if (this.allows(req.headers.cookie) || openPaths.includes(req.path)) return next();
      res.status(401).json({ error: AccessGate.refusal, code: 'ACCESS_REQUIRED' });
    };
  }
}
