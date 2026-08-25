/**
 * port-forward.js — SSH tunnelling: -L, -R and -D, created and torn down live.
 *
 * Every forward is owned by a Session, so disconnecting cannot leave a stray
 * listener bound to a port on the relay host. The three kinds:
 *
 *   local   (-L)  relay listens, traffic exits from the SSH server
 *   remote  (-R)  SSH server listens, traffic exits from the relay
 *   dynamic (-D)  relay listens as a SOCKS5 proxy, traffic exits from the SSH server
 *
 * "Traffic exits from X" is the whole point of the feature, and it is the part
 * people get backwards, so the UI repeats it in those words.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';

import { HttpError } from './ssh-session.js';

const VALID_KINDS = new Set(['local', 'remote', 'dynamic']);

/* ------------------------------------------------------------------ input */

function port(value, label, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) {
    throw new HttpError(400, `${label} must be a port number between ${allowZero ? 0 : 1} and 65535.`);
  }
  return n;
}

/**
 * Binding a relay listener to 0.0.0.0 hands the tunnel to anyone who can reach
 * this machine. That is sometimes exactly what you want, so it is allowed —
 * but only when the operator has opted in, the same way BIND works.
 */
function checkBind(addr) {
  const open = addr !== '127.0.0.1' && addr !== 'localhost' && addr !== '::1';
  if (open && process.env.ALLOW_PUBLIC_FORWARDS !== '1') {
    throw new HttpError(
      403,
      `Refusing to bind a forward to ${addr}. Start the relay with ALLOW_PUBLIC_FORWARDS=1 to allow non-loopback binds.`,
    );
  }
  return addr;
}

export function normaliseForward(input = {}) {
  const kind = String(input.kind || 'local');
  if (!VALID_KINDS.has(kind)) throw new HttpError(400, `Unknown forward type: ${kind}`);

  const spec = { kind, label: String(input.label || '').slice(0, 60) };

  if (kind === 'local' || kind === 'dynamic') {
    spec.bindAddr = checkBind(String(input.bindAddr || '127.0.0.1').trim() || '127.0.0.1');
    spec.bindPort = port(input.bindPort ?? 0, 'Listen port', { allowZero: true });
  }
  if (kind === 'local') {
    spec.destHost = String(input.destHost || '').trim();
    if (!spec.destHost) throw new HttpError(400, 'Destination host is required for a local forward.');
    spec.destPort = port(input.destPort, 'Destination port');
  }
  if (kind === 'remote') {
    // Empty string asks sshd to bind every interface; that is governed by the
    // server's GatewayPorts setting, not by us.
    spec.remoteAddr = String(input.remoteAddr ?? '127.0.0.1').trim();
    spec.remotePort = port(input.remotePort ?? 0, 'Remote listen port', { allowZero: true });
    spec.destHost = String(input.destHost || '127.0.0.1').trim();
    spec.destPort = port(input.destPort, 'Destination port');
  }
  return spec;
}

/* ------------------------------------------------------------- the record */

class Forward {
  constructor(session, spec) {
    this.id = randomBytes(8).toString('hex');
    this.session = session;
    this.spec = spec;
    this.server = null;        // local/dynamic only
    this.listenPort = null;
    this.status = 'starting';
    this.error = null;
    this.createdAt = new Date().toISOString();
    this.connections = 0;      // currently open
    this.total = 0;            // since creation
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.lastActivity = null;
  }

  toJSON() {
    return {
      id: this.id,
      ...this.spec,
      listenPort: this.listenPort,
      status: this.status,
      error: this.error,
      createdAt: this.createdAt,
      connections: this.connections,
      total: this.total,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      lastActivity: this.lastActivity,
      description: describe(this.spec, this.listenPort),
    };
  }

  /** Wire a browser-side socket to an SSH channel and keep the counters honest. */
  pipeWith(socket, stream) {
    this.connections += 1;
    this.total += 1;
    this.lastActivity = new Date().toISOString();

    socket.on('data', (d) => { this.bytesOut += d.length; this.lastActivity = new Date().toISOString(); });
    stream.on('data', (d) => { this.bytesIn += d.length; this.lastActivity = new Date().toISOString(); });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.connections = Math.max(0, this.connections - 1);
      try { socket.destroy(); } catch { /* already gone */ }
      try { stream.destroy?.() ?? stream.end(); } catch { /* already gone */ }
    };
    socket.on('error', finish);
    stream.on('error', finish);
    socket.on('close', finish);
    stream.on('close', finish);

    socket.pipe(stream).pipe(socket);
  }

  async stop() {
    this.status = 'stopped';
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    if (this.spec.kind === 'remote' && this.listenPort != null) {
      await new Promise((resolve) => {
        try {
          this.session.conn.unforwardIn(this.spec.remoteAddr, this.listenPort, () => resolve());
        } catch { resolve(); }
      });
    }
  }
}

export function describe(spec, listenPort) {
  const p = listenPort ?? spec.bindPort ?? spec.remotePort;
  if (spec.kind === 'local') {
    return `${spec.bindAddr}:${p} → (via server) → ${spec.destHost}:${spec.destPort}`;
  }
  if (spec.kind === 'remote') {
    return `server ${spec.remoteAddr || '*'}:${p} → (via relay) → ${spec.destHost}:${spec.destPort}`;
  }
  return `SOCKS5 on ${spec.bindAddr}:${p} → (via server) → anywhere`;
}

/* ---------------------------------------------------------------- starters */

/** -L: listen here, dial from the SSH server. */
function startLocal(forward) {
  const { spec, session } = forward;
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      session.conn.forwardOut(
        socket.remoteAddress || '127.0.0.1', socket.remotePort || 0,
        spec.destHost, spec.destPort,
        (err, stream) => {
          if (err) {
            forward.error = err.message;
            socket.destroy();
            return;
          }
          forward.pipeWith(socket, stream);
        },
      );
    });

    server.on('error', (err) => {
      forward.status = 'error';
      forward.error = listenError(err, spec.bindAddr, spec.bindPort);
      reject(new HttpError(409, forward.error));
    });

    server.listen(spec.bindPort, spec.bindAddr, () => {
      forward.server = server;
      forward.listenPort = server.address().port;
      forward.status = 'active';
      resolve(forward);
    });
  });
}

/** -R: ask sshd to listen, and dial the destination from this relay. */
function startRemote(forward) {
  const { spec, session } = forward;
  return new Promise((resolve, reject) => {
    session.conn.forwardIn(spec.remoteAddr, spec.remotePort, (err, boundPort) => {
      if (err) {
        forward.status = 'error';
        forward.error = `The server refused to listen on ${spec.remoteAddr || '*'}:${spec.remotePort}: ${err.message}`
          + ' (a non-loopback bind needs GatewayPorts on the server).';
        return reject(new HttpError(409, forward.error));
      }
      forward.listenPort = boundPort || spec.remotePort;
      forward.status = 'active';
      resolve(forward);
    });
  });
}

/**
 * -D: a minimal SOCKS5 proxy. Only CONNECT with no authentication, which is
 * what every browser and curl actually sends. Anything else is rejected
 * explicitly rather than left hanging.
 */
function startDynamic(forward) {
  const { spec, session } = forward;
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => handleSocks(forward, session, socket));

    server.on('error', (err) => {
      forward.status = 'error';
      forward.error = listenError(err, spec.bindAddr, spec.bindPort);
      reject(new HttpError(409, forward.error));
    });

    server.listen(spec.bindPort, spec.bindAddr, () => {
      forward.server = server;
      forward.listenPort = server.address().port;
      forward.status = 'active';
      resolve(forward);
    });
  });
}

function handleSocks(forward, session, socket) {
  let stage = 'greeting';
  let buf = Buffer.alloc(0);

  const fail = (reply) => {
    if (reply) { try { socket.write(reply); } catch { /* peer gone */ } }
    socket.destroy();
  };

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    if (stage === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) return fail();
      const nMethods = buf[1];
      if (buf.length < 2 + nMethods) return;
      const methods = buf.subarray(2, 2 + nMethods);
      buf = buf.subarray(2 + nMethods);
      if (!methods.includes(0x00)) return fail(Buffer.from([0x05, 0xff]));
      socket.write(Buffer.from([0x05, 0x00]));
      stage = 'request';
    }

    if (stage === 'request') {
      if (buf.length < 5) return;
      if (buf[0] !== 0x05) return fail();
      const cmd = buf[1];
      const atyp = buf[3];

      let host, offset;
      if (atyp === 0x01) {                     // IPv4
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        offset = 8;
      } else if (atyp === 0x03) {              // domain name
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else if (atyp === 0x04) {              // IPv6
        if (buf.length < 22) return;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
        host = parts.join(':');
        offset = 20;
      } else {
        return fail(socksReply(0x08));         // address type not supported
      }

      const dstPort = buf.readUInt16BE(offset);
      buf = buf.subarray(offset + 2);
      if (cmd !== 0x01) return fail(socksReply(0x07)); // command not supported

      stage = 'connecting';
      socket.removeListener('data', onData);
      socket.pause();

      session.conn.forwardOut(
        socket.remoteAddress || '127.0.0.1', socket.remotePort || 0,
        host, dstPort,
        (err, stream) => {
          if (err) {
            forward.error = `SOCKS: ${host}:${dstPort} — ${err.message}`;
            return fail(socksReply(0x05));     // connection refused
          }
          socket.write(socksReply(0x00));
          if (buf.length) stream.write(buf);   // pipelined bytes sent before our reply
          socket.resume();
          forward.pipeWith(socket, stream);
        },
      );
    }
  };

  socket.on('error', () => socket.destroy());
  socket.on('data', onData);
}

/** SOCKS5 reply with a 0.0.0.0:0 bound address — clients ignore it for CONNECT. */
function socksReply(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function listenError(err, addr, wanted) {
  if (err.code === 'EADDRINUSE') return `Port ${wanted} on ${addr} is already in use on the relay host.`;
  if (err.code === 'EACCES') return `Not allowed to bind port ${wanted} (ports below 1024 need privileges).`;
  if (err.code === 'EADDRNOTAVAIL') return `The relay host has no interface at ${addr}.`;
  return err.message;
}

/* -------------------------------------------------------------- public API */

export async function createForward(session, input) {
  const spec = normaliseForward(input);
  const forward = new Forward(session, spec);

  if (spec.kind === 'remote') ensureRemoteRouter(session);

  const start = { local: startLocal, remote: startRemote, dynamic: startDynamic }[spec.kind];
  await start(forward);

  session.forwards.set(forward.id, forward);
  return forward;
}

/**
 * ssh2 emits one 'tcp connection' event for the whole connection, not per
 * forwardIn. One router per session dispatches by bound port; registering a
 * listener per forward would leak handlers and double-accept.
 */
function ensureRemoteRouter(session) {
  if (session.remoteRouterAttached) return;
  session.remoteRouterAttached = true;

  session.conn.on('tcp connection', (info, accept, reject) => {
    const forward = [...session.forwards.values()]
      .find((f) => f.spec.kind === 'remote' && f.status === 'active' && f.listenPort === info.destPort);

    if (!forward) return reject();

    const stream = accept();
    const socket = net.connect(forward.spec.destPort, forward.spec.destHost, () => {
      forward.pipeWith(socket, stream);
    });
    socket.on('error', (err) => {
      forward.error = `Could not reach ${forward.spec.destHost}:${forward.spec.destPort} from the relay: ${err.message}`;
      try { stream.end(); } catch { /* already gone */ }
    });
  });
}

export function listForwards(session) {
  return [...session.forwards.values()].map((f) => f.toJSON());
}

export async function removeForward(session, id) {
  const forward = session.forwards.get(id);
  if (!forward) throw new HttpError(404, 'That forward is no longer running.');
  await forward.stop();
  session.forwards.delete(id);
  return forward.toJSON();
}

export async function stopAll(session) {
  for (const forward of [...session.forwards.values()]) {
    try { await forward.stop(); } catch { /* best effort during teardown */ }
  }
  session.forwards.clear();
}
