/**
 * index.js — relay entry point.
 *
 * The browser never speaks SSH. It speaks HTTP and WebSocket to this process,
 * and this process speaks SSH to the target host. That hop is not an
 * architectural preference; SSH is a raw TCP protocol and no browser can open
 * a raw TCP socket.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { connect, getSession, describeSessions, HttpError, startIdleReaper, MAX_SESSIONS } from './ssh-session.js';
import {
  buildAllowlist, describeAllowlist, hostGuard, checkRequestOrigin,
  ConnectLimiter, rateLimitMessage, AccessGate, setupRefusal, isLoopbackAddress,
} from './security.js';
import {
  MIN_LENGTH, authFilePath, checkStrength, setPassphrase, changePassphrase,
  verifyPassphrase, isOutdated, rehash, loadAuth,
} from './passphrase.js';
import { fsRouter } from './routes-fs.js';
import { createForward, listForwards, removeForward } from './port-forward.js';
import {
  listProfiles, upsertProfile, patchProfile, noteConnected,
  rememberForward, forgetForward, forgetProfile, forgetUnpinned, migrate,
  profileId, parseProfileId, forwardKey, sanitiseForward, profileFilePath,
} from './profiles.js';
import { terminalRoute } from './terminal-ws.js';
import { journalRoute } from './journal-ws.js';
import { metricsRoute } from './metrics-ws.js';
import { attachWebSockets } from './ws-router.js';
import {
  listServices, showService, runAction, daemonReload,
  readUnitFile, writeUnitFile, journalSnapshot, probePrivilege,
  assertScope, ACTION_LABELS,
} from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.BIND || '127.0.0.1';
const IDLE_MINUTES = process.env.SESSION_IDLE_MINUTES === undefined ? 15 : Number(process.env.SESSION_IDLE_MINUTES);
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

// Misconfiguration is reported as one line and a non-zero exit, not as a stack
// trace: these are things the person starting the relay typed, not bugs.
function configError(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!Number.isFinite(IDLE_MINUTES) || IDLE_MINUTES < 0) {
  configError(`--idle-timeout / SESSION_IDLE_MINUTES must be a number of minutes (0 disables reaping), got "${process.env.SESSION_IDLE_MINUTES}".`);
}
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  configError('TLS needs both a certificate and a key: pass --tls-cert and --tls-key together (or TLS_CERT and TLS_KEY).');
}

let ALLOWED;
try {
  ALLOWED = buildAllowlist({ port: PORT, bind: HOST, extra: process.env.ALLOWED_HOSTS || '' });
} catch (err) { configError(err.message); }
const limiter = new ConnectLimiter();
// Separate from the SSH limiter: a mistyped server password must not lock the
// passphrase screen, nor the other way round.
const unlockLimiter = new ConnectLimiter();
const gate = new AccessGate({ enabled: process.env.NO_ACCESS_KEY !== '1', port: PORT, tls: Boolean(TLS_CERT) });

const app = express();
app.disable('x-powered-by');
// First, before static files: a rebound page must not even be able to load
// our JavaScript under its own hostname.
app.use(hostGuard(ALLOWED));
app.use(express.json({ limit: '8mb' }));

/* ------------------------------------------------------------------- static */

app.use(express.static(path.join(ROOT, 'public')));

// xterm is served from disk rather than a CDN so the desktop works on an
// air-gapped network. The paths are *resolved*, not joined onto our own
// directory: once this package is installed as a dependency, npm hoists
// @xterm up to the parent node_modules and `ROOT/node_modules/@xterm` no
// longer exists. Resolution finds it wherever the installer actually put it.
const require = createRequire(import.meta.url);
const xtermRoot = path.dirname(require.resolve('@xterm/xterm/package.json'));
const fitLib = path.dirname(require.resolve('@xterm/addon-fit'));

app.use('/vendor/xterm', express.static(path.join(xtermRoot, 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(xtermRoot, 'css')));
app.use('/vendor/xterm-fit', express.static(fitLib));

/* -------------------------------------------------------------- auth plumbing */

/** Pull the session token off the header for every /api route below. */
function readToken(req, _res, next) {
  req.sessionToken = req.get('X-Session-Token') || req.query.token || null;
  next();
}

/* --------------------------------------------------------------- passphrase */

// Static assets above stay public so the page can load and ask for the
// passphrase. Everything under /api needs the access cookie, except the calls
// below that report the state and obtain one.

/** A corrupt auth file is reported, never treated as "no passphrase yet". */
function authState(res) {
  try { return { setUp: gate.isSetUp() }; } catch (err) {
    console.error(`[access] ${err.message}`);
    res.status(500).json({ error: err.message, code: 'AUTH_FILE_BROKEN' });
    return null;
  }
}

function throttleUnlock(req, res) {
  const wait = unlockLimiter.take(req.ip);
  if (!wait) return false;
  const retryAfter = Math.ceil(wait / 1000);
  console.warn(`[access] ${req.ip} unlock refused for ${retryAfter}s`);
  res.set('Retry-After', String(retryAfter)).status(429)
    .json({ error: rateLimitMessage(wait), code: 'RATE_LIMITED', retryAfter });
  return true;
}

app.get('/api/access', (req, res) => {
  if (!gate.enabled) return res.json({ required: false, granted: true });
  const state = authState(res);
  if (!state) return;
  res.json({
    required: true,
    setUp: state.setUp,
    granted: state.setUp && gate.allows(req.headers.cookie),
    // Tells the page whether to offer the setup form or explain where to go.
    setupAllowed: !state.setUp && !setupRefusal(req),
    minLength: MIN_LENGTH,
  });
});

app.post('/api/access/setup', async (req, res, next) => {
  try {
    if (!gate.enabled) return res.status(404).json({ error: 'Access control is disabled (--no-auth).' });
    const state = authState(res);
    if (!state) return;
    if (state.setUp) return res.status(409).json({ error: 'A passphrase is already set. Enter it to unlock, or run su-ssh --reset-passphrase on the relay machine.', code: 'ALREADY_SET' });
    const refusal = setupRefusal(req);
    if (refusal) {
      console.warn(`[access] setup refused from ${req.socket.remoteAddress}`);
      return res.status(403).json({ error: refusal, code: 'SETUP_LOOPBACK_ONLY' });
    }
    const weak = checkStrength(req.body?.passphrase);
    if (weak) return res.status(400).json({ error: weak, code: 'WEAK_PASSPHRASE' });
    try { await setPassphrase(req.body.passphrase); } catch (err) {
      if (err.code === 'ALREADY_SET') return res.status(409).json({ error: err.message, code: 'ALREADY_SET' });
      throw err;
    }
    console.log(`[access] passphrase chosen; stored as a scrypt hash in ${authFilePath()}`);
    res.set('Set-Cookie', gate.cookie({ remember: req.body.remember !== false })).json({ granted: true });
  } catch (err) { next(err); }
});

app.post('/api/access/unlock', async (req, res, next) => {
  try {
    if (!gate.enabled) return res.json({ granted: true });
    const state = authState(res);
    if (!state) return;
    if (!state.setUp) return res.status(409).json({ error: 'No passphrase has been chosen yet. Reload the page.', code: 'NOT_SET' });
    if (throttleUnlock(req, res)) return;
    const auth = loadAuth();
    if (!(await verifyPassphrase(auth.passphrase, req.body?.passphrase))) {
      unlockLimiter.failure(req.ip);
      console.warn(`[access] wrong passphrase from ${req.ip}`);
      return res.status(401).json({ error: 'That passphrase is not right.', code: 'BAD_PASSPHRASE' });
    }
    unlockLimiter.success(req.ip);
    if (isOutdated(auth.passphrase)) {
      try { await rehash(req.body.passphrase); } catch (err) { console.warn(`[access] could not upgrade the hash: ${err.message}`); }
    }
    res.set('Set-Cookie', gate.cookie({ remember: req.body.remember !== false })).json({ granted: true });
  } catch (err) { next(err); }
});

/**
 * Needs both the cookie and the current passphrase: a browser left unlocked
 * must not be enough to lock the owner out. Rotates the signing key, so every
 * other browser is logged out; this one gets a fresh cookie.
 */
app.post('/api/access/change', async (req, res, next) => {
  try {
    if (!gate.enabled) return res.status(404).json({ error: 'Access control is disabled (--no-auth).' });
    if (!gate.allows(req.headers.cookie)) return res.status(401).json({ error: AccessGate.refusal, code: 'ACCESS_REQUIRED' });
    if (throttleUnlock(req, res)) return;
    const auth = loadAuth();
    if (!(await verifyPassphrase(auth.passphrase, req.body?.current))) {
      unlockLimiter.failure(req.ip);
      return res.status(401).json({ error: 'The current passphrase is not right.', code: 'BAD_PASSPHRASE' });
    }
    unlockLimiter.success(req.ip);
    const weak = checkStrength(req.body?.passphrase);
    if (weak) return res.status(400).json({ error: weak, code: 'WEAK_PASSPHRASE' });
    await changePassphrase(req.body.passphrase);
    console.log('[access] passphrase changed; every other browser has been signed out');
    closeStaleSockets();
    res.set('Set-Cookie', gate.cookie({ remember: true })).json({ granted: true });
  } catch (err) { next(err); }
});

/** Forget the cookie in this browser. */
app.post('/api/access/lock', (req, res) => {
  res.set('Set-Cookie', gate.clearCookie()).json({ locked: true });
});

app.use('/api', gate.middleware());

/* ---------------------------------------------------------------- API routes */

/**
 * Throttle before doing any work. The outcome is fed back afterwards so that
 * only real authentication failures escalate the lockout.
 */
function throttleConnect(req, res, next) {
  const wait = limiter.take(req.ip);
  if (!wait) return next();
  const retryAfter = Math.ceil(wait / 1000);
  console.warn(`[ratelimit] ${req.ip} refused for ${retryAfter}s`);
  res.set('Retry-After', String(retryAfter))
    .status(429)
    .json({ error: rateLimitMessage(wait), code: 'RATE_LIMITED', retryAfter });
}

app.post('/api/connect', throttleConnect, async (req, res, next) => {
  try {
    let session;
    try {
      session = await connect(req.body);
    } catch (err) {
      if (err.status === 401) limiter.failure(req.ip);
      throw err;
    }
    limiter.success(req.ip);
    console.log(`[connect] ${session.meta.username}@${session.meta.host}:${session.meta.port} via ${session.meta.authMethod}`);

    // The profile is the relay's memory of this server: it carries the label
    // and colour a *different* browser chose, the tunnels that were open last
    // time, and whether the user wants their windows back.
    let profile = null;
    try {
      profile = noteConnected(session.meta);
    } catch (err) {
      // A broken profile file must not cost a working SSH session, but it must
      // not be swallowed either — the browser shows this next to the desktop.
      console.warn(`[profiles] ${err.message}`);
    }

    // Forwards requested on the login screen are opened here, one by one, and
    // so are the ones this profile had open last time. A forward that cannot
    // bind is reported rather than thrown: losing the whole session because
    // port 8080 was taken would be a poor trade, and a saved tunnel whose port
    // somebody else has taken since is exactly the case that has to survive.
    const queued = (Array.isArray(req.body.forwards) ? req.body.forwards : [])
      .map((f) => sanitiseForward(f)).filter(Boolean);
    const seen = new Set(queued.map(forwardKey));
    const saved = (profile?.forwards || []).filter((f) => !seen.has(forwardKey(f)));

    const pending = [
      ...queued.map((spec) => ({ spec, saved: false })),
      ...saved.map((spec) => ({ spec, saved: true })),
    ].slice(0, 20);

    const forwards = [];
    for (const { spec, saved: fromProfile } of pending) {
      try {
        forwards.push({ ...(await createForward(session, spec)).toJSON(), saved: fromProfile });
      } catch (err) {
        forwards.push({ ...spec, status: 'error', error: err.message, saved: fromProfile });
        console.warn(`[forward] ${err.message}`);
      }
    }
    // Anything queued on the greeter is now part of this server's memory too.
    for (const spec of queued) {
      try { profile = rememberForward(session.meta, spec) || profile; } catch { /* reported above */ }
    }

    res.json({ token: session.token, ...session.meta, forwards, profile });
  } catch (err) { next(err); }
});

app.post('/api/disconnect', readToken, (req, res) => {
  try {
    getSession(req.sessionToken).destroy();
  } catch { /* already gone; disconnecting twice is not an error */ }
  res.json({ disconnected: true });
});

/**
 * Batched liveness check for a tab holding several sessions.
 *
 * The response is keyed by the tokens the request supplied and contains nothing
 * else: a token that is not live is simply missing from `sessions`. There is
 * deliberately no endpoint that enumerates the relay's sessions — knowing that
 * a session exists is knowing that someone is logged into that host, and the
 * token itself is the only credential for it.
 */
app.post('/api/sessions/validate', (req, res, next) => {
  try {
    const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
    if (tokens.length > 64) throw new HttpError(400, 'Too many tokens in one validation request.');
    const clean = tokens.filter((t) => typeof t === 'string' && /^[0-9a-f]{1,128}$/.test(t));
    res.json({ sessions: describeSessions(clean) });
  } catch (err) { next(err); }
});

app.get('/api/session', readToken, (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    res.json({ token: session.token, ...session.meta });
  } catch (err) { next(err); }
});

/**
 * System info for the desktop panel. One exec with delimiters beats five
 * round trips. Each field is guarded so a missing tool degrades to a dash
 * instead of failing the whole call.
 */
app.get('/api/system', readToken, async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const script = [
      'echo "::hostname::"; hostname 2>/dev/null || echo -',
      'echo "::kernel::"; uname -sr 2>/dev/null || echo -',
      'echo "::distro::"; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo -',
      'echo "::uptime::"; uptime -p 2>/dev/null || echo -',
      'echo "::disk::"; df -Ph "$HOME" 2>/dev/null | tail -1 || echo -',
      'echo "::memory::"; free -h 2>/dev/null | awk \'/^Mem:/{print $3" / "$2}\' || echo -',
      'echo "::end::"',
    ].join('; ');

    const { stdout } = await session.exec(script);
    const info = {};
    let key = null;
    for (const line of stdout.split('\n')) {
      const marker = line.match(/^::(\w+)::$/);
      if (marker) { key = marker[1]; info[key] = ''; continue; }
      if (key && key !== 'end' && line.trim()) {
        info[key] = info[key] ? `${info[key]} ${line.trim()}` : line.trim();
      }
    }

    if (info.disk && info.disk !== '-') {
      const cols = info.disk.split(/\s+/);
      info.disk = cols.length >= 5 ? `${cols[2]} / ${cols[1]} used (${cols[4]})` : info.disk;
    }
    res.json({ ...info, username: session.meta.username, host: session.meta.host });
  } catch (err) { next(err); }
});

app.use('/api/fs', readToken, fsRouter);

/* ------------------------------------------------------------ port forwards */

app.get('/api/forwards', readToken, (req, res, next) => {
  try {
    res.json({ forwards: listForwards(getSession(req.sessionToken)) });
  } catch (err) { next(err); }
});

app.post('/api/forwards', readToken, async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const forward = await createForward(session, req.body);
    console.log(`[forward] opened ${forward.toJSON().description}`);
    // Opening it is the whole gesture: there is no second thing to press to
    // have it come back next time.
    try { rememberForward(session.meta, forward.spec); } catch (err) { console.warn(`[profiles] ${err.message}`); }
    res.json(forward.toJSON());
  } catch (err) { next(err); }
});

app.delete('/api/forwards/:id', readToken, async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const forward = await removeForward(session, req.params.id);
    console.log(`[forward] closed ${forward.description}`);
    // Closing one by hand is how you stop it coming back. Disconnecting is not:
    // that tears forwards down through the session, not through this route.
    try {
      forgetForward(profileId(session.meta), forwardKey(forward));
    } catch { /* no profile, or none saved — nothing to forget */ }
    res.json({ closed: true, forward });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------ connection profiles */

/**
 * What the relay remembers about the servers you connect to: the recents list,
 * the label and colour, the saved forwards, the saved window layout and whether
 * to put it back. It used to live in one browser's localStorage, which is why
 * configuring in Chrome and opening Firefox looked like amnesia.
 *
 * These calls take no session token: a profile describes a server you *might*
 * connect to, so it has to be readable from the login screen. They are still
 * behind the access cookie and the Host/Origin guard like everything under
 * /api — this is the user's list of servers, not public information.
 *
 * No route here can write a credential: every path into the file goes through
 * profiles.js's allowlist sanitiser. See the note at the top of that module.
 */
app.get('/api/profiles', (req, res, next) => {
  try {
    res.json({ profiles: listProfiles(), file: profileFilePath() });
  } catch (err) { next(err); }
});

app.post('/api/profiles/update', (req, res, next) => {
  try {
    const body = req.body || {};
    // Either identify an existing profile by id, or supply the three parts a
    // new one is built from. Both go through the same validation.
    const profile = body.id !== undefined && body.host === undefined
      ? patchProfile(parseProfileId(body.id), body)
      : upsertProfile(body);
    res.json({ profile });
  } catch (err) { next(err); }
});

app.post('/api/profiles/forget', (req, res, next) => {
  try {
    if (req.body?.unpinned === true) return res.json({ forgotten: forgetUnpinned() });
    const id = parseProfileId(req.body?.id);
    res.json({ forgotten: forgetProfile(id) ? 1 : 0 });
  } catch (err) { next(err); }
});

/** Forget one saved forward without touching the one that may be running. */
app.post('/api/profiles/forwards/forget', (req, res, next) => {
  try {
    const id = parseProfileId(req.body?.id);
    res.json({ profile: forgetForward(id, String(req.body?.key || '')) });
  } catch (err) { next(err); }
});

/**
 * One-time import of what a browser still has in localStorage. Merging, never
 * overwriting: a second browser arriving with its own stale copy must not
 * clobber what is already here.
 */
app.post('/api/profiles/migrate', (req, res, next) => {
  try {
    res.json({ imported: migrate(req.body || {}), profiles: listProfiles() });
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- services */

/** Scope and unit arrive on nearly every call; read them in one place. */
function serviceCtx(req) {
  return {
    session: getSession(req.sessionToken),
    scope: assertScope(req.query.scope || req.body?.scope || 'system'),
  };
}

app.get('/api/services', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    const [list, privilege] = await Promise.all([listServices(session, scope), probePrivilege(session)]);
    res.json({ ...list, privilege, actions: ACTION_LABELS });
  } catch (err) { next(err); }
});

app.get('/api/services/:unit', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    res.json(await showService(session, scope, req.params.unit));
  } catch (err) { next(err); }
});

app.get('/api/services/:unit/logs', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    res.json(await journalSnapshot(session, scope, req.params.unit, req.query.lines));
  } catch (err) { next(err); }
});

app.get('/api/services/:unit/file', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    res.json(await readUnitFile(session, scope, req.params.unit, req.query.which, req.query.password));
  } catch (err) { next(err); }
});

app.post('/api/services/:unit/file', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    const result = await writeUnitFile(
      session, scope, req.params.unit,
      req.body.path, req.body.content, req.body.password,
      { reload: req.body.reload !== false },
    );
    console.log(`[systemd] wrote ${result.path}`);
    res.json(result);
  } catch (err) { next(err); }
});

app.post('/api/services/:unit/:action', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    const result = await runAction(session, scope, req.params.unit, req.params.action, req.body.password);
    console.log(`[systemd] ${scope} ${req.params.action} ${result.unit}`);
    // The caller almost always wants the new state, and asking for it here
    // saves a round trip during which the UI would show the old one.
    res.json({ ...result, detail: await showService(session, scope, result.unit) });
  } catch (err) { next(err); }
});

app.post('/api/daemon-reload', readToken, async (req, res, next) => {
  try {
    const { session, scope } = serviceCtx(req);
    res.json(await daemonReload(session, scope, req.body.password));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- error handler */

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  if (status >= 500) console.error('[error]', err);
  // needsPassword tells the browser to ask for a sudo password and retry,
  // rather than reporting a dead end the user cannot act on.
  res.status(status).json({
    error: err.message || 'Something went wrong.',
    needsPassword: !!err.needsPassword,
    // "You may retry this with sudo" — distinct from "give me a password",
    // because the browser must ask the user before elevating anything.
    ...(err.needsSudo ? { needsSudo: true } : {}),
    ...(err.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}),
    ...(err.hostKey ? { hostKey: err.hostKey } : {}),
  });
});

/* -------------------------------------------------------------------- listen */

// Certificates are read once at start-up. A missing file is reported by path
// rather than as a bare ENOENT from deep inside the TLS stack.
function readTlsFile(label, file) {
  try { return fs.readFileSync(file); } catch (err) {
    return configError(`Cannot read the TLS ${label} at ${file}: ${err.code || err.message}`);
  }
}

const server = TLS_CERT
  ? https.createServer({ cert: readTlsFile('certificate', TLS_CERT), key: readTlsFile('key', TLS_KEY) }, app)
  : http.createServer(app);
const scheme = TLS_CERT ? 'https' : 'http';

const wss = attachWebSockets(server, {
  '/ws/terminal': terminalRoute,
  '/ws/journal': journalRoute,
  '/ws/metrics': metricsRoute,
}, {
  // Origin is always checked on the upgrade: browsers do not apply CORS to
  // WebSockets, so this is the only cross-site barrier they have.
  authorize: (request) => checkRequestOrigin(ALLOWED, { host: request.headers.host, origin: request.headers.origin }, { checkOrigin: true })
    || (gate.allows(request.headers.cookie) ? null : AccessGate.refusal),
});

/**
 * The cookie is checked at the WebSocket handshake; a socket already open would
 * otherwise outlive a passphrase change, a --reset-passphrase or its cookie's
 * expiry. Sweep them: anything whose handshake cookie no longer verifies is
 * closed with 4401.
 */
function closeStaleSockets() {
  if (!gate.enabled) return;
  for (const ws of wss.clients) {
    if (!gate.allows(ws.accessCookie)) ws.close(4401, 'Access revoked');
  }
}
setInterval(closeStaleSockets, 30_000).unref();

startIdleReaper(IDLE_MINUTES * 60_000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') configError(`Port ${PORT} on ${HOST} is already in use. Pick another with --port, or stop what is using it (su-ssh status shows a background relay).`);
  if (err.code === 'EACCES') configError(`Not allowed to listen on ${HOST}:${PORT} (ports below 1024 need privileges).`);
  configError(`Cannot listen on ${HOST}:${PORT}: ${err.message}`);
});

server.listen(PORT, HOST, () => {
  // A wildcard bind is not something a browser can open; point at loopback.
  const shown = ['0.0.0.0', '::'].includes(HOST) ? '127.0.0.1' : (HOST.includes(':') ? `[${HOST}]` : HOST);
  console.log(`\n  Web desktop relay listening on ${scheme}://${HOST}:${PORT}`);
  const loopbackBind = isLoopbackAddress(HOST) || HOST === 'localhost';
  if (gate.enabled) {
    let setUp = false;
    try { setUp = gate.isSetUp(); } catch (err) { console.error(`\n  ⚠  ${err.message}\n`); }
    if (setUp) {
      console.log(`\n  Open ${scheme}://${shown}:${PORT}/ and enter your passphrase.`);
      console.log('  Forgotten it? Stop the relay and run: su-ssh --reset-passphrase');
    } else {
      console.log(`\n  No passphrase yet. Open ${scheme}://127.0.0.1:${PORT}/ in a browser on THIS machine to choose one.`);
      if (!loopbackBind) {
        console.warn(`  ⚠  Bound to ${HOST} with no passphrase set: setup is accepted only from this machine`);
        console.warn('     (loopback), never over the network. Until it is set, remote browsers are refused.');
      }
    }
    console.log(`  Passphrase hash and cookie key (0600): ${authFilePath()}\n`);
  } else {
    console.warn('  Access control disabled (--no-auth). Anyone who can reach this port can use your ssh-agent and keys;');
    console.warn('  only do this behind a reverse proxy that authenticates users itself.');
  }
  console.log(`  Bound to ${HOST}. Set BIND=0.0.0.0 to expose it, but read the security notes first.`);
  if (process.env.ALLOW_PUBLIC_FORWARDS === '1') console.log('  Port forwards may bind non-loopback addresses.');
  if (process.env.ROOT_JAIL) console.log(`  Path jail active: ${process.env.ROOT_JAIL}`);
  console.log(`  Answering to host names: ${describeAllowlist(ALLOWED)}`);
  console.log(`  Connection profiles (no credentials): ${profileFilePath()}`);
  console.log(`  At most ${MAX_SESSIONS} SSH sessions at once (MAX_SESSIONS).`);
  console.log(IDLE_MINUTES > 0
    ? `  Sessions with no open window close after ${IDLE_MINUTES} idle minute${IDLE_MINUTES === 1 ? '' : 's'}.`
    : '  Idle session reaping disabled.');
  console.log('');
});
