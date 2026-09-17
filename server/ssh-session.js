/**
 * ssh-session.js
 * -----------------------------------------------------------------------------
 * Owns the single long-lived SSH connection for this prototype.
 *
 * Deliberate design note: everything goes through `getSession()` rather than a
 * module-level `connection` variable that the rest of the code reads directly.
 * That indirection is what lets you swap "one shared connection" for
 * "one connection per app-user" or "one container per app-user" later without
 * touching a single route handler.
 */

import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from 'ssh2';
import { checkHostKey, pinHostKey, pinFilePath } from './host-keys.js';

/** @type {Map<string, Session>} */
const sessions = new Map();

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 10_000;

/**
 * A relay-wide ceiling on live sessions. Each one holds a TCP connection, an
 * SFTP channel, any PTYs and any bound forward ports, so "as many as the client
 * asks for" is a resource exhaustion bug waiting for a buggy tab. The browser
 * enforces its own, lower per-tab limit; this one is the backstop that also
 * covers several tabs and anything that is not our page.
 */
const MAX_SESSIONS = (() => {
  const raw = process.env.MAX_SESSIONS;
  if (raw === undefined || raw === '') return 16;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16;
})();

class Session {
  constructor(token, conn, meta) {
    this.token = token;
    this.conn = conn;
    this.meta = meta;          // host, port, username, authMethod, home, connectedAt
    this.sftp = null;
    this.channels = new Set(); // open shell channels, so we can clean up on disconnect
    this.forwards = new Map(); // id -> Forward, see port-forward.js
    this.remoteRouterAttached = false;
    // Liveness for the idle reaper. Every HTTP call touches lastActivity via
    // getSession(); an open WebSocket keeps the session alive by itself, which
    // is what lets a tab that only shows the top-bar meters stay connected.
    this.lastActivity = Date.now();
    this.openSockets = 0;
  }

  touch() { this.lastActivity = Date.now(); }

  /**
   * One SFTP subsystem is opened lazily and reused. Opening a new one per
   * request works but costs a round trip every time, which you feel immediately
   * in a file manager that lists a directory on every click.
   */
  async getSftp() {
    if (this.sftp && !this.sftp.closed) return this.sftp;
    this.sftp = await new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.closed = false;
        sftp.on('close', () => { sftp.closed = true; });
        resolve(sftp);
      });
    });
    return this.sftp;
  }

  /**
   * Run a command and collect stdout/stderr.
   *
   * `stdin` is written and the stream closed immediately, which is how a sudo
   * password is delivered without it ever appearing in the command line — and
   * therefore without it appearing in the remote host's process list.
   */
  exec(command, { stdin = null } = {}) {
    return new Promise((resolve, reject) => {
      this.conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '', stderr = '';
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code) => resolve({ code, stdout, stderr }));
        if (stdin !== null) stream.end(stdin);
      });
    });
  }

  /**
   * Start a long-running command and hand back the live channel.
   *
   * A PTY is requested on purpose. OpenSSH does not implement the SSH "signal"
   * channel request, so `stream.signal('TERM')` is silently ignored and a
   * `journalctl -f` would keep running on the server after the browser tab
   * closed. With a PTY, closing the channel hangs up the terminal and systemd's
   * own SIGHUP handling reaps the process — the same thing that happens when
   * you close a real terminal window.
   */
  execStream(command, { pty = true, stdin = null } = {}) {
    return new Promise((resolve, reject) => {
      this.conn.exec(command, { pty: pty ? { term: 'dumb', cols: 200, rows: 50 } : false }, (err, stream) => {
        if (err) return reject(err);
        this.channels.add(stream);
        stream.on('close', () => this.channels.delete(stream));
        if (stdin !== null) stream.write(stdin);
        resolve(stream);
      });
    });
  }

  destroy() {
    // Listeners first: a forward left bound would survive the SSH connection
    // and keep a port on this host occupied with nothing behind it.
    for (const fwd of this.forwards.values()) { try { fwd.stop(); } catch { /* already gone */ } }
    this.forwards.clear();
    for (const ch of this.channels) { try { ch.end(); } catch { /* already gone */ } }
    this.channels.clear();
    try { this.conn.end(); } catch { /* already gone */ }
    sessions.delete(this.token);
  }
}

/**
 * Translate the UI's auth choice into an ssh2 connection config.
 *
 * Supported variations:
 *   password  - plain password (also answers keyboard-interactive, see below)
 *   key       - private key pasted into the browser, optional passphrase
 *   keyfile   - private key read from a path on the machine running THIS relay
 *   agent     - hand off to a running ssh-agent (SSH_AUTH_SOCK)
 *   auto      - try agent, then default key paths, then password if supplied
 */
export function buildAuthConfig(input) {
  const {
    host, port = 22, username,
    authMethod = 'password',
    password, privateKey, privateKeyPath, passphrase,
  } = input;
  // There is deliberately no request field for the agent socket. Letting a
  // request name a local socket path would let whoever can reach the relay aim
  // it at any agent (or any Unix socket) on this machine.
  const agentSock = process.env.SSH_AUTH_SOCK;

  if (!host) throw new HttpError(400, 'Host is required.');
  if (!username) throw new HttpError(400, 'Username is required.');

  const config = {
    host,
    port: Number(port) || 22,
    username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_MS,
    // Many sshd configs answer password auth via keyboard-interactive instead
    // of the "password" method. Without this flag, a correct password fails
    // with "All configured authentication methods failed" and you lose an hour.
    tryKeyboard: true,
  };

  switch (authMethod) {
    case 'password': {
      if (!password) throw new HttpError(400, 'Password is required for password authentication.');
      config.password = password;
      break;
    }
    case 'key': {
      if (!privateKey || !privateKey.trim()) {
        throw new HttpError(400, 'Paste a private key, or choose a different authentication method.');
      }
      config.privateKey = normaliseKey(privateKey);
      if (passphrase) config.passphrase = passphrase;
      break;
    }
    case 'keyfile': {
      if (!privateKeyPath) throw new HttpError(400, 'Key file path is required.');
      // One message for every failure. Distinguishing "no such file" from
      // "permission denied" or "is a directory" would turn this field into a
      // probe for what exists on the relay host.
      const unreadable = new HttpError(400, 'Could not read a private key at that path on the relay host.');
      try {
        if (!statSync(String(privateKeyPath)).isFile()) throw unreadable;
        config.privateKey = readFileSync(String(privateKeyPath));
      } catch {
        throw unreadable;
      }
      if (passphrase) config.passphrase = passphrase;
      break;
    }
    case 'agent': {
      if (!agentSock) {
        throw new HttpError(400, 'No SSH agent found. SSH_AUTH_SOCK is not set on the relay host.');
      }
      config.agent = agentSock;
      break;
    }
    case 'auto': {
      if (agentSock) config.agent = agentSock;
      if (privateKey && privateKey.trim()) config.privateKey = normaliseKey(privateKey);
      if (passphrase) config.passphrase = passphrase;
      if (password) config.password = password;
      if (!config.agent && !config.privateKey && !config.password) {
        throw new HttpError(400, 'Auto mode needs at least one of: a running agent, a private key, or a password.');
      }
      break;
    }
    default:
      throw new HttpError(400, `Unknown authentication method: ${authMethod}`);
  }

  return config;
}

/**
 * Private keys pasted through a browser textarea routinely arrive with CRLF
 * line endings or a missing trailing newline. OpenSSH-format keys reject both.
 */
function normaliseKey(raw) {
  let key = raw.replace(/\r\n/g, '\n').trim();
  if (!key.endsWith('\n')) key += '\n';
  return key;
}

export async function connect(input) {
  // Checked before dialling, not after: refusing costs nothing, while a
  // successful handshake we then throw away has already authenticated against
  // the target's sshd and would leave a stray login in its auth log.
  if (sessions.size >= MAX_SESSIONS) {
    throw new HttpError(429,
      `This relay is already holding ${sessions.size} SSH sessions, its limit. `
      + 'Disconnect one, or restart the relay with a higher MAX_SESSIONS.',
      { code: 'SESSION_LIMIT' });
  }

  const config = buildAuthConfig(input);
  const conn = new Client();

  // The verdict is kept outside the verifier because ssh2 reports a refused key
  // only as a generic "Host denied" error; the error handler below swaps that
  // for the structured one the greeter knows how to present.
  let hostKeyError = null;
  config.hostVerifier = (keyBlob) => {
    let verdict;
    try {
      verdict = checkHostKey(config.host, config.port, keyBlob);
    } catch (err) {
      hostKeyError = new HttpError(500, err.message);
      return false;
    }
    if (verdict.status === 'trusted') return true;

    if (verdict.status === 'unknown' && input.trustHostKey && input.trustHostKey === verdict.fingerprint) {
      // Bound to the exact fingerprint the user was shown. A different key
      // turning up between the prompt and the retry is still refused.
      try {
        pinHostKey(config.host, config.port, keyBlob);
      } catch (err) {
        hostKeyError = new HttpError(500, `Could not save the host key pin to ${pinFilePath()}: ${err.message}`);
        return false;
      }
      console.log(`[hostkey] pinned ${verdict.id} ${verdict.keyType} ${verdict.fingerprint}`);
      return true;
    }

    hostKeyError = hostKeyHttpError(verdict);
    if (verdict.status !== 'unknown') {
      console.warn(`[hostkey] ${verdict.status.toUpperCase()} key for ${verdict.id}: got ${verdict.keyType} ${verdict.fingerprint}`);
    }
    return false;
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    conn.on('ready', () => finish(resolve));
    conn.on('error', (err) => finish(reject, hostKeyError || translateSshError(err)));
    conn.on('end', () => finish(reject, hostKeyError || new HttpError(502, 'The server closed the connection during handshake.')));

    // Answers the keyboard-interactive prompt with the supplied password.
    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finishPrompt) => {
      if (input.password) return finishPrompt(prompts.map(() => input.password));
      finishPrompt([]);
    });

    conn.connect(config);
  });

  const token = randomBytes(24).toString('hex');
  const session = new Session(token, conn, {
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod: input.authMethod || 'password',
    connectedAt: new Date().toISOString(),
    home: null,
  });

  // Resolving '.' over SFTP is the cheapest reliable way to learn the home
  // directory. Parsing `echo $HOME` works too, but this avoids a shell entirely.
  const sftp = await session.getSftp();
  session.meta.home = await new Promise((resolve) => {
    sftp.realpath('.', (err, absPath) => resolve(err ? `/home/${config.username}` : absPath));
  });

  conn.on('close', () => {
    for (const fwd of session.forwards.values()) { try { fwd.stop(); } catch { /* already gone */ } }
    session.forwards.clear();
    sessions.delete(token);
  });

  sessions.set(token, session);
  return session;
}

/**
 * 409 for both: the request was well formed, but the state of trust conflicts
 * with it. `code` is what the browser branches on.
 */
function hostKeyHttpError(v) {
  const where = `${v.host}${v.port === 22 ? '' : `:${v.port}`}`;
  const details = { host: v.host, port: v.port, keyType: v.keyType, fingerprint: v.fingerprint, expected: v.expected || [] };
  if (v.status === 'unknown') {
    return new HttpError(409, `The authenticity of ${where} can't be established. Its ${v.keyType} key fingerprint is ${v.fingerprint}.`,
      { code: 'HOST_KEY_UNKNOWN', hostKey: details });
  }
  if (v.status === 'revoked') {
    return new HttpError(403, `The host key presented by ${where} (${v.fingerprint}) is marked @revoked in ${v.source}. Refusing to connect.`,
      { code: 'HOST_KEY_REVOKED', hostKey: details });
  }
  const fix = v.source === pinFilePath()
    ? `npx su-ssh --forget-host ${where}`
    : `ssh-keygen -R ${v.port === 22 ? v.host : `'[${v.host}]:${v.port}'`}`;
  return new HttpError(409,
    `WARNING: the host key for ${where} has CHANGED. Someone could be intercepting this connection (man-in-the-middle), `
    + `or the server was reinstalled. Presented ${v.keyType} ${v.fingerprint}; expected `
    + `${details.expected.map((e) => `${e.keyType} ${e.fingerprint}`).join(' or ')} (from ${v.source}). `
    + `Connection refused. Only if you have confirmed the new key with the server's administrator, remove the old key on the relay host with: ${fix}`,
    { code: 'HOST_KEY_CHANGED', hostKey: { ...details, source: v.source, fix } });
}

/** ssh2 surfaces auth failures as generic errors. Turn them into useful copy. */
function translateSshError(err) {
  const msg = String(err?.message || err);
  if (err?.level === 'client-authentication' || /All configured authentication methods failed/i.test(msg)) {
    return new HttpError(401, 'Authentication failed. Check the username and credentials, and confirm the server accepts this method.');
  }
  if (err?.code === 'ENOTFOUND') return new HttpError(502, 'Host not found. Check the hostname.');
  if (err?.code === 'ECONNREFUSED') return new HttpError(502, 'Connection refused. Check the port and that sshd is running.');
  if (err?.code === 'ETIMEDOUT' || /Timed out/i.test(msg)) return new HttpError(504, 'Connection timed out. Check the host, port, and any firewall in between.');
  if (/no matching (host key|key exchange|cipher)/i.test(msg)) return new HttpError(502, `Cryptographic mismatch with the server: ${msg}`);
  if (/Cannot parse privateKey|Encrypted (private )?OpenSSH key|bad passphrase/i.test(msg)) {
    return new HttpError(400, 'The private key could not be read. If it is encrypted, supply the passphrase.');
  }
  return new HttpError(502, msg);
}

export function getSession(token) {
  const session = sessions.get(token);
  if (!session) throw new HttpError(401, 'Not connected. Sign in again.');
  session.touch();
  return session;
}

/**
 * Reap sessions nobody is using. Closing a tab sends no disconnect, so without
 * this the SSH connection, its port forwards and any sampler loops would live
 * until the relay restarts. "Nobody" means no open WebSocket *and* no HTTP call
 * for `idleMs`; an open desktop always holds the metrics socket, so it is never
 * reaped while visible.
 */
export function startIdleReaper(idleMs) {
  if (!(idleMs > 0)) return null;
  const sweep = () => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (session.openSockets === 0 && now - session.lastActivity > idleMs) {
        const { username, host, port } = session.meta;
        console.log(`[reaper] closing idle session ${username}@${host}:${port} (no activity for ${Math.round((now - session.lastActivity) / 1000)}s)`);
        session.destroy();
      }
    }
  };
  const timer = setInterval(sweep, Math.max(1000, Math.min(60_000, idleMs / 4)));
  timer.unref();
  return timer;
}

export function hasSession(token) {
  return sessions.has(token);
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ token: s.token, ...s.meta }));
}

/**
 * Describe only the tokens the caller already holds.
 *
 * This is deliberately not "list every session on the relay". A page restoring
 * after a refresh knows its own tokens; anything else asking has no business
 * learning that a session to a production host exists, let alone its token. So
 * the answer is a lookup keyed by what was supplied, unknown tokens simply
 * absent, and nothing in the response that the caller did not already name.
 */
export function describeSessions(tokens) {
  const out = {};
  for (const token of tokens) {
    const session = sessions.get(token);
    if (!session) continue;
    session.touch();
    out[token] = { token, ...session.meta };
  }
  return out;
}

export { MAX_SESSIONS };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    // Structured fields (code, hostKey, retryAfter) the browser acts on rather
    // than parsing the message.
    Object.assign(this, extra);
  }
}
