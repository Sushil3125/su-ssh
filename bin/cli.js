#!/usr/bin/env node
/**
 * cli.js — `npx su-ssh`.
 *
 * A thin front door: parse flags, turn them into the environment the relay
 * already reads, then start it. Keeping the server's configuration in env vars
 * rather than argv is what lets the same build run under systemd, Docker, or a
 * process manager with no CLI involved at all.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const argv = process.argv.slice(2);

function flag(names, fallback) {
  for (const name of names) {
    const at = argv.indexOf(name);
    if (at !== -1) return argv[at + 1] ?? true;
    const inline = argv.find((a) => a.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
  }
  return fallback;
}

const has = (...names) => names.some((n) => argv.includes(n));

if (has('-h', '--help')) {
  console.log(`
  ${pkg.name} ${pkg.version}
  ${pkg.description}

  Usage
    npx ${pkg.name} [options]

  Options
    -p, --port <port>     Port to listen on                    (default 3000)
    -H, --host <addr>     Address to bind                      (default 127.0.0.1)
        --jail <path>     Confine every file operation below this path
        --allow-public-forwards
                          Permit port forwards to bind non-loopback addresses
        --allowed-host <name[:port]>
                          Also answer to this Host header (repeatable; for
                          reverse proxies or LAN names)
        --idle-timeout <mins>
                          Close sessions with no open window after this
                          many idle minutes           (default 15, 0 = never)
        --tls-cert <file> Serve HTTPS with this certificate (PEM)
        --tls-key <file>  ...and this private key (PEM)
        --no-auth         Do not require the per-launch access link
                          (only behind an authenticating reverse proxy)
        --forget-host <host[:port]>
                          Remove the pinned host key for a server, then exit
    -h, --help            Show this message
    -v, --version         Print the version

  Notes
    Binding to 127.0.0.1 is the default on purpose. Without --tls-cert this
    app accepts SSH credentials over plain HTTP, so use TLS — or reach it with
    'ssh -L 3000:localhost:3000 you@host' — before exposing it to a network.
    Each launch prints a link carrying a one-time access key; open that link.
    Host keys are pinned in ~/.config/su-ssh/known_hosts.json (KNOWN_HOSTS_FILE).
`);
  process.exit(0);
}

if (has('-v', '--version')) {
  console.log(pkg.version);
  process.exit(0);
}

/** Every value of a repeatable flag, in both `--x v` and `--x=v` forms. */
function flagAll(name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

// Removing a pin is an operator action on the relay host, never something a
// browser can do: a changed key must not be two clicks away from being
// accepted by whoever happens to be looking at the warning.
const forget = flag(['--forget-host']);
if (forget !== undefined) {
  if (forget === true) {
    console.error('  --forget-host needs a server, e.g. --forget-host example.com or --forget-host example.com:2222');
    process.exit(2);
  }
  const { forgetHost, pinFilePath } = await import('../server/host-keys.js');
  // "host", "host:port", "[v6]:port" — a bare IPv6 address has several colons.
  const text = String(forget);
  const m = text.match(/^\[(.+)\](?::(\d+))?$/) || (text.split(':').length === 2 ? text.match(/^(.+):(\d+)$/) : null);
  const host = m ? m[1] : text;
  const hostPort = m && m[2] ? Number(m[2]) : 22;
  const removed = forgetHost(host, hostPort);
  console.log(removed
    ? `  Removed ${removed} pinned key${removed === 1 ? '' : 's'} for ${text} from ${pinFilePath()}.\n  The next connection will ask you to verify the new fingerprint.`
    : `  No pinned key for ${text} in ${pinFilePath()}. If the warning named ~/.ssh/known_hosts, use ssh-keygen -R instead.`);
  process.exit(0);
}

const port = flag(['-p', '--port'], process.env.PORT);
const host = flag(['-H', '--host'], process.env.BIND);
const jail = flag(['--jail'], process.env.ROOT_JAIL);

if (port) process.env.PORT = String(port);
if (host) process.env.BIND = String(host);
if (jail && jail !== true) process.env.ROOT_JAIL = String(jail);
if (has('--allow-public-forwards')) process.env.ALLOW_PUBLIC_FORWARDS = '1';

const extraHosts = flagAll('--allowed-host');
if (extraHosts.length) {
  process.env.ALLOWED_HOSTS = [process.env.ALLOWED_HOSTS, ...extraHosts].filter(Boolean).join(',');
}
const idle = flag(['--idle-timeout']);
if (idle !== undefined && idle !== true) process.env.SESSION_IDLE_MINUTES = String(idle);
const cert = flag(['--tls-cert']);
const tlsKey = flag(['--tls-key']);
if (cert && cert !== true) process.env.TLS_CERT = String(cert);
if (tlsKey && tlsKey !== true) process.env.TLS_KEY = String(tlsKey);
if (has('--no-auth')) process.env.NO_ACCESS_KEY = '1';

const bind = process.env.BIND || '127.0.0.1';
if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
  console.warn(`\n  ⚠  Binding to ${bind} exposes this to the network.`);
  if (!process.env.TLS_CERT) console.warn('     Credentials are posted over plain HTTP unless you pass --tls-cert/--tls-key or terminate TLS in front of it.');
  if (!process.env.ALLOWED_HOSTS) console.warn('     Browsers reaching it by a LAN name or IP also need --allowed-host <that name>.');
}

await import('../server/index.js');
