/**
 * services.js — systemd unit control over the existing SSH connection.
 *
 * Three rules shape everything below.
 *
 * 1. No client string is ever interpolated into a shell command unvalidated.
 *    Unit names are matched against systemd's own naming rules and then single
 *    quoted anyway; belt and braces, because this module runs commands as root.
 * 2. Output is parsed from machine-readable formats where systemd offers one
 *    (`show` key=value, `list-units --output=json`). `systemctl status` is a
 *    display format and is only ever passed through as text for humans to read.
 * 3. Privilege is explicit. The relay never assumes it can sudo, never caches a
 *    password, and tells the browser exactly which of the three worlds it is in
 *    (root already / passwordless sudo / password needed).
 */

import { randomBytes } from 'node:crypto';

import { HttpError } from './ssh-session.js';

/* ------------------------------------------------------------------ safety */

/** Single-quote for /bin/sh. The only safe way to pass an arbitrary argument. */
export const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * systemd unit names allow letters, digits, and `:-_.\@`. Anything else is not
 * a unit name, so rejecting it costs a legitimate user nothing.
 */
const UNIT_RE = /^[A-Za-z0-9:_.\\@-]+$/;

export function assertUnit(name) {
  const unit = String(name || '').trim();
  if (!unit || unit.length > 256 || !UNIT_RE.test(unit)) {
    throw new HttpError(400, `That is not a valid unit name: ${name}`);
  }
  return unit;
}

export function assertScope(scope) {
  const value = String(scope || 'system');
  if (value !== 'system' && value !== 'user') throw new HttpError(400, `Unknown scope: ${scope}`);
  return value;
}

/** Actions the UI is allowed to invoke, and whether each needs privilege. */
const ACTIONS = {
  start: 'Start', stop: 'Stop', restart: 'Restart', 'try-restart': 'Restart if running',
  reload: 'Reload', 'reload-or-restart': 'Reload or restart',
  enable: 'Enable at boot', disable: 'Disable at boot',
  mask: 'Mask', unmask: 'Unmask',
  'reset-failed': 'Clear failed state', freeze: 'Freeze', thaw: 'Thaw',
};

export const ACTION_LABELS = ACTIONS;

/* -------------------------------------------------------------- privilege */

/**
 * `sudo -n true` answers the only question that matters before showing a
 * password box: will sudo work without one? Cached per session because it
 * cannot change under us without a new login.
 */
export async function probePrivilege(session) {
  if (session.privilege) return session.privilege;

  const { stdout } = await session.exec('id -u; sudo -n true >/dev/null 2>&1 && echo SUDO_NP || echo SUDO_PW; command -v sudo >/dev/null && echo HAS_SUDO');
  const isRoot = stdout.trim().split('\n')[0] === '0';
  const hasSudo = stdout.includes('HAS_SUDO');
  const mode = isRoot ? 'root' : (!hasSudo ? 'none' : (stdout.includes('SUDO_NP') ? 'passwordless' : 'password'));

  session.privilege = { isRoot, hasSudo, mode };
  return session.privilege;
}

/**
 * Build the command prefix for a privileged call.
 *
 * `sudo -S -p ''` reads the password from stdin with no prompt text, so the
 * password never reaches the command line and never reaches the process list.
 * User-scope units are the user's own, so they are never elevated.
 */
export async function privileged(session, scope, password) {
  if (scope === 'user') return { prefix: '', stdin: null };

  const { mode } = await probePrivilege(session);
  if (mode === 'root') return { prefix: '', stdin: null };
  if (mode === 'passwordless') return { prefix: 'sudo -n ', stdin: null };
  if (mode === 'none') {
    throw new HttpError(403, 'This account is not root and sudo is not installed on the server.');
  }
  if (!password) {
    const err = new HttpError(401, 'This action needs the sudo password for this account.');
    err.needsPassword = true;
    throw err;
  }
  return { prefix: 'sudo -S -p "" ', stdin: `${password}\n` };
}

/** sudo's own failures are unmistakable, and deserve a better message than raw stderr. */
export function translateSudo(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/incorrect password attempt|Sorry, try again/i.test(text)) {
    const err = new HttpError(401, 'That sudo password was not accepted.');
    err.needsPassword = true;
    return err;
  }
  if (/is not in the sudoers file/i.test(text)) {
    return new HttpError(403, 'This account is not allowed to use sudo on that host.');
  }
  return null;
}

/* ------------------------------------------------------------- the basics */

/** Colour escapes and a pager would both corrupt the output we parse. */
const ENV = 'env SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat LC_ALL=C ';

const sc = (scope) => `${ENV}systemctl${scope === 'user' ? ' --user' : ''}`;

/* ------------------------------------------------------------------- list */

/**
 * The service list is the union of two different questions, because systemd
 * answers them separately:
 *
 *   list-units       — units the manager has loaded (running, or recently so)
 *   list-unit-files  — units installed on disk, including ones never loaded
 *
 * Showing only the first hides every stopped-and-not-loaded service, which is
 * exactly the one you are usually looking for when something will not start.
 */
export async function listServices(session, scope) {
  const [units, files] = await Promise.all([
    session.exec(`${sc(scope)} list-units --type=service --all --no-pager --no-legend --plain --output=json 2>/dev/null || ${sc(scope)} list-units --type=service --all --no-pager --no-legend --plain`),
    session.exec(`${sc(scope)} list-unit-files --type=service --no-pager --no-legend --plain`),
  ]);

  const map = new Map();

  for (const row of parseUnits(units.stdout)) map.set(row.unit, row);

  for (const line of files.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0].endsWith('.service')) continue;
    const [unit, state, preset] = parts;
    const existing = map.get(unit);
    if (existing) { existing.unitFileState = state; existing.preset = preset || ''; continue; }
    map.set(unit, {
      unit, load: 'stub', active: 'inactive', sub: 'dead', description: '',
      unitFileState: state, preset: preset || '', loaded: false,
    });
  }

  const services = [...map.values()]
    // Template units (`getty@.service`) are patterns, not runnable services.
    .filter((s) => !s.unit.endsWith('@.service'))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  return {
    scope,
    services,
    counts: {
      total: services.length,
      running: services.filter((s) => s.sub === 'running').length,
      failed: services.filter((s) => s.active === 'failed').length,
      enabled: services.filter((s) => s.unitFileState === 'enabled').length,
    },
  };
}

/**
 * Accepts either format. JSON arrived in systemd v249, so a 20.04 box (v245)
 * falls back to columns — where the description is the only field that may
 * contain spaces, and therefore the only one that must not be split.
 */
function parseUnits(stdout) {
  const text = stdout.trim();
  if (text.startsWith('[')) {
    try {
      return JSON.parse(text).map((u) => ({
        unit: u.unit, load: u.load, active: u.active, sub: u.sub,
        description: u.description || '', loaded: true, unitFileState: null, preset: '',
      }));
    } catch { /* fall through to the column parser */ }
  }

  const rows = [];
  for (const raw of text.split('\n')) {
    // Failed units carry a leading '●' bullet even with --plain.
    const line = raw.replace(/^[●•*x×\s]+/, '').trimEnd();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4 || !cols[0].endsWith('.service')) continue;
    rows.push({
      unit: cols[0], load: cols[1], active: cols[2], sub: cols[3],
      description: cols.slice(4).join(' '), loaded: true, unitFileState: null, preset: '',
    });
  }
  return rows;
}

/* ----------------------------------------------------------------- detail */

/**
 * `systemctl show -p A -p B` returns `Key=Value`, one per line, with no
 * quoting and no localisation — the only systemctl output actually meant for
 * programs. The property list is explicit so a unit with a multi-line
 * ExecStart= cannot desynchronise the parse.
 */
const PROPS = [
  'Id', 'Names', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState',
  'UnitFilePreset', 'FragmentPath', 'DropInPaths', 'SourcePath', 'MainPID', 'ExecMainPID',
  'ExecMainStatus', 'ExecMainStartTimestamp', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp',
  'StateChangeTimestamp', 'MemoryCurrent', 'MemoryPeak', 'TasksCurrent', 'TasksMax',
  'CPUUsageNSec', 'Restart', 'RestartUSec', 'Type', 'User', 'Group', 'WorkingDirectory',
  'Documentation', 'Requires', 'Wants', 'After', 'Before', 'TriggeredBy', 'Result',
  'StatusText', 'NRestarts', 'CanStart', 'CanStop', 'CanReload', 'NeedDaemonReload',
  'ConditionResult', 'AssertResult',
];

export async function showService(session, scope, unitName) {
  const unit = assertUnit(unitName);

  const [show, status] = await Promise.all([
    session.exec(`${sc(scope)} show ${q(unit)} ${PROPS.map((p) => `-p ${p}`).join(' ')} --no-pager`),
    // Human-readable, warts and all. Non-zero exit just means "not running".
    session.exec(`${sc(scope)} status ${q(unit)} --no-pager --full -n 12 2>&1 || true`),
  ]);

  const props = {};
  for (const line of show.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1);
  }

  if (!props.Id && !props.LoadState) {
    throw new HttpError(404, `systemd does not know a unit called ${unit}.`);
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v !== '[not set]' && n < Number.MAX_SAFE_INTEGER ? n : null;
  };

  return {
    unit,
    scope,
    props,
    summary: {
      id: props.Id || unit,
      description: props.Description || '',
      load: props.LoadState || '',
      active: props.ActiveState || '',
      sub: props.SubState || '',
      unitFileState: props.UnitFileState || '',
      mainPid: num(props.MainPID) || null,
      memory: num(props.MemoryCurrent),
      tasks: num(props.TasksCurrent),
      cpuNsec: num(props.CPUUsageNSec),
      restarts: num(props.NRestarts),
      since: props.ActiveEnterTimestamp || props.StateChangeTimestamp || '',
      fragmentPath: props.FragmentPath || '',
      dropIns: (props.DropInPaths || '').split(/\s+/).filter(Boolean),
      needsDaemonReload: props.NeedDaemonReload === 'yes',
      canStart: props.CanStart !== 'no',
      canStop: props.CanStop !== 'no',
      canReload: props.CanReload !== 'no',
      statusText: props.StatusText || '',
      result: props.Result || '',
    },
    statusOutput: status.stdout.replace(/\r/g, ''),
  };
}

/* ---------------------------------------------------------------- actions */

export async function runAction(session, scope, unitName, action, password) {
  if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, `Unsupported action: ${action}`);
  const unit = assertUnit(unitName);
  const { prefix, stdin } = await privileged(session, scope, password);

  const result = await session.exec(
    `${prefix}${sc(scope)} ${action} ${q(unit)} 2>&1`,
    { stdin },
  );

  const sudoError = translateSudo(result);
  if (sudoError) throw sudoError;

  const output = result.stdout.replace(/\r/g, '').trim();
  if (result.code !== 0) {
    throw new HttpError(409, output || `systemctl ${action} failed with exit code ${result.code}.`);
  }
  return { action, unit, output };
}

export async function daemonReload(session, scope, password) {
  const { prefix, stdin } = await privileged(session, scope, password);
  const result = await session.exec(`${prefix}${sc(scope)} daemon-reload 2>&1`, { stdin });

  const sudoError = translateSudo(result);
  if (sudoError) throw sudoError;
  if (result.code !== 0) throw new HttpError(409, result.stdout.trim() || 'daemon-reload failed.');
  return { output: result.stdout.trim() };
}

/* -------------------------------------------------------------- unit file */

/**
 * Where a unit file may be written. Narrow on purpose: this endpoint runs
 * under sudo, and a path parameter without a whitelist would be a general
 * "write any file as root" API rather than a service editor.
 */
const SYSTEM_DIRS = ['/etc/systemd/system/', '/run/systemd/system/', '/lib/systemd/system/', '/usr/lib/systemd/system/'];

function assertWritablePath(scope, filePath, home) {
  const p = String(filePath || '');
  if (!p.startsWith('/') || p.includes('..') || !p.endsWith('.conf') && !p.endsWith('.service')) {
    throw new HttpError(400, 'A unit file path must be absolute and end in .service or .conf.');
  }
  const allowed = scope === 'user'
    ? [`${home}/.config/systemd/user/`, '/etc/systemd/user/', '/lib/systemd/user/', '/usr/lib/systemd/user/']
    : SYSTEM_DIRS;

  if (!allowed.some((dir) => p.startsWith(dir))) {
    throw new HttpError(403, `Refusing to write outside the systemd unit directories. Allowed: ${allowed.join(', ')}`);
  }
  return p;
}

/** The drop-in systemd itself recommends: overrides survive a package upgrade. */
export function overridePath(scope, unit, home) {
  return scope === 'user'
    ? `${home}/.config/systemd/user/${unit}.d/override.conf`
    : `/etc/systemd/system/${unit}.d/override.conf`;
}

/**
 * Read a unit file. Base64 in transit so that a CRLF, a NUL, or a stray escape
 * sequence in the file cannot be mangled by the shell or the JSON layer.
 */
export async function readUnitFile(session, scope, unitName, which, password) {
  const unit = assertUnit(unitName);
  const detail = await showService(session, scope, unit);
  const home = session.meta.home;

  const path = which === 'override'
    ? overridePath(scope, unit, home)
    : (detail.summary.fragmentPath || '');

  if (!path) {
    throw new HttpError(404, `${unit} has no unit file on disk (it may be generated or transient).`);
  }

  // The exit code rides in the output because exec() reports the code of the
  // whole command line, and this one deliberately swallows base64's stderr.
  const read = async (prefix = '', stdin = null) => {
    const out = await session.exec(`${prefix}base64 -w0 ${q(path)} 2>/dev/null; echo "::code::$?"`, { stdin });
    const [payload, tail = ''] = out.stdout.split('::code::');
    return { encoded: payload.trim(), code: Number(tail.trim()) };
  };

  let result = await read();

  // Unit files are normally world readable; a private drop-in is not. Elevate
  // only when the plain read failed on a file that does exist.
  if (result.code !== 0 && scope === 'system') {
    const probe = await session.exec(`test -e ${q(path)} && echo EXISTS || echo MISSING`);
    if (probe.stdout.includes('EXISTS')) {
      const { prefix, stdin } = await privileged(session, scope, password);
      result = await read(prefix, stdin);
    }
  }

  const encoded = result.code === 0 ? result.encoded : '';
  const exists = encoded.length > 0 || result.code === 0;

  return {
    unit,
    scope,
    which: which === 'override' ? 'override' : 'fragment',
    path,
    exists,
    content: exists ? Buffer.from(encoded, 'base64').toString('utf8') : '',
    fragmentPath: detail.summary.fragmentPath,
    dropIns: detail.summary.dropIns,
    overridePathHint: overridePath(scope, unit, home),
    // A vendor file under /lib is replaced on the next package upgrade. Say so.
    vendor: SYSTEM_DIRS.slice(2).some((d) => path.startsWith(d)),
  };
}

/**
 * Write a unit file.
 *
 * The content goes up over SFTP to a private temp file in the user's own home,
 * and only then is moved into place with `install`. Piping the content through
 * sudo's stdin would work right up until the day sudo's password reader
 * swallowed the first line of the file — this way, sudo's stdin carries the
 * password and nothing else.
 */
export async function writeUnitFile(session, scope, unitName, filePath, content, password, { reload = true } = {}) {
  const unit = assertUnit(unitName);
  const home = session.meta.home;
  const target = assertWritablePath(scope, filePath, home);

  if (typeof content !== 'string') throw new HttpError(400, 'Unit file content must be text.');
  if (content.length > 512 * 1024) throw new HttpError(413, 'That unit file is implausibly large.');

  const temp = `${home}/.webssh-unit-${randomBytes(6).toString('hex')}.tmp`;
  const sftp = await session.getSftp();

  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(temp, { mode: 0o600 });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(Buffer.from(content, 'utf8'));
  });

  try {
    const { prefix, stdin } = await privileged(session, scope, password);
    // install -D creates the .d directory for a drop-in in the same step.
    const owner = scope === 'user' ? '' : '-o root -g root ';
    const result = await session.exec(
      `${prefix}install -D -m 0644 ${owner}${q(temp)} ${q(target)} 2>&1`,
      { stdin },
    );

    const sudoError = translateSudo(result);
    if (sudoError) throw sudoError;
    if (result.code !== 0) {
      throw new HttpError(403, result.stdout.trim() || `Could not write ${target}.`);
    }
  } finally {
    await session.exec(`rm -f ${q(temp)}`).catch(() => { /* best effort */ });
  }

  // A saved unit file that systemd has not re-read is a trap: the UI would
  // show the new content while the running service still uses the old one.
  let reloaded = false;
  if (reload) {
    await daemonReload(session, scope, password);
    reloaded = true;
  }

  return { unit, path: target, reloaded };
}

/* ------------------------------------------------------------------ extra */

/** A one-shot log fetch, for the times you want a snapshot rather than a stream. */
export async function journalSnapshot(session, scope, unitName, lines = 200) {
  const unit = assertUnit(unitName);
  const n = Math.min(Math.max(Number(lines) || 200, 1), 5000);
  const flag = scope === 'user' ? '--user --user-unit' : '-u';
  const result = await session.exec(
    `${ENV}journalctl ${flag} ${q(unit)} -n ${n} --no-pager -o short-iso 2>&1`,
  );
  return { unit, scope, lines: n, text: result.stdout.replace(/\r/g, '') };
}
