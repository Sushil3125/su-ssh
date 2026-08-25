/**
 * index.js — relay entry point.
 *
 * The browser never speaks SSH. It speaks HTTP and WebSocket to this process,
 * and this process speaks SSH to the target host. That hop is not an
 * architectural preference; SSH is a raw TCP protocol and no browser can open
 * a raw TCP socket.
 */

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { connect, getSession, HttpError } from './ssh-session.js';
import { fsRouter } from './routes-fs.js';
import { createForward, listForwards, removeForward } from './port-forward.js';
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

const app = express();
app.disable('x-powered-by');
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

/* ---------------------------------------------------------------- API routes */

app.post('/api/connect', async (req, res, next) => {
  try {
    const session = await connect(req.body);
    console.log(`[connect] ${session.meta.username}@${session.meta.host}:${session.meta.port} via ${session.meta.authMethod}`);

    // Forwards requested on the login screen are opened here, one by one. A
    // forward that cannot bind is reported rather than thrown: losing the whole
    // session because port 8080 was taken would be a poor trade.
    const pending = Array.isArray(req.body.forwards) ? req.body.forwards.slice(0, 20) : [];
    const forwards = [];
    for (const spec of pending) {
      try {
        forwards.push((await createForward(session, spec)).toJSON());
      } catch (err) {
        forwards.push({ ...spec, status: 'error', error: err.message });
        console.warn(`[forward] ${err.message}`);
      }
    }

    res.json({ token: session.token, ...session.meta, forwards });
  } catch (err) { next(err); }
});

app.post('/api/disconnect', readToken, (req, res) => {
  try {
    getSession(req.sessionToken).destroy();
  } catch { /* already gone; disconnecting twice is not an error */ }
  res.json({ disconnected: true });
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
    res.json(forward.toJSON());
  } catch (err) { next(err); }
});

app.delete('/api/forwards/:id', readToken, async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const forward = await removeForward(session, req.params.id);
    console.log(`[forward] closed ${forward.description}`);
    res.json({ closed: true, forward });
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
  res.status(status).json({ error: err.message || 'Something went wrong.', needsPassword: !!err.needsPassword });
});

/* -------------------------------------------------------------------- listen */

const server = http.createServer(app);
attachWebSockets(server, {
  '/ws/terminal': terminalRoute,
  '/ws/journal': journalRoute,
  '/ws/metrics': metricsRoute,
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Web desktop relay listening on http://${HOST}:${PORT}`);
  console.log(`  Bound to ${HOST}. Set BIND=0.0.0.0 to expose it, but read the security notes first.`);
  if (process.env.ALLOW_PUBLIC_FORWARDS === '1') console.log('  Port forwards may bind non-loopback addresses.');
  if (process.env.ROOT_JAIL) console.log(`  Path jail active: ${process.env.ROOT_JAIL}`);
  console.log('');
});
