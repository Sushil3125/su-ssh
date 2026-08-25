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

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from 'ssh2';

/** @type {Map<string, Session>} */
const sessions = new Map();

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 10_000;

class Session {
  constructor(token, conn, meta) {
    this.token = token;
    this.conn = conn;
    this.meta = meta;          // host, port, username, authMethod, home, connectedAt
    this.sftp = null;
    this.channels = new Set(); // open shell channels, so we can clean up on disconnect
    this.forwards = new Map(); // id -> Forward, see port-forward.js
    this.remoteRouterAttached = false;
  }

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
    agentSocket,
  } = input;

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
      try {
        config.privateKey = readFileSync(privateKeyPath);
      } catch (err) {
        throw new HttpError(400, `Cannot read key file at ${privateKeyPath}: ${err.code || err.message}`);
      }
      if (passphrase) config.passphrase = passphrase;
      break;
    }
    case 'agent': {
      const sock = agentSocket || process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new HttpError(400, 'No SSH agent found. SSH_AUTH_SOCK is not set on the relay host.');
      }
      config.agent = sock;
      break;
    }
    case 'auto': {
      const sock = agentSocket || process.env.SSH_AUTH_SOCK;
      if (sock) config.agent = sock;
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
  const config = buildAuthConfig(input);
  const conn = new Client();

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    conn.on('ready', () => finish(resolve));
    conn.on('error', (err) => finish(reject, translateSshError(err)));
    conn.on('end', () => finish(reject, new HttpError(502, 'The server closed the connection during handshake.')));

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
  return session;
}

export function hasSession(token) {
  return sessions.has(token);
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({ token: s.token, ...s.meta }));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
