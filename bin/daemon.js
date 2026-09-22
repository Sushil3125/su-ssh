/**
 * daemon.js — running the relay in the background, and at startup.
 *
 * `su-ssh` on its own starts the relay detached and returns to the prompt;
 * `su-ssh --foreground` is the old attached behaviour (and what service
 * managers run). One managed instance per user:
 *
 *   state   $XDG_STATE_HOME/su-ssh/ (default ~/.local/state/su-ssh/, 0700)
 *           su-ssh.pid  JSON: pid, port, host, scheme, args, startedAt
 *           su-ssh.log  stdout+stderr of the detached relay; rotated at
 *                       start-up once it passes 5 MB (one old copy, .log.1)
 *   boot    systemd user unit (Linux, WSL with systemd), LaunchAgent (macOS)
 *
 * When a service manager owns the relay, start/stop/restart/logs go through
 * it rather than fighting it with a pidfile.
 *
 * Test hooks: SU_SSH_STATE_DIR (state directory), SU_SSH_SERVICE_NAME (unit /
 * agent name, default "su-ssh"), SU_SSH_START_TIMEOUT_MS.
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const READY_MARK = 'Web desktop relay listening on';

/** Flags that take a value, so their value is never mistaken for a subcommand. */
export const VALUE_FLAGS = new Set(['-p', '--port', '-H', '--host', '--jail', '--allowed-host',
  '--idle-timeout', '--tls-cert', '--tls-key', '--forget-host', '-n', '--lines']);
export const COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'logs', 'enable', 'disable']);

/** Environment worth carrying into a service unit: what the relay reads. */
const SERVICE_ENV = ['PORT', 'BIND', 'ROOT_JAIL', 'ALLOW_PUBLIC_FORWARDS', 'ALLOWED_HOSTS',
  'SESSION_IDLE_MINUTES', 'MAX_SESSIONS', 'TLS_CERT', 'TLS_KEY', 'NO_ACCESS_KEY',
  'SU_SSH_AUTH_FILE', 'SU_SSH_PROFILES_FILE', 'KNOWN_HOSTS_FILE', 'SSH_KNOWN_HOSTS', 'XDG_CONFIG_HOME'];

/* ------------------------------------------------------------------ argv */

/** Split argv into { command, args (flags to pass on), foreground }. */
export function parseArgs(argv) {
  let command = null;
  const args = [];
  let foreground = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { args.push(a); if (i + 1 < argv.length) args.push(argv[++i]); continue; }
    if (a === '-f' || a === '--foreground' || a === '--follow') {
      // -f is --foreground for the relay, --follow for `logs`.
      if (command === 'logs') args.push('--follow'); else foreground = true;
      continue;
    }
    if (!a.startsWith('-') && command === null) {
      if (!COMMANDS.has(a)) throw new Error(`Unknown command "${a}". Run su-ssh --help for the list.`);
      command = a;
      continue;
    }
    args.push(a);
  }
  return { command, args, foreground };
}

function argValue(args, names, fallback) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    for (const n of names) if (args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
  }
  return fallback;
}

/** Where the relay started with these flags will be reachable. */
export function endpointFor(args, env = process.env) {
  const port = Number(argValue(args, ['-p', '--port'], env.PORT)) || 3000;
  const host = argValue(args, ['-H', '--host'], env.BIND) || '127.0.0.1';
  const scheme = (argValue(args, ['--tls-cert'], env.TLS_CERT)) ? 'https' : 'http';
  const connectHost = ['0.0.0.0', '::', 'localhost'].includes(host) ? '127.0.0.1' : host;
  const shown = connectHost.includes(':') ? `[${connectHost}]` : connectHost;
  return { port, host, scheme, connectHost, url: `${scheme}://${shown}:${port}/` };
}

/* ----------------------------------------------------------------- paths */

export function stateDir(env = process.env) {
  if (env.SU_SSH_STATE_DIR) return env.SU_SSH_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'su-ssh');
}
const pidFile = () => path.join(stateDir(), 'su-ssh.pid');
const logFile = () => path.join(stateDir(), 'su-ssh.log');
export const serviceName = (env = process.env) => env.SU_SSH_SERVICE_NAME || 'su-ssh';

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
}

function rotateLog() {
  try {
    if (fs.statSync(logFile()).size > LOG_ROTATE_BYTES) fs.renameSync(logFile(), `${logFile()}.1`);
  } catch { /* no log yet */ }
}

/* ------------------------------------------------------------ processes */

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** The command line of a process, or null if it cannot be read. */
function commandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { /* not Linux */ }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A pid is ours only if it is alive AND still runs cli.js --foreground. */
function isRelay(pid) {
  if (!pid || !alive(pid)) return false;
  const cmd = commandLine(pid);
  return !!cmd && cmd.includes(CLI_PATH) && cmd.includes('--foreground');
}

function readPid() {
  try { return JSON.parse(fs.readFileSync(pidFile(), 'utf8')); } catch { return null; }
}

/** The detached instance, cleaning a stale pidfile on the way. */
function detachedInstance() {
  const rec = readPid();
  if (!rec) {
    if (fs.existsSync(pidFile())) fs.rmSync(pidFile(), { force: true });
    return null;
  }
  if (isRelay(rec.pid)) return rec;
  console.error(`  (removed a stale pidfile: PID ${rec.pid} is ${alive(rec.pid) ? 'not su-ssh' : 'gone'})`);
  fs.rmSync(pidFile(), { force: true });
  return null;
}

function tailLines(file, n) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1).slice(-n).join('\n');
  } catch { return ''; }
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 500 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatUptime(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return [d && `${d}d`, (d || h) && `${h}h`, (d || h || m) && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

/* -------------------------------------------------------------- detached */

async function startDetached(args) {
  ensureStateDir();
  rotateLog();
  const log = logFile();
  const offset = fs.existsSync(log) ? fs.statSync(log).size : 0;
  const fd = fs.openSync(log, 'a', 0o600);
  const ep = endpointFor(args);

  const child = spawn(process.execPath, [CLI_PATH, '--foreground', ...args], {
    detached: true, stdio: ['ignore', fd, fd], cwd: process.cwd(), env: process.env,
  });
  fs.closeSync(fd);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const rec = { pid: child.pid, port: ep.port, host: ep.host, scheme: ep.scheme, url: ep.url,
    args, cwd: process.cwd(), startedAt: new Date().toISOString(), log };
  fs.writeFileSync(pidFile(), JSON.stringify(rec, null, 2), { mode: 0o600 });

  const limit = Number(process.env.SU_SSH_START_TIMEOUT_MS) || 10_000;
  const deadline = Date.now() + limit;
  const fresh = () => { try { return fs.readFileSync(log, 'utf8').slice(offset); } catch { return ''; } };
  let ready = false;
  while (Date.now() < deadline && !exited) {
    // Listening means: our child said so, and the port answers. A port that
    // answers alone could be someone else's server.
    if (fresh().includes(READY_MARK) && await portOpen(ep.connectHost, ep.port)) { ready = true; break; }
    await sleep(150);
  }

  if (!ready) {
    if (!exited) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(pidFile(), { force: true });
    console.error(exited
      ? `\n  su-ssh failed to start (exit ${exited.code ?? exited.signal}). Last lines of ${log}:\n`
      : `\n  su-ssh did not start listening within ${limit / 1000}s; stopped it. Last lines of ${log}:\n`);
    console.error(fresh().split('\n').filter(Boolean).slice(-15).map((l) => `    ${l}`).join('\n') || '    (empty)');
    console.error('');
    return 1;
  }
  child.unref();

  // The banner (passphrase set-up instructions included) went to the log;
  // replay it so the person who started the relay actually sees it.
  console.log(fresh().replace(/\n+$/, ''));
  console.log(`\n  Running in the background: PID ${child.pid}`);
  console.log(`  Log: ${log}`);
  console.log('  Stop it with: su-ssh stop     (status: su-ssh status, logs: su-ssh logs -f)\n');
  return 0;
}

async function stopDetached(rec, { quiet = false } = {}) {
  try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 5000;
  while (alive(rec.pid) && Date.now() < deadline) await sleep(100);
  if (alive(rec.pid)) {
    try { process.kill(rec.pid, 'SIGKILL'); } catch { /* gone */ }
    while (alive(rec.pid)) await sleep(50);
    if (!quiet) console.log(`  PID ${rec.pid} ignored SIGTERM; killed it.`);
  }
  fs.rmSync(pidFile(), { force: true });
  if (!quiet) console.log(`  Stopped su-ssh (PID ${rec.pid}).`);
}

async function followFile(file, lines) {
  const initial = tailLines(file, lines);
  if (initial) process.stdout.write(`${initial}\n`);
  let pos = fs.existsSync(file) ? fs.statSync(file).size : 0;
  for (;;) {
    await sleep(500);
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size < pos) pos = 0; // rotated or truncated
    if (size > pos) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf);
      pos = size;
    }
  }
}

/* -------------------------------------------------------------- platform */

/**
 * What can start the relay at boot here. Everything it touches is injectable
 * so the WSL / no-systemd branches can be tested on any machine.
 */
export function detectPlatform({
  platform = process.platform, env = process.env,
  readFile = (f) => fs.readFileSync(f, 'utf8'), exists = fs.existsSync,
  run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' }),
} = {}) {
  if (platform === 'darwin') return { manager: 'launchd' };
  if (platform === 'win32') return { manager: null, reason: 'windows' };
  if (platform !== 'linux') return { manager: null, reason: 'unsupported', platform };
  let wsl = !!env.WSL_DISTRO_NAME;
  try { wsl = wsl || /microsoft|wsl/i.test(readFile('/proc/sys/kernel/osrelease')); } catch { /* fine */ }
  let pid1 = '';
  try { pid1 = readFile('/proc/1/comm').trim(); } catch { /* fine */ }
  const systemdBooted = exists('/run/systemd/system') || pid1 === 'systemd';
  if (!systemdBooted) return { manager: null, reason: wsl ? 'wsl-no-systemd' : 'no-systemd', wsl };
  const r = run('systemctl', ['--user', 'show-environment']);
  if (!r || r.status !== 0) return { manager: null, reason: 'no-user-manager', wsl, detail: (r?.stderr || r?.error?.message || '').trim() };
  return { manager: 'systemd', wsl };
}

export function explainNoManager(info) {
  switch (info.reason) {
    case 'wsl-no-systemd':
      return [
        'This is WSL without systemd, so there is nothing to start su-ssh at boot.',
        'Turn systemd on for this distro:',
        '  1. Add to /etc/wsl.conf (needs sudo):',
        '       [boot]',
        '       systemd=true',
        '  2. From Windows (PowerShell): wsl --shutdown   and reopen the distro.',
        '  3. Run su-ssh enable again.',
        'Or skip boot-start and just run su-ssh after opening WSL.',
      ].join('\n  ');
    case 'no-systemd':
      return 'systemd is not running here (PID 1 is not systemd), so su-ssh cannot register a service.\n'
        + '  Start it from your init system or a login script instead:  su-ssh   (detached)  or  su-ssh --foreground';
    case 'no-user-manager':
      return `systemd is running but the per-user manager is not reachable (systemctl --user failed${info.detail ? `: ${info.detail}` : ''}).\n`
        + '  This usually means no login session (e.g. su/sudo shell). Log in directly as this user and retry.';
    case 'windows':
      return 'Start-at-boot is not supported on native Windows.\n'
        + '  Run su-ssh inside WSL (with systemd) instead, or create a Task Scheduler task\n'
        + '  "At log on" that runs:  su-ssh --foreground';
    default:
      return `Start-at-boot is not supported on ${info.platform || 'this platform'}. Run su-ssh --foreground from your own service manager.`;
  }
}

export const inNpxCache = (p = CLI_PATH) => /[\\/]_npx[\\/]/.test(p);

/* ---------------------------------------------------------------- systemd */

const sysctl = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
const unitDir = () => path.join(os.homedir(), '.config', 'systemd', 'user');
const unitPath = () => path.join(unitDir(), `${serviceName()}.service`);

/** Quote one word for ExecStart= / Environment=. */
function sdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Relative paths in flags would resolve against the unit's working directory; pin them now. */
function absolutise(args) {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    for (const f of ['--jail', '--tls-cert', '--tls-key']) {
      if (out[i] === f && out[i + 1]) out[i + 1] = path.resolve(out[i + 1]);
      else if (out[i].startsWith(`${f}=`)) out[i] = `${f}=${path.resolve(out[i].slice(f.length + 1))}`;
    }
  }
  return out;
}

function serviceEnv() {
  return SERVICE_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]);
}

export function systemdUnit(args, env = serviceEnv()) {
  return [
    '# Written by `su-ssh enable`. Remove with `su-ssh disable`.',
    `# su-ssh-args: ${JSON.stringify(args)}`,
    '[Unit]',
    'Description=su-ssh browser desktop relay',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[process.execPath, CLI_PATH, '--foreground', ...args].map(sdQuote).join(' ')}`,
    ...env.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    'WorkingDirectory=%h',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function systemdArgs() {
  try {
    const m = fs.readFileSync(unitPath(), 'utf8').match(/^# su-ssh-args: (.*)$/m);
    return m ? JSON.parse(m[1]) : [];
  } catch { return []; }
}

function systemdState() {
  if (!fs.existsSync(unitPath())) return null;
  const r = sysctl('show', serviceName(), '-p', 'ActiveState', '-p', 'MainPID', '-p', 'UnitFileState', '-p', 'ActiveEnterTimestampMonotonic');
  const props = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  let uptimeMs = null;
  const since = Number(props.ActiveEnterTimestampMonotonic);
  if (since) uptimeMs = os.uptime() * 1000 - since / 1000; // both measured from boot
  return { active: props.ActiveState === 'active', state: props.ActiveState, pid: Number(props.MainPID) || null,
    enabled: props.UnitFileState === 'enabled', uptimeMs, args: systemdArgs() };
}

async function enableSystemd(args, info) {
  const detached = detachedInstance();
  if (detached) {
    console.log(`  Stopping the detached relay (PID ${detached.pid}) so the service can take its port.`);
    await stopDetached(detached, { quiet: true });
  }
  fs.mkdirSync(unitDir(), { recursive: true });
  fs.writeFileSync(unitPath(), systemdUnit(absolutise(args)));
  for (const step of [['daemon-reload'], ['enable', '--now', serviceName()], ['restart', serviceName()]]) {
    const r = sysctl(...step);
    if (r.status !== 0) {
      console.error(`  systemctl --user ${step.join(' ')} failed:\n    ${(r.stderr || r.stdout).trim()}`);
      return 1;
    }
  }
  const ep = endpointFor(args);
  const deadline = Date.now() + (Number(process.env.SU_SSH_START_TIMEOUT_MS) || 10_000);
  let up = false;
  while (Date.now() < deadline && !(up = await portOpen(ep.connectHost, ep.port))) await sleep(200);
  if (!up) {
    console.error(`  The service was enabled but is not listening on ${ep.url}. Recent log:\n`);
    spawnSync('journalctl', ['--user', '-u', serviceName(), '-n', '20', '--no-pager'], { stdio: 'inherit' });
    return 1;
  }
  const u = os.userInfo().username;
  console.log(`
  Enabled: systemd user service ${serviceName()} (${unitPath()})
  Running now at ${ep.url}
  It starts whenever you log in${info.wsl ? ' (on WSL: whenever the distro starts with your user)' : ''}.

  To start it at boot, before anyone logs in, allow your user manager to linger
  (one-time, needs root; su-ssh never runs sudo for you):
      sudo loginctl enable-linger ${u}

  Logs: su-ssh logs -f   (journalctl --user -u ${serviceName()})
  Undo: su-ssh disable
`);
  return 0;
}

function disableSystemd() {
  if (!fs.existsSync(unitPath())) { console.log(`  No systemd user service ${serviceName()} is installed.`); return 0; }
  sysctl('disable', '--now', serviceName());
  fs.rmSync(unitPath(), { force: true });
  sysctl('daemon-reload');
  sysctl('reset-failed', serviceName());
  console.log(`  Stopped and removed the systemd user service ${serviceName()}.`);
  return 0;
}

/* ---------------------------------------------------------------- launchd (untested) */

const uid = () => process.getuid?.() ?? 0;
const agentLabel = () => `io.github.sushil3125.${serviceName()}`;
const agentPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${agentLabel()}.plist`);
const agentLog = () => path.join(os.homedir(), 'Library', 'Logs', `${serviceName()}.log`);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchAgentPlist(args, env = serviceEnv()) {
  const argsXml = [process.execPath, CLI_PATH, '--foreground', ...args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const envXml = env.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(agentLabel())}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(agentLog())}</string>
  <key>StandardErrorPath</key><string>${xml(agentLog())}</string>
</dict>
</plist>
`;
}

function launchdLoaded() {
  if (!fs.existsSync(agentPath())) return null;
  const r = spawnSync('launchctl', ['print', `gui/${uid()}/${agentLabel()}`], { encoding: 'utf8' });
  const pid = Number((r.stdout || '').match(/\bpid = (\d+)/)?.[1]) || null;
  return { loaded: r.status === 0, active: !!pid, pid };
}

async function enableLaunchd(args) {
  const detached = detachedInstance();
  if (detached) await stopDetached(detached, { quiet: true });
  fs.mkdirSync(path.dirname(agentPath()), { recursive: true });
  fs.mkdirSync(path.dirname(agentLog()), { recursive: true });
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${agentLabel()}`]);
  fs.writeFileSync(agentPath(), launchAgentPlist(absolutise(args)));
  let r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, agentPath()], { encoding: 'utf8' });
  if (r.status !== 0) r = spawnSync('launchctl', ['load', '-w', agentPath()], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`  launchctl could not load ${agentPath()}:\n    ${(r.stderr || r.stdout).trim()}`); return 1; }
  console.log(`\n  Enabled: LaunchAgent ${agentLabel()} (${agentPath()})\n  It starts at login and is restarted if it exits.\n  Log: ${agentLog()}\n  Undo: su-ssh disable\n  (macOS support is untested; please report problems.)\n`);
  return 0;
}

function disableLaunchd() {
  if (!fs.existsSync(agentPath())) { console.log('  No LaunchAgent is installed.'); return 0; }
  const r = spawnSync('launchctl', ['bootout', `gui/${uid()}/${agentLabel()}`]);
  if (r.status !== 0) spawnSync('launchctl', ['unload', '-w', agentPath()]);
  fs.rmSync(agentPath(), { force: true });
  console.log(`  Unloaded and removed the LaunchAgent ${agentLabel()}.`);
  return 0;
}

/* --------------------------------------------------------------- managed */

/** Which service manager, if any, has the relay installed. */
function managed() {
  if (process.platform === 'darwin' && fs.existsSync(agentPath())) return { kind: 'launchd', ...launchdLoaded() };
  if (process.platform === 'linux' && fs.existsSync(unitPath())) return { kind: 'systemd', ...systemdState() };
  return null;
}

/* -------------------------------------------------------------- commands */

function printStatus() {
  const svc = managed();
  const boot = svc ? `enabled (${svc.kind === 'systemd' ? `systemd user service ${serviceName()}` : `LaunchAgent ${agentLabel()}`})` : 'not enabled';
  if (svc?.active) {
    const ep = endpointFor(svc.args || []);
    console.log(`  su-ssh is running (managed by ${svc.kind})`);
    console.log(`    PID      ${svc.pid ?? '?'}`);
    console.log(`    URL      ${ep.url}`);
    if (svc.uptimeMs != null) console.log(`    Uptime   ${formatUptime(svc.uptimeMs)}`);
    console.log(`    Logs     ${svc.kind === 'systemd' ? `journalctl --user -u ${serviceName()}` : agentLog()}`);
    console.log(`    At boot  ${boot}`);
    return 0;
  }
  const rec = detachedInstance();
  if (rec) {
    console.log('  su-ssh is running (detached)');
    console.log(`    PID      ${rec.pid}`);
    console.log(`    URL      ${rec.url}`);
    console.log(`    Uptime   ${formatUptime(Date.now() - Date.parse(rec.startedAt))}`);
    console.log(`    Log      ${rec.log}`);
    if (rec.args.length) console.log(`    Flags    ${rec.args.join(' ')}`);
    console.log(`    At boot  ${boot}`);
    return 0;
  }
  console.log(`  su-ssh is not running${svc ? ` (${svc.kind} service ${svc.state || 'inactive'})` : ''}.`);
  console.log(`    At boot  ${boot}`);
  console.log(`    Log      ${svc?.kind === 'systemd' ? `journalctl --user -u ${serviceName()}` : logFile()}`);
  return 3;
}

async function start(args) {
  const svc = managed();
  if (svc?.active || detachedInstance()) {
    console.log('  su-ssh is already running; not starting a second one.\n');
    printStatus();
    return 0;
  }
  if (svc?.kind === 'systemd') {
    if (args.length) console.warn('  The systemd service keeps the flags it was enabled with; to change them run su-ssh enable <flags>.');
    const r = sysctl('start', serviceName());
    if (r.status !== 0) { console.error(`  systemctl --user start ${serviceName()} failed:\n    ${r.stderr.trim()}`); return 1; }
    const ep = endpointFor(systemdArgs());
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await portOpen(ep.connectHost, ep.port)) { printStatus(); return 0; }
      if (!systemdState()?.active && sysctl('is-failed', serviceName()).status === 0) break;
      await sleep(200);
    }
    console.error('  The service did not start listening. Recent log:');
    spawnSync('journalctl', ['--user', '-u', serviceName(), '-n', '20', '--no-pager'], { stdio: 'inherit' });
    return 1;
  }
  if (svc?.kind === 'launchd') {
    spawnSync('launchctl', ['kickstart', `gui/${uid()}/${agentLabel()}`], { stdio: 'inherit' });
    return printStatus() === 0 ? 0 : 1;
  }
  return startDetached(args);
}

async function stop() {
  const svc = managed();
  if (svc?.kind === 'systemd' && svc.active) {
    const r = sysctl('stop', serviceName());
    console.log(r.status === 0 ? `  Stopped the systemd user service ${serviceName()} (still enabled at login; su-ssh disable to remove).` : `  systemctl --user stop failed: ${r.stderr.trim()}`);
    return r.status === 0 ? 0 : 1;
  }
  if (svc?.kind === 'launchd' && svc.active) {
    console.log('  The LaunchAgent keeps su-ssh alive (KeepAlive); stopping means unloading it. Use su-ssh disable.');
    return 1;
  }
  const rec = detachedInstance();
  if (!rec) { console.log('  su-ssh is not running.'); return 0; }
  await stopDetached(rec);
  return 0;
}

async function restart(args) {
  const svc = managed();
  if (svc?.kind === 'systemd') {
    const r = sysctl('restart', serviceName());
    if (r.status !== 0) { console.error(`  systemctl --user restart failed: ${r.stderr.trim()}`); return 1; }
    const ep = endpointFor(systemdArgs());
    for (const end = Date.now() + 10_000; Date.now() < end && !(await portOpen(ep.connectHost, ep.port));) await sleep(200);
    return printStatus() === 0 ? 0 : 1;
  }
  if (svc?.kind === 'launchd') {
    spawnSync('launchctl', ['kickstart', '-k', `gui/${uid()}/${agentLabel()}`], { stdio: 'inherit' });
    return 0;
  }
  const rec = detachedInstance();
  // No new flags: restart with the ones it was started with.
  const useArgs = args.length ? args : (rec?.args || []);
  if (rec) {
    await stopDetached(rec, { quiet: true });
    console.log(`  Stopped PID ${rec.pid}; starting again.`);
    if (rec.cwd) try { process.chdir(rec.cwd); } catch { /* keep ours */ }
  }
  return startDetached(useArgs);
}

async function logs(args) {
  const follow = args.includes('--follow');
  const lines = Number(argValue(args, ['-n', '--lines'], '50')) || 50;
  const svc = managed();
  if (svc?.kind === 'systemd') {
    const r = spawnSync('journalctl', ['--user', '-u', serviceName(), '-n', String(lines), ...(follow ? ['-f'] : ['--no-pager'])], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  const file = svc?.kind === 'launchd' ? agentLog() : logFile();
  if (!fs.existsSync(file)) { console.log(`  No log yet (${file}).`); return 0; }
  if (follow) await followFile(file, lines);
  const text = tailLines(file, lines);
  if (text) console.log(text);
  return 0;
}

async function enable(args) {
  if (inNpxCache()) {
    console.error(`  Not enabling: su-ssh is running from npx's cache (${path.dirname(path.dirname(CLI_PATH))}).
  npx may delete or replace that directory at any time, and a service pointing
  into it would fail at the next boot. Install it for good first, then retry:

      npm install -g su-ssh
      su-ssh enable ${args.join(' ')}`.trimEnd());
    return 1;
  }
  const info = detectPlatform();
  if (info.manager === 'systemd') return enableSystemd(args, info);
  if (info.manager === 'launchd') return enableLaunchd(args);
  console.error(`  ${explainNoManager(info)}`);
  return 1;
}

function disable() {
  if (process.platform === 'darwin') return disableLaunchd();
  if (process.platform === 'linux') {
    if (!fs.existsSync(unitPath())) { console.log(`  Start-at-boot is not enabled (no ${unitPath()}).`); return 0; }
    return disableSystemd();
  }
  console.log('  Start-at-boot is not supported on this platform, so there is nothing to disable.');
  return 0;
}

export async function runCommand(command, args) {
  switch (command) {
    case null:
    case 'start': return start(args);
    case 'stop': return stop();
    case 'restart': return restart(args);
    case 'status': return printStatus();
    case 'logs': return logs(args);
    case 'enable': return enable(args);
    case 'disable': return disable();
    default: throw new Error(`Unknown command ${command}`);
  }
}
