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
import { fileURLToPath } from 'node:url';
import express from 'express';

import { connect, getSession, HttpError } from './ssh-session.js';
import { fsRouter } from './routes-fs.js';
import { attachTerminal } from './terminal-ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.BIND || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/* ------------------------------------------------------------------- static */

app.use(express.static(path.join(ROOT, 'public')));
// Serve xterm from node_modules so the app works with no internet access.
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm-css', express.static(path.join(ROOT, 'node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm-fit', express.static(path.join(ROOT, 'node_modules/@xterm/addon-fit/lib')));

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
    res.json({ token: session.token, ...session.meta });
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

/* ------------------------------------------------------------- error handler */

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

/* -------------------------------------------------------------------- listen */

const server = http.createServer(app);
attachTerminal(server);

server.listen(PORT, HOST, () => {
  console.log(`\n  Web desktop relay listening on http://${HOST}:${PORT}`);
  console.log(`  Bound to ${HOST}. Set BIND=0.0.0.0 to expose it, but read the security notes first.`);
  if (process.env.ROOT_JAIL) console.log(`  Path jail active: ${process.env.ROOT_JAIL}`);
  console.log('');
});
