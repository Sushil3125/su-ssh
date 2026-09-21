/**
 * routes-fs.js
 * -----------------------------------------------------------------------------
 * Every filesystem operation runs over the SFTP subsystem, not over `ls`.
 *
 * Why that matters: `ls` output is a display format, not a data format. It
 * breaks on filenames containing spaces or newlines, changes shape with locale
 * and terminal width, and injects colour escapes when it thinks it is on a tty.
 * SFTP returns name/size/mode/mtime as typed fields over the same connection
 * and the same authentication, and no shell is involved — so a filename can
 * never be interpreted as a command.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { getSession, HttpError } from './ssh-session.js';
// Reused, not reimplemented: one sudo prefix builder and one sudo-error
// translator for the whole relay, so a fix to either reaches both editors.
import { privileged, translateSudo, q } from './services.js';
import { inlinePolicy, parseRange, SANDBOX_CSP } from './inline-policy.js';

export const fsRouter = express.Router();

/** Optional jail. Empty = full filesystem access, matching a normal SSH login. */
const ROOT_JAIL = process.env.ROOT_JAIL || '';

/** Files above this size open in the editor as a warning instead of content. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;      // 2 MB
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;  // 256 MB

/* ------------------------------------------------------------------ helpers */

/**
 * Resolve a client-supplied path to a real absolute path and check the jail.
 *
 * The order matters. `realpath` is called FIRST so that `..` segments and
 * symlinks are collapsed by the server, and only then is the prefix compared.
 * Checking the raw string first and resolving afterwards is the classic bug
 * that lets `~/link-to-root/etc/shadow` walk straight out of the jail.
 */
async function resolvePath(session, requested, { mustExist = true } = {}) {
  const sftp = await session.getSftp();
  const home = session.meta.home;

  let target = requested || '.';
  if (target === '~' || target.startsWith('~/')) target = path.posix.join(home, target.slice(1));
  if (!path.posix.isAbsolute(target)) target = path.posix.join(home, target);
  target = path.posix.normalize(target);

  let real = target;
  try {
    real = await sftpCall(sftp, 'realpath', target);
  } catch (err) {
    if (mustExist) throw toHttpError(err, target);
    // For a path being created, resolve the parent and re-append the basename.
    const parent = await sftpCall(sftp, 'realpath', path.posix.dirname(target)).catch(() => null);
    if (!parent) throw toHttpError(err, target);
    real = path.posix.join(parent, path.posix.basename(target));
  }

  if (ROOT_JAIL && real !== ROOT_JAIL && !real.startsWith(ROOT_JAIL.replace(/\/$/, '') + '/')) {
    throw new HttpError(403, 'That path is outside the permitted area.');
  }
  return real;
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function toHttpError(err, target) {
  const code = err?.code;
  // ssh2 SFTP status codes
  if (code === 2) return new HttpError(404, `Not found: ${target}`);
  if (code === 3) return new HttpError(403, `Permission denied: ${target}`);
  if (code === 4 && /exists/i.test(err.message || '')) return new HttpError(409, `Already exists: ${target}`);
  return new HttpError(500, err?.message || 'Filesystem error.');
}

function describeEntry(name, attrs, parentPath) {
  const mode = attrs.mode || 0;
  const isDir = (mode & 0o170000) === 0o040000;
  const isLink = (mode & 0o170000) === 0o120000;
  return {
    name,
    path: path.posix.join(parentPath, name),
    isDirectory: isDir,
    isSymlink: isLink,
    size: attrs.size ?? 0,
    mtime: (attrs.mtime ?? 0) * 1000,
    mode: (mode & 0o7777).toString(8).padStart(4, '0'),
    permissions: formatPermissions(mode),
    uid: attrs.uid,
    gid: attrs.gid,
    kind: isDir ? 'directory' : classify(name),
  };
}

function formatPermissions(mode) {
  const type = (mode & 0o170000) === 0o040000 ? 'd'
    : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let out = type;
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let b = 0; b < 3; b++) {
      out += (mode >> (shift + 2 - b)) & 1 ? bits[b] : '-';
    }
  }
  return out;
}

const TEXT_EXT = new Set(['txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'log', 'csv', 'tsv', 'sql', 'html', 'htm', 'css', 'scss',
  'xml', 'go', 'rs', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'hpp', 'service', 'gitignore', 'dockerfile', 'lock']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba']);

function classify(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'tar', '7z', 'rar', 'jar'].includes(ext)) return 'archive';
  return 'binary';
}

/* ------------------------------------------------------------------- routes */

/** GET /api/fs/list?path=~ */
fsRouter.get('/list', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const dir = await resolvePath(session, req.query.path);

    const raw = await sftpCall(sftp, 'readdir', dir);
    const entries = raw.map((e) => describeEntry(e.filename, e.attrs, dir));

    // readdir reports symlinks as symlinks. Follow them once so the UI can show
    // a link to a directory as enterable rather than as an unopenable file.
    await Promise.all(entries.filter((e) => e.isSymlink).map(async (e) => {
      try {
        const st = await sftpCall(sftp, 'stat', e.path);
        e.isDirectory = (st.mode & 0o170000) === 0o040000;
        e.kind = e.isDirectory ? 'directory' : classify(e.name);
        e.size = st.size ?? e.size;
      } catch { e.broken = true; }
    }));

    entries.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : (a.isDirectory ? -1 : 1));

    res.json({
      path: dir,
      parent: dir === '/' ? null : path.posix.dirname(dir),
      home: session.meta.home,
      entries,
    });
  } catch (err) { next(err); }
});

/** GET /api/fs/read?path=... — returns text for the editor */
fsRouter.get('/read', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.query.path);

    const stat = await sftpCall(sftp, 'stat', target);
    if (stat.size > MAX_EDIT_BYTES) {
      throw new HttpError(413, `File is ${formatBytes(stat.size)}. The editor opens files up to ${formatBytes(MAX_EDIT_BYTES)}. Download it instead.`);
    }

    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(target);
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('close', resolve);
    });

    const buf = Buffer.concat(chunks);
    // A NUL byte in the first 8 KB is the standard heuristic for "not text".
    const isBinary = buf.subarray(0, 8192).includes(0);
    res.json({
      path: target,
      size: stat.size,
      binary: isBinary,
      content: isBinary ? '' : buf.toString('utf8'),
    });
  } catch (err) { next(err); }
});

/**
 * Write a file the SSH user cannot write, by staging it over SFTP into their
 * own home and moving it into place with `install` under sudo.
 *
 * This is the same mechanism the unit-file editor uses (server/services.js
 * writeUnitFile) and it is reused rather than reinvented: sudo's stdin carries
 * the password and nothing else, so the file's first line can never be eaten by
 * a password reader, and the content never appears on a command line.
 *
 * The important difference is the whitelist — or rather its absence. The unit
 * editor pins the destination to systemd's directories, because there a path
 * parameter would turn a service editor into "write any file as root". Here
 * that IS the feature: this is a general-purpose text editor, and refusing
 * /etc/nginx/nginx.conf while allowing /etc/systemd/system/x.service would be
 * an arbitrary line that only pushes people back to a terminal.
 *
 * What keeps that honest is that it is not a privilege escalation. Reaching
 * this code already requires the per-launch access cookie, an allowed Host and
 * Origin, and a live session token — that is, someone who could equally type
 * `sudo tee` into the Terminal app two clicks away. The relay grants no
 * authority the SSH login does not already have: sudo still authenticates as
 * that account, still obeys the target's sudoers, and still needs the password
 * when the target asks for one. The paths are bounded by the same realpath +
 * ROOT_JAIL check as every other call in this file, so an operator who wants a
 * narrower blast radius sets ROOT_JAIL and it applies here too. The one thing
 * deliberately withheld is silence: an elevated write is never automatic — the
 * browser only reaches this branch after the user confirmed it (see the
 * "Write as root" confirm in public/js/apps.js).
 */
async function writeAsRoot(session, target, content, password) {
  const home = session.meta.home;
  const temp = `${home}/.su-ssh-edit-${randomBytes(6).toString('hex')}.tmp`;
  const sftp = await session.getSftp();

  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(temp, { mode: 0o600 });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(Buffer.from(content, 'utf8'));
  });

  try {
    const { prefix, stdin } = await privileged(session, 'system', password);

    // Both the "does it exist" test and the stat MUST run with privilege, in the
    // same privileged command as the install.
    //
    // Running them as the logged-in user is a security bug, not a style choice:
    // in a directory the user cannot traverse (/etc/ssl/private is 710
    // root:ssl-cert on stock Ubuntu) `test -e` answers "no" for a file that is
    // very much there, and the write then lands with the new-file defaults —
    // turning a 640 root:ssl-cert private key into a world-readable one. Doing
    // it in one shell also closes the window between the stat and the install.
    //
    // The paths go in as positional arguments so the script body needs no
    // nested quoting, and a filename can never be read as shell syntax.
    const preserveOrDefault = 'if [ -e "$2" ]; then '
      + 'install -D --mode="$(stat -c %a "$2")" --owner="$(stat -c %U "$2")" --group="$(stat -c %G "$2")" "$1" "$2"; '
      + 'else install -D -m 0644 -o root -g root "$1" "$2"; fi';

    const result = await session.exec(
      `${prefix}sh -c ${q(preserveOrDefault)} sh ${q(temp)} ${q(target)} 2>&1`,
      { stdin },
    );

    const sudoError = translateSudo(result);
    if (sudoError) throw sudoError;
    if (result.code !== 0) throw new HttpError(403, result.stdout.trim() || `Could not write ${target} as root.`);
  } finally {
    await session.exec(`rm -f ${q(temp)}`).catch(() => { /* best effort */ });
  }
}

/**
 * POST /api/fs/write { path, content, sudo?, password? }
 *
 * Without `sudo` this is an ordinary SFTP write. A permission failure comes
 * back flagged `needsSudo` rather than as a dead end, which is what lets the
 * editor offer the elevated retry instead of the bare toast it used to show.
 */
fsRouter.post('/write', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.body.path, { mustExist: false });
    const content = req.body.content ?? '';
    if (typeof content !== 'string') throw new HttpError(400, 'File content must be text.');

    if (req.body.sudo) {
      await writeAsRoot(session, target, content, req.body.password);
      console.log(`[fs] wrote ${target} as root`);
    } else {
      try {
        await new Promise((resolve, reject) => {
          const stream = sftp.createWriteStream(target);
          stream.on('error', reject);
          stream.on('close', resolve);
          stream.end(Buffer.from(content, 'utf8'));
        });
      } catch (err) {
        // SFTP status 3 is PERMISSION_DENIED; ssh2 also reports it by message.
        const denied = err?.code === 3 || /permission denied/i.test(err?.message || '');
        if (!denied) throw toHttpError(err, target);
        throw new HttpError(403, `Permission denied writing ${target} as ${session.meta.username}.`, { needsSudo: true });
      }
    }

    // A freshly root-owned file may be unreadable to the SSH user, so a failed
    // stat must not turn a successful save into an error.
    const stat = await sftpCall(sftp, 'stat', target).catch(() => null);
    res.json({ path: target, size: stat ? stat.size : Buffer.byteLength(content), savedAt: Date.now(), sudo: !!req.body.sudo });
  } catch (err) { next(err); }
});

/**
 * GET /api/fs/download?path=...[&inline=1] — streams bytes straight through.
 *
 * Two jobs, and both matter for the viewers:
 *
 * 1. What may render. The Content-Type and disposition come from
 *    inline-policy.js — an allowlist — and every response, inline or not,
 *    carries a script-less CSP sandbox and nosniff. See that file for why:
 *    anything rendered from here renders on the app's own origin.
 *
 * 2. Range. <video> and <audio> seek by asking for a byte range; without a 206
 *    the browser can only play from the start (Chrome will not even let you
 *    scrub). SFTP reads from an offset natively, so a range costs no more than
 *    the bytes in it — a seek to minute 40 of a 2 GB file reads from there.
 *    Supported: `a-b`, `a-` and `-n`, 416 for a range past the end, If-Range
 *    against Last-Modified. Multi-range requests get the whole file (200),
 *    which RFC 9110 allows and every media element accepts.
 *
 * `/download/<name>` is the same route: the trailing name is ignored (`path`
 * is authoritative) and exists only so the browser's PDF viewer and media
 * controls title and save the file by its real name instead of "download".
 */
fsRouter.get(['/download', '/download/:name'], async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.query.path);
    const stat = await sftpCall(sftp, 'stat', target);
    if ((stat.mode & 0o170000) === 0o040000) throw new HttpError(400, 'That is a folder, not a file.');

    const size = stat.size ?? 0;
    const filename = path.posix.basename(target);
    const { type, inline } = inlinePolicy(filename, {
      wantInline: req.query.inline === '1',
      fetchDest: req.get('Sec-Fetch-Dest') || '',
    });
    const lastModified = new Date((stat.mtime ?? 0) * 1000).toUTCString();

    res.setHeader('Content-Security-Policy', SANDBOX_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Last-Modified', lastModified);
    // The URL carries a session token; keep it out of shared caches.
    res.setHeader('Cache-Control', 'private, no-cache');

    const ifRange = req.get('If-Range');
    const range = (ifRange && ifRange !== lastModified) ? null : parseRange(req.get('Range'), size);

    if (range?.unsatisfiable) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }

    let start = 0, end = size - 1;
    if (range) {
      ({ start, end } = range);
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
    if (req.method === 'HEAD' || size === 0) return res.end();

    // `end` is inclusive in ssh2's read stream, exactly as in a Range header.
    const stream = sftp.createReadStream(target, { start, end });
    stream.on('error', (e) => { if (!res.headersSent) next(toHttpError(e, target)); else res.destroy(); });
    // A <video> abandons a request every time the user seeks; stop reading the
    // remote file when the browser stops listening, or every scrub leaks a read.
    res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
    stream.pipe(res);
  } catch (err) { next(err); }
});

/** Hard cap for /peek: text, JSON, CSV and hex previews never read past this. */
const MAX_PEEK_BYTES = 2 * 1024 * 1024;   // 2 MB

/**
 * GET /api/fs/peek?path=...&bytes=N — the first N bytes of a file, never more
 * than MAX_PEEK_BYTES, whatever its size. This is what keeps a preview of a
 * 40 GB log from pulling 40 GB through the relay into a browser tab.
 * Base64 in JSON so the same call serves the text viewers and the hex view.
 */
fsRouter.get('/peek', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.query.path);
    const stat = await sftpCall(sftp, 'stat', target);
    if ((stat.mode & 0o170000) === 0o040000) throw new HttpError(400, 'That is a folder, not a file.');

    const asked = Number.parseInt(req.query.bytes, 10);
    const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 64 * 1024, MAX_PEEK_BYTES);
    const size = stat.size ?? 0;
    const want = Math.min(limit, size);

    const chunks = [];
    if (want > 0) {
      await new Promise((resolve, reject) => {
        const stream = sftp.createReadStream(target, { start: 0, end: want - 1 });
        stream.on('data', (c) => chunks.push(c));
        stream.on('error', reject);
        stream.on('close', resolve);
      });
    }
    const buf = Buffer.concat(chunks).subarray(0, want);
    res.json({
      path: target,
      size,
      mtime: (stat.mtime ?? 0) * 1000,
      read: buf.length,
      limit,
      truncated: size > buf.length,
      binary: buf.subarray(0, 8192).includes(0),
      base64: buf.toString('base64'),
    });
  } catch (err) { next(err); }
});

/**
 * Archive formats we can list, by how the name ends. Longest suffix first so
 * `x.tar.gz` is never read as a bare `.gz`. The value is the flag GNU tar and
 * busybox tar both understand; `zip` goes to unzip instead.
 */
const ARCHIVES = [
  ['.tar.gz', '-z'], ['.tgz', '-z'], ['.tar.bz2', '-j'], ['.tbz2', '-j'], ['.tbz', '-j'],
  ['.tar.xz', '-J'], ['.txz', '-J'], ['.tar', ''], ['.zip', 'zip'], ['.jar', 'zip'],
];
const MAX_ARCHIVE_ENTRIES = 5000;

/**
 * GET /api/fs/archive?path=... — list (never extract) an archive by running
 * `unzip -l` or `tar -tv` ON THE REMOTE HOST.
 *
 * The same discipline as services.js: the path has already been through
 * realpath and the jail, the command is a fixed string chosen from the table
 * above by suffix, and the only client-derived value in it — the path — is
 * single-quoted by q(), so no filename can be read as shell syntax. The output
 * is capped by `head` so a million-file tarball cannot fill the relay's memory,
 * and `timeout` (when the host has it) stops a pathological .tar.xz from
 * holding an SSH channel forever.
 */
fsRouter.get('/archive', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const target = await resolvePath(session, req.query.path);
    const lower = target.toLowerCase();
    const match = ARCHIVES.find(([suffix]) => lower.endsWith(suffix));
    if (!match) throw new HttpError(400, 'Only .zip, .tar, .tar.gz/.tgz, .tar.bz2 and .tar.xz archives can be listed.');
    const [, flag] = match;
    const isZip = flag === 'zip';
    const tool = isZip ? 'unzip' : 'tar';

    const listCmd = isZip ? `unzip -l ${q(target)}` : `tar -tv${flag ? flag.slice(1) : ''}f ${q(target)}`;
    const cmd = `command -v ${tool} >/dev/null 2>&1 || { echo "__SU_SSH_NO_TOOL__"; exit 0; }; `
      + 'T=; command -v timeout >/dev/null 2>&1 && T="timeout 30"; '
      + `LC_ALL=C $T ${listCmd} 2>&1 | head -n ${MAX_ARCHIVE_ENTRIES + 20}`;
    const result = await session.exec(cmd);
    const out = result.stdout;
    if (out.includes('__SU_SSH_NO_TOOL__')) {
      throw new HttpError(422, `${tool} is not installed on this server, so the archive cannot be listed here. Download it instead.`);
    }

    const entries = isZip ? parseUnzip(out) : parseTar(out);
    if (!entries.length && out.trim() && !/^\s*Archive:/m.test(out)) {
      throw new HttpError(422, `${tool} could not read this archive: ${out.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    res.json({
      path: target,
      tool,
      entries: entries.slice(0, MAX_ARCHIVE_ENTRIES),
      truncated: entries.length > MAX_ARCHIVE_ENTRIES || out.split('\n').length > MAX_ARCHIVE_ENTRIES + 10,
    });
  } catch (err) { next(err); }
});

/**
 * `unzip -l`:
 *   Archive:  x.zip
 *     Length      Date    Time    Name
 *   ---------  ---------- -----   ----
 *         459  2026-09-21 23:43   README.md
 *   ---------                     -------
 * The name is the rest of the line, so names with spaces survive.
 */
export function parseUnzip(out) {
  const entries = [];
  let inBody = false;
  for (const line of out.split('\n')) {
    if (/^\s*-{3,}/.test(line)) { if (inBody) break; inBody = true; continue; }
    if (!inBody) continue;
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s{2,}(.*)$/.exec(line);
    if (!m) continue;
    const name = m[4];
    entries.push({ name, size: Number(m[1]), date: `${m[2]} ${m[3]}`, isDirectory: name.endsWith('/') });
  }
  return entries;
}

/**
 * `tar -tv` (GNU):     -rw-r--r-- user/group  459 2026-09-21 23:43 README.md
 *          (busybox):  -rw-r--r-- user/group  459 2026-09-21 23:43:10 README.md
 * Symlinks end in ` -> target`, hard links in ` link to target`.
 */
export function parseTar(out) {
  const entries = [];
  for (const line of out.split('\n')) {
    const m = /^([-dlhcbps][-rwxsStTl]{9}\S*)\s+(\S+)\s+(\d+)\s+(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d(?::\d\d)?)\s(.*)$/.exec(line);
    if (!m) continue;
    let name = m[6];
    let link = null;
    if (m[1][0] === 'l') {
      const i = name.indexOf(' -> ');
      if (i >= 0) { link = name.slice(i + 4); name = name.slice(0, i); }
    }
    entries.push({
      name, size: Number(m[3]), date: `${m[4]} ${m[5]}`, mode: m[1], owner: m[2],
      isDirectory: m[1][0] === 'd', link,
    });
  }
  return entries;
}

/** POST /api/fs/upload?path=/dest/file.bin — raw binary body */
fsRouter.post('/upload', express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }), async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.query.path, { mustExist: false });

    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(target);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(req.body);
    });
    res.json({ path: target, size: req.body.length });
  } catch (err) { next(err); }
});

/** POST /api/fs/mkdir { path } */
fsRouter.post('/mkdir', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.body.path, { mustExist: false });
    await sftpCall(sftp, 'mkdir', target);
    res.json({ path: target });
  } catch (err) { next(toHttpError(err, req.body.path)); }
});

/** POST /api/fs/rename { from, to } */
fsRouter.post('/rename', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const from = await resolvePath(session, req.body.from);
    const to = await resolvePath(session, req.body.to, { mustExist: false });
    await sftpCall(sftp, 'rename', from, to);
    res.json({ from, to });
  } catch (err) { next(err); }
});

/** POST /api/fs/delete { path } — recursive, done over SFTP so no shell runs */
fsRouter.post('/delete', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.body.path);
    if (target === '/' || target === session.meta.home) {
      throw new HttpError(400, 'Refusing to delete the root or home directory.');
    }
    await removeRecursive(sftp, target);
    res.json({ path: target, deleted: true });
  } catch (err) { next(err); }
});

async function removeRecursive(sftp, target) {
  const stat = await sftpCall(sftp, 'lstat', target);
  const isDir = (stat.mode & 0o170000) === 0o040000;
  if (!isDir) return sftpCall(sftp, 'unlink', target);

  const children = await sftpCall(sftp, 'readdir', target);
  for (const child of children) {
    await removeRecursive(sftp, path.posix.join(target, child.filename));
  }
  return sftpCall(sftp, 'rmdir', target);
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
