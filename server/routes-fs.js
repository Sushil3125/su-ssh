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
import express from 'express';
import { getSession, HttpError } from './ssh-session.js';

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

function classify(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar'].includes(ext)) return 'archive';
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

/** POST /api/fs/write { path, content } */
fsRouter.post('/write', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.body.path, { mustExist: false });

    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(target);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(Buffer.from(req.body.content ?? '', 'utf8'));
    });

    const stat = await sftpCall(sftp, 'stat', target);
    res.json({ path: target, size: stat.size, savedAt: Date.now() });
  } catch (err) { next(err); }
});

/** GET /api/fs/download?path=... — streams bytes straight through */
fsRouter.get('/download', async (req, res, next) => {
  try {
    const session = getSession(req.sessionToken);
    const sftp = await session.getSftp();
    const target = await resolvePath(session, req.query.path);
    const stat = await sftpCall(sftp, 'stat', target);

    const inline = req.query.inline === '1';
    const filename = path.posix.basename(target);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', guessMime(filename));

    const stream = sftp.createReadStream(target);
    stream.on('error', (e) => { if (!res.headersSent) next(e); else res.destroy(); });
    stream.pipe(res);
  } catch (err) { next(err); }
});

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

function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    avif: 'image/avif', pdf: 'application/pdf', json: 'application/json',
    txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
