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
    -h, --help            Show this message
    -v, --version         Print the version

  Notes
    Binding to 127.0.0.1 is the default on purpose. This app accepts SSH
    credentials over plain HTTP and does not verify remote host keys, so put
    it behind TLS — or reach it with 'ssh -L 3000:localhost:3000 you@host' —
    before exposing it to a network.
`);
  process.exit(0);
}

if (has('-v', '--version')) {
  console.log(pkg.version);
  process.exit(0);
}

const port = flag(['-p', '--port'], process.env.PORT);
const host = flag(['-H', '--host'], process.env.BIND);
const jail = flag(['--jail'], process.env.ROOT_JAIL);

if (port) process.env.PORT = String(port);
if (host) process.env.BIND = String(host);
if (jail && jail !== true) process.env.ROOT_JAIL = String(jail);
if (has('--allow-public-forwards')) process.env.ALLOW_PUBLIC_FORWARDS = '1';

const bind = process.env.BIND || '127.0.0.1';
if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
  console.warn(`\n  ⚠  Binding to ${bind} exposes this to the network.`);
  console.warn('     Credentials are posted over plain HTTP unless you terminate TLS in front of it.');
}

await import('../server/index.js');
