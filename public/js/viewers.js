/**
 * viewers.js — the Viewer app: one window, one file, the right renderer for it.
 *
 *   image     zoom (fit / 100% / wheel / buttons), pan, rotate, prev/next
 *             through the folder, checkerboard behind transparency
 *   pdf       the browser's own PDF viewer, in an iframe
 *   video     native <video>; seeking works because /api/fs/download
 *   audio     native <audio>;  answers Range requests with 206
 *   markdown  rendered by the small renderer below, raw on request
 *   json      pretty-printed, collapsible tree
 *   table     CSV / TSV as a table, row-capped
 *   archive   table of contents, listed on the remote host (never extracted)
 *   text      a capped plain-text preview, for files too big for the Editor
 *   hex       offset / hex / ASCII of the first 64 KB, for everything else
 *
 * THE SECURITY RULE, which everything here is built around: file content is
 * DATA. It reaches the page as text nodes (textContent, createTextNode) or as a
 * URL the browser loads under the relay's inline policy — never as markup.
 * There is no innerHTML of anything that came out of a file in this module;
 * the only innerHTML below is fixed chrome (icons, buttons) and escapeHtml()'d
 * paths. Images, SVG included, are shown only through <img>, which never runs
 * script. See server/inline-policy.js for the other half: what the relay is
 * willing to serve inline at all, and the sandbox CSP on every response.
 */

import { createWindow, escapeHtml } from './wm.js';
import { formatBytes, contextMenu } from './ui.js';
import { icon } from './icon.js';
import { requireSession } from './sessions.js';
import { openEditor } from './apps.js';

const basename = (p) => p.split('/').filter(Boolean).pop() || '/';
const dirname = (p) => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};

/* ═════════════════════════════════════════════════════════════ routing ═══ */

const EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  pdf: ['pdf'],
  video: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'],
  markdown: ['md', 'markdown', 'mdown', 'mkd'],
  json: ['json', 'geojson', 'webmanifest'],
  table: ['csv', 'tsv'],
};
const ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tbz', '.tar.xz', '.txz', '.tar', '.zip', '.jar'];

/** Which viewer renders this file name, or null when none is specific to it. */
export function viewerKind(name) {
  const lower = String(name).toLowerCase();
  if (ARCHIVE_SUFFIXES.some((s) => lower.endsWith(s))) return 'archive';
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  return null;
}

const KIND_ICON = {
  image: 'image', pdf: 'file-text', video: 'file-video', audio: 'file-music', markdown: 'file-text',
  json: 'file-braces', table: 'file-spreadsheet', archive: 'file-archive', text: 'file-text', hex: 'binary',
};

/** The Editor opens files up to this size (server/routes-fs.js MAX_EDIT_BYTES). */
const EDITOR_MAX = 2 * 1024 * 1024;
/** Text, JSON, CSV and Markdown previews read at most this much. */
const PREVIEW_MAX = 2 * 1024 * 1024;
const HEX_BYTES = 64 * 1024;
const TABLE_ROWS = 1000;
const JSON_NODES = 5000;

/**
 * Double-click, Enter and "Open" in Files and on the desktop all come here, so
 * the two places can never disagree about what a file opens in.
 *
 *   directory                    → the caller's own navigation (not handled here)
 *   a type with a viewer         → that viewer
 *   text the Editor can hold     → the Editor
 *   text too big for the Editor  → a capped text preview
 *   anything else                → sniffed: text goes to the Editor, binary to hex
 */
export async function openFile(entry) {
  const kind = viewerKind(entry.name);
  if (kind) return openViewer(entry.path, { mode: kind });
  if (entry.kind === 'text') {
    return entry.size > EDITOR_MAX ? openViewer(entry.path, { mode: 'text' }) : openEditor(entry.path);
  }
  return openViewer(entry.path, { mode: 'auto' });
}

/** "Open with → Viewer": the specific viewer if there is one; otherwise a
 *  read-only look — the text preview for text, hex for anything else. Unlike a
 *  double-click it never hands the file to the Editor: the user asked not to. */
export function openWithViewer(entry) {
  return openViewer(entry.path, { mode: viewerKind(entry.name) || 'sniff' });
}

/** Context-menu items shared by Files and the desktop icons. */
export function openWithItems(entry) {
  if (entry.isDirectory) return [];
  return [
    { label: 'Open with Viewer', icon: 'eye', onClick: () => openWithViewer(entry) },
    { label: 'Open with Editor', icon: 'file-pen', onClick: () => openEditor(entry.path) },
  ];
}

/* ═════════════════════════════════════════════════════════════ window ═══ */

export function openViewer(filePath, { mode = null } = {}) {
  const session = requireSession();
  const { api, toast } = session;
  let kind = mode || viewerKind(filePath) || 'auto';

  const win = createWindow({
    title: basename(filePath),
    iconName: KIND_ICON[kind] || 'eye',
    width: kind === 'audio' ? 520 : 760,
    height: kind === 'audio' ? 300 : 540,
    appId: 'viewer',
  });

  win.body.innerHTML = `
    <div class="tbar vw-tbar">
      <div class="vw-tools" data-role="tools"></div>
      <span class="vw-spacer"></span>
      <div class="vw-actions" data-role="actions"></div>
    </div>
    <div class="vw-body" data-role="body" tabindex="-1"></div>
    <div class="statusbar"><span data-role="left" class="vw-status-left"></span><span data-role="right"></span></div>`;
  win.body.classList.add('vw');

  const tools = win.body.querySelector('[data-role="tools"]');
  const actions = win.body.querySelector('[data-role="actions"]');
  const body = win.body.querySelector('[data-role="body"]');
  const left = win.body.querySelector('[data-role="left"]');
  const right = win.body.querySelector('[data-role="right"]');

  let path = filePath;
  let teardown = null;

  const say = (text) => { right.textContent = text; };

  function setPath(next) {
    path = next;
    left.textContent = next;
    left.title = next;
    win.setTitle(basename(next));
  }

  /** The buttons every viewer carries: Download always; Edit/raw where it makes sense. */
  function renderActions({ edit = false, raw = null } = {}) {
    actions.innerHTML = '';
    if (raw) {
      const b = button(raw.showing ? 'eye' : 'file-code', raw.showing ? 'Rendered' : 'View raw',
        raw.showing ? 'Show the rendered view' : 'Show the file as plain text');
      b.dataset.act = 'raw';
      b.setAttribute('aria-pressed', String(!!raw.showing));
      b.addEventListener('click', raw.toggle);
      actions.appendChild(b);
    }
    if (edit) {
      const b = button('file-pen', 'Edit', `Open ${basename(path)} in the Editor`);
      b.dataset.act = 'edit';
      b.addEventListener('click', () => openEditor(path));
      actions.appendChild(b);
    }
    const a = document.createElement('a');
    a.className = 'tbar__btn';
    a.dataset.act = 'download';
    a.href = api.downloadUrl(path);
    a.setAttribute('download', basename(path));
    a.title = `Download ${basename(path)}`;
    a.setAttribute('aria-label', a.title);
    a.innerHTML = `${icon('download', { size: 15 })}<span>Download</span>`;
    actions.appendChild(a);
  }

  function fail(title, message) {
    body.replaceChildren(emptyState(title, message));
    say('');
  }

  async function show(nextKind) {
    teardown?.();
    teardown = null;
    tools.replaceChildren();
    body.replaceChildren();
    body.className = 'vw-body';
    kind = nextKind;
    win.body.dataset.kind = kind;
    say('Loading…');
    try {
      if (kind === 'sniff') {
        const peek = await api.peek(path, 8192);
        return show(peek.binary ? 'hex' : 'text');
      }
      if (kind === 'auto') {
        // No viewer is specific to this name: look at the first 8 KB. Text (a
        // Makefile, a .bashrc) goes to the Editor, which is its viewer; text too
        // big for the Editor gets the capped preview; anything else is hex.
        const peek = await api.peek(path, 8192);
        if (peek.binary) return show('hex');
        if (peek.size > EDITOR_MAX) return show('text');
        openEditor(path);
        queueMicrotask(() => win.close());
        return;
      }
      const ctx = { api, toast, path, body, tools, say, renderActions, fail, setPath, win, session };
      teardown = await RENDERERS[kind](ctx) || null;
    } catch (err) {
      renderActions({ edit: kind !== 'hex' });
      fail(`Cannot show ${basename(path)}`, err.message);
    }
  }

  setPath(path);
  win.onClose = () => { teardown?.(); return true; };
  win.onForceClose = () => teardown?.();
  // `mode` is restored too, so an .md reopened "raw" or a sniffed hex view
  // comes back as what it was, not re-guessed.
  win.restore = () => ({ app: 'viewer', path, mode: kind === 'auto' || kind === 'sniff' ? null : kind });

  // Keyboard: the body is focusable, and the image viewer listens on it.
  body.addEventListener('contextmenu', (e) => {
    if (e.target.closest('video, audio, iframe, a, input')) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Download', icon: 'download', onClick: () => actions.querySelector('[data-act="download"]').click() },
      { label: 'Open in Editor', icon: 'file-pen', onClick: () => openEditor(path) },
    ]);
  });

  show(Object.hasOwn(RENDERERS, kind) || kind === 'sniff' ? kind : 'auto');
  return win;
}

/* ══════════════════════════════════════════════════════════ renderers ═══ */

const RENDERERS = {
  image: renderImage,
  pdf: renderPdf,
  video: (ctx) => renderMedia(ctx, 'video'),
  audio: (ctx) => renderMedia(ctx, 'audio'),
  markdown: (ctx) => renderTextual(ctx, 'markdown'),
  json: (ctx) => renderTextual(ctx, 'json'),
  table: (ctx) => renderTextual(ctx, 'table'),
  text: (ctx) => renderTextual(ctx, 'text'),
  archive: renderArchive,
  hex: renderHex,
};

/* ─────────────────────────────────────────────────────────── image ─── */

async function renderImage(ctx) {
  const { api, body, tools, say, renderActions, setPath } = ctx;
  renderActions();
  body.classList.add('vw-body--image');

  const stage = el('div', 'vw-stage');
  const img = document.createElement('img');
  img.className = 'vw-img';
  img.draggable = false;
  stage.appendChild(img);
  body.appendChild(stage);

  const btn = (name, label, act, text) => {
    const b = button(name, text || '', label);
    b.dataset.act = act;
    tools.appendChild(b);
    return b;
  };
  const prevBtn = btn('chevron-left', 'Previous image in this folder (Left arrow)', 'prev');
  const nextBtn = btn('chevron-right', 'Next image in this folder (Right arrow)', 'next');
  tools.appendChild(el('span', 'vw-sep'));
  btn('zoom-out', 'Zoom out (−)', 'zoom-out');
  const zoomLabel = el('span', 'vw-zoom');
  tools.appendChild(zoomLabel);
  btn('zoom-in', 'Zoom in (+)', 'zoom-in');
  btn('scan', 'Fit to window (0)', 'fit', 'Fit');
  const one = btn(null, 'Actual size (1)', 'actual', '100%');
  one.classList.add('vw-textbtn');
  tools.appendChild(el('span', 'vw-sep'));
  btn('rotate-ccw', 'Rotate left (Shift+R)', 'rotl');
  btn('rotate-cw', 'Rotate right (R)', 'rotr');

  let z = 1, px = 0, py = 0, rot = 0, fitted = true;
  let siblings = [];
  let size = null;

  const apply = () => {
    img.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) rotate(${rot}deg) scale(${z})`;
    zoomLabel.textContent = `${Math.round(z * 100)}%`;
    status();
  };
  const fitScale = () => {
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const [rw, rh] = rot % 180 ? [h, w] : [w, h];
    const box = stage.getBoundingClientRect();
    return Math.min(1, (box.width - 24) / rw, (box.height - 24) / rh);
  };
  const fit = () => { z = Math.max(0.01, fitScale()); px = py = 0; fitted = true; apply(); };
  const zoomTo = (next, cx = 0, cy = 0) => {
    next = Math.min(32, Math.max(0.02, next));
    // Keep the point under the cursor where it is: p' = c − (c − p)·z'/z.
    px = cx - (cx - px) * (next / z);
    py = cy - (cy - py) * (next / z);
    z = next;
    fitted = false;
    apply();
  };
  function status() {
    if (!img.naturalWidth) return;
    const pos = siblings.length > 1 ? `  ·  ${siblings.indexOf(ctx.path) + 1} of ${siblings.length}` : '';
    say(`${img.naturalWidth} × ${img.naturalHeight} px${size !== null ? `  ·  ${formatBytes(size)}` : ''}`
      + `  ·  ${Math.round(z * 100)}%${rot ? `  ·  ${rot}°` : ''}${pos}`);
  }

  function load(p) {
    ctx.path = p;
    setPath(p);
    renderActions();
    rot = 0;
    img.alt = basename(p);
    img.src = api.previewUrl(p);
    size = sizes.get(p) ?? null;
    say('Loading…');
  }
  const sizes = new Map();

  img.addEventListener('load', () => { fit(); body.dataset.loaded = '1'; });
  img.addEventListener('error', () => {
    stage.replaceChildren(emptyState('Cannot display this image',
      'The file may be corrupt, or in a format this browser does not decode. Download it instead.'));
    say('');
  });

  // Prev/next walk the images of the same folder, in the order Files shows them.
  api.list(dirname(ctx.path)).then((data) => {
    const imgs = data.entries.filter((e) => !e.isDirectory && viewerKind(e.name) === 'image');
    for (const e of imgs) sizes.set(e.path, e.size);
    siblings = imgs.map((e) => e.path);
    if (size === null) size = sizes.get(ctx.path) ?? null;
    syncNav();
    status();
  }).catch(() => syncNav());
  function syncNav() {
    const i = siblings.indexOf(ctx.path);
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i < 0 || i >= siblings.length - 1;
  }
  const step = (d) => {
    const i = siblings.indexOf(ctx.path);
    const next = siblings[i + d];
    if (i < 0 || !next) return;
    load(next);
    syncNav();
  };

  tools.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'prev') step(-1);
    if (act === 'next') step(1);
    if (act === 'zoom-in') zoomTo(z * 1.25);
    if (act === 'zoom-out') zoomTo(z / 1.25);
    if (act === 'fit') fit();
    if (act === 'actual') { px = py = 0; zoomTo(1); }
    if (act === 'rotr' || act === 'rotl') { rot = (rot + (act === 'rotr' ? 90 : 270)) % 360; if (fitted) fit(); else apply(); }
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = stage.getBoundingClientRect();
    const cx = e.clientX - box.left - box.width / 2;
    const cy = e.clientY - box.top - box.height / 2;
    zoomTo(z * Math.exp(-e.deltaY * 0.0015), cx, cy);
  }, { passive: false });

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, px, py };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    px = drag.px + e.clientX - drag.x;
    py = drag.py + e.clientY - drag.y;
    fitted = false;
    apply();
  });
  const endDrag = () => { drag = null; stage.classList.remove('is-dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => (fitted ? zoomTo(1) : fit()));

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const map = {
      ArrowLeft: () => step(-1), ArrowRight: () => step(1), '+': () => zoomTo(z * 1.25), '=': () => zoomTo(z * 1.25),
      '-': () => zoomTo(z / 1.25), 0: fit, 1: () => { px = py = 0; zoomTo(1); },
      r: () => tools.querySelector('[data-act="rotr"]').click(), R: () => tools.querySelector('[data-act="rotl"]').click(),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  };
  ctx.win.el.addEventListener('keydown', onKey);
  ctx.win.onResize = () => { if (fitted && img.naturalWidth) fit(); };
  const ro = new ResizeObserver(() => { if (fitted && img.naturalWidth) fit(); });
  ro.observe(stage);

  load(ctx.path);
  body.focus({ preventScroll: true });
  return () => { ro.disconnect(); ctx.win.el.removeEventListener('keydown', onKey); ctx.win.onResize = null; };
}

/* ───────────────────────────────────────────────────────────── pdf ─── */

/**
 * The browser's own PDF viewer, in an iframe. On the sandbox question — tested
 * in Chromium, see README "Viewing files safely":
 *
 *   - An iframe with the `sandbox` ATTRIBUTE (any token set, including
 *     "allow-same-origin") does not render a PDF at all: Chromium refuses to
 *     start its viewer in a sandboxed frame and shows a broken-page glyph.
 *   - A response carrying `Content-Security-Policy: sandbox` — no tokens, so
 *     no scripts and an opaque origin — DOES render in the built-in viewer.
 *
 * So the sandbox is applied by the relay, on the response, and this iframe has
 * no attribute. What can load here is also fixed by the relay: the URL is the
 * inline route, which only ever answers `application/pdf` for a .pdf and never
 * serves HTML or SVG as a document to anything.
 */
async function renderPdf(ctx) {
  const { api, body, say, renderActions, path } = ctx;
  renderActions();
  body.classList.add('vw-body--pdf');

  if (navigator.pdfViewerEnabled === false) {
    body.appendChild(noViewerNotice(api, path, 'This browser has no built-in PDF viewer'));
    say('No built-in PDF viewer');
    return null;
  }
  const frame = document.createElement('iframe');
  frame.className = 'vw-pdf';
  frame.title = `PDF: ${basename(path)}`;
  frame.referrerPolicy = 'no-referrer';
  frame.src = api.previewUrl(path);
  frame.addEventListener('load', () => { body.dataset.loaded = '1'; say('Shown by the browser’s PDF viewer'); });
  body.appendChild(frame);
  say('Loading…');
  return () => { frame.src = 'about:blank'; };
}

function noViewerNotice(api, path, title) {
  const box = emptyState(title,
    `${basename(path)} cannot be shown here. Download it and open it with a PDF reader.`);
  const a = document.createElement('a');
  a.className = 'btn btn--sm vw-dl';
  a.href = api.downloadUrl(path);
  a.setAttribute('download', basename(path));
  a.textContent = 'Download';
  box.appendChild(a);
  return box;
}

/* ─────────────────────────────────────────────────── video / audio ─── */

async function renderMedia(ctx, tag) {
  const { api, body, say, renderActions, path } = ctx;
  renderActions();
  body.classList.add(`vw-body--${tag}`);

  const media = document.createElement(tag);
  media.className = `vw-${tag}`;
  media.controls = true;
  media.preload = 'metadata';
  media.src = api.previewUrl(path);
  if (tag === 'audio') {
    const wrap = el('div', 'vw-audio-card');
    const glyph = el('div', 'vw-audio-glyph');
    glyph.innerHTML = icon('file-music', { size: 56, className: 'icon--thin' });
    const name = el('div', 'vw-audio-name');
    name.textContent = basename(path);
    wrap.append(glyph, name, media);
    body.appendChild(wrap);
  } else {
    body.appendChild(media);
  }

  const time = (s) => {
    if (!Number.isFinite(s)) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}`;
  };
  media.addEventListener('loadedmetadata', () => {
    body.dataset.loaded = '1';
    say(tag === 'video' && media.videoWidth
      ? `${media.videoWidth} × ${media.videoHeight}  ·  ${time(media.duration)}`
      : time(media.duration));
  });
  media.addEventListener('error', () => {
    const code = media.error?.code;
    const why = code === 4
      ? 'This browser cannot play this format or codec. Download it and use a desktop player.'
      : 'The file could not be read. It may be corrupt, or the connection dropped.';
    body.replaceChildren(emptyState(`Cannot play ${basename(path)}`, why));
    say('');
  });
  say('Loading…');
  // Stop the stream when the window goes: an <audio> left playing in a removed
  // node keeps pulling bytes over SSH.
  return () => { media.pause(); media.removeAttribute('src'); media.load(); };
}

/* ─────────────────────────────── markdown / json / table / text ─── */

async function renderTextual(ctx, kind) {
  const { api, body, say, renderActions, path } = ctx;
  const peek = await api.peek(path, PREVIEW_MAX);
  const bytes = base64Bytes(peek.base64);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (peek.truncated) {
    // Cut at the last newline so a half-read row or line is not shown as data.
    const nl = text.lastIndexOf('\n');
    if (nl > 0) text = text.slice(0, nl + 1);
  }
  const capNote = peek.truncated
    ? `Showing the first ${formatBytes(peek.read)} of ${formatBytes(peek.size)}`
    : formatBytes(peek.size);

  const canEdit = peek.size <= EDITOR_MAX;
  let raw = kind === 'text';

  const paint = () => {
    body.replaceChildren();
    body.classList.toggle('vw-body--doc', true);
    renderActions({ edit: canEdit, raw: kind === 'text' ? null : { showing: raw, toggle: () => { raw = !raw; paint(); } } });
    if (raw) {
      const pre = el('pre', 'vw-raw');
      pre.textContent = text;
      body.appendChild(pre);
      say(`${capNote}${kind === 'text' ? '  ·  preview, read-only' : '  ·  raw'}`);
      body.dataset.loaded = '1';
      return;
    }
    if (kind === 'markdown') {
      const doc = el('article', 'vw-md');
      doc.appendChild(renderMarkdown(text));
      body.appendChild(doc);
      say(capNote);
    } else if (kind === 'json') {
      paintJson(text, peek, capNote);
    } else if (kind === 'table') {
      paintTable(text, capNote);
    }
    body.dataset.loaded = '1';
  };

  function paintJson(src, info, note) {
    let value;
    try {
      value = JSON.parse(src);
    } catch (err) {
      const why = info.truncated
        ? `Only the first ${formatBytes(info.read)} of this ${formatBytes(info.size)} file was read, and JSON cannot be parsed in part.`
        : `It is not valid JSON: ${err.message}`;
      const box = emptyState('Cannot show this as a tree', `${why} Use View raw, or Download.`);
      body.appendChild(box);
      say(note);
      return;
    }
    const bar = el('div', 'vw-jsonbar');
    const expand = button('chevron-down', 'Expand all', 'Expand every level');
    const collapse = button('chevron-right', 'Collapse all', 'Collapse to the top level');
    bar.append(expand, collapse);
    const tree = el('div', 'vw-json');
    const budget = { left: JSON_NODES };
    tree.appendChild(jsonNode(null, value, 0, budget));
    body.append(bar, tree);
    expand.addEventListener('click', () => tree.querySelectorAll('details').forEach((d) => { d.open = true; }));
    collapse.addEventListener('click', () => tree.querySelectorAll('details').forEach((d, i) => { d.open = i === 0; }));
    say(`${note}${budget.left < 0 ? `  ·  first ${JSON_NODES} values shown` : ''}`);
  }

  function paintTable(src, note) {
    const delim = path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const { rows, more } = parseDelimited(src, delim, TABLE_ROWS + 1);
    if (!rows.length) {
      body.appendChild(emptyState('Nothing to show', 'This file has no rows.'));
      say(note);
      return;
    }
    const [head, ...data] = rows;
    const table = el('table', 'vw-table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(cell('th', '#'));
    for (const h of head) hr.appendChild(cell('th', h));
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    data.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.appendChild(cell('td', String(i + 1), 'vw-rownum'));
      for (let c = 0; c < Math.max(head.length, r.length); c++) tr.appendChild(cell('td', r[c] ?? ''));
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    const wrap = el('div', 'vw-tablewrap');
    wrap.appendChild(table);
    body.appendChild(wrap);
    const capped = more || peek.truncated;
    say(`${data.length} row${data.length === 1 ? '' : 's'}${capped ? ` shown (capped at ${TABLE_ROWS})` : ''}`
      + `  ·  ${head.length} column${head.length === 1 ? '' : 's'}  ·  ${note}`);
  }

  paint();
  return null;
}

function cell(tag, text, cls) {
  const c = document.createElement(tag);
  c.textContent = text;
  if (cls) c.className = cls;
  return c;
}

/**
 * RFC 4180-ish: quoted fields, doubled quotes, delimiters and newlines inside
 * quotes. Returns at most `limit` rows (header included), and whether there were more.
 */
export function parseDelimited(src, delim, limit) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && src[i + 1] === '\n') { i++; continue; }
    if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++;
      if (rows.length > limit) return { rows: rows.slice(0, limit), more: true };
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length > limit) return { rows: rows.slice(0, limit), more: true };
  return { rows, more: false };
}

/** One JSON value as DOM. Objects and arrays are <details>, so they collapse natively. */
function jsonNode(key, value, depth, budget) {
  budget.left--;
  const isObj = value !== null && typeof value === 'object';
  const keyEl = () => {
    if (key === null) return null;
    const k = el('span', 'vw-json__key');
    k.textContent = typeof key === 'number' ? `${key}` : JSON.stringify(key);
    return k;
  };
  if (!isObj) {
    const row = el('div', 'vw-json__row');
    const k = keyEl();
    if (k) row.append(k, document.createTextNode(': '));
    const v = el('span', `vw-json__${value === null ? 'null' : typeof value}`);
    v.textContent = typeof value === 'string' ? JSON.stringify(value) : String(value);
    row.appendChild(v);
    return row;
  }
  const arr = Array.isArray(value);
  const entries = arr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const d = document.createElement('details');
  d.className = 'vw-json__node';
  d.open = depth < 2;
  const s = document.createElement('summary');
  const k = keyEl();
  if (k) s.append(k, document.createTextNode(': '));
  const meta = el('span', 'vw-json__meta');
  meta.textContent = arr ? `[${entries.length}]` : `{${entries.length}}`;
  s.appendChild(meta);
  d.appendChild(s);
  const kids = el('div', 'vw-json__kids');
  for (const [ck, cv] of entries) {
    if (budget.left <= 0) {
      const more = el('div', 'vw-json__more');
      more.textContent = '… more not shown (View raw has everything read)';
      kids.appendChild(more);
      budget.left = -1;
      break;
    }
    kids.appendChild(jsonNode(ck, cv, depth + 1, budget));
  }
  d.appendChild(kids);
  return d;
}

/* ─────────────────────────────────────────────── markdown renderer ─── */

/**
 * A deliberately small Markdown renderer: headings, paragraphs, emphasis,
 * strong, inline code, fenced and indented code, block quotes, ordered and
 * unordered lists (nested by indentation), horizontal rules, simple pipe
 * tables, and links.
 *
 * Escape-first by construction: it never produces an HTML string. Every piece
 * of the file becomes a text node or the textContent of an element this code
 * created, so `<script>`, `<img onerror>` and friends in the source are shown
 * as the characters they are. Raw HTML in Markdown is simply not supported.
 * Links are kept only for http(s) and mailto; anything else (javascript:,
 * data:, relative paths into the relay) is shown as plain text. Images are not
 * fetched — they would be a remote request this offline-first app does not
 * make — and appear as "[image: alt]".
 */
export function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines);
}

function blocks(lines) {
  const frag = document.createDocumentFragment();
  let i = 0;
  const isBlank = (l) => /^\s*$/.test(l);
  const fence = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
  const listRe = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const hrRe = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const tableSep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    let m = fence.exec(line);
    if (m) {
      const close = m[1];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${close}\\s*$`).test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      const c = document.createElement('code');
      if (m[2]) c.dataset.lang = m[2];
      c.textContent = code.join('\n');
      pre.appendChild(c);
      frag.appendChild(pre);
      continue;
    }

    if (/^( {4}|\t)/.test(line)) {
      const code = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || isBlank(lines[i]))) code.push(lines[i++].replace(/^( {4}|\t)/, ''));
      while (code.length && isBlank(code[code.length - 1])) code.pop();
      const pre = document.createElement('pre');
      const c = document.createElement('code');
      c.textContent = code.join('\n');
      pre.appendChild(c);
      frag.appendChild(pre);
      continue;
    }

    m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const h = document.createElement(`h${m[1].length}`);
      h.appendChild(inline(m[2]));
      frag.appendChild(h);
      i++;
      continue;
    }

    if (hrRe.test(line)) { frag.appendChild(document.createElement('hr')); i++; continue; }

    if (/^\s{0,3}>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      const q = document.createElement('blockquote');
      q.appendChild(blocks(inner));
      frag.appendChild(q);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && tableSep.test(lines[i + 1])) {
      const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, '|'));
      const head = split(line);
      const aligns = split(lines[i + 1]).map((s) => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : ''));
      i += 2;
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      head.forEach((h, c) => { const th = document.createElement('th'); th.appendChild(inline(h)); if (aligns[c]) th.style.textAlign = aligns[c]; tr.appendChild(th); });
      thead.appendChild(tr);
      const tbody = document.createElement('tbody');
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        const r = split(lines[i++]);
        const row = document.createElement('tr');
        head.forEach((_, c) => { const td = document.createElement('td'); td.appendChild(inline(r[c] ?? '')); if (aligns[c]) td.style.textAlign = aligns[c]; row.appendChild(td); });
        tbody.appendChild(row);
      }
      table.append(thead, tbody);
      const wrap = document.createElement('div');
      wrap.className = 'vw-md__table';
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    m = listRe.exec(line);
    if (m) {
      const baseIndent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered && Number.parseInt(m[2], 10) !== 1) list.start = Number.parseInt(m[2], 10);
      while (i < lines.length) {
        const im = listRe.exec(lines[i]);
        if (!im || im[1].length !== baseIndent || /\d/.test(im[2]) !== ordered) break;
        const item = [im[3]];
        i++;
        // Continuation: indented deeper than the marker, or a lazy paragraph line.
        while (i < lines.length && !isBlank(lines[i])) {
          const sub = listRe.exec(lines[i]);
          if (sub && sub[1].length <= baseIndent) break;
          if (!sub && !/^\s/.test(lines[i]) && (fence.test(lines[i]) || /^#/.test(lines[i]))) break;
          item.push(lines[i].replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ''));
          i++;
        }
        const li = document.createElement('li');
        const hasBlocks = item.slice(1).some((l) => listRe.test(l) || fence.test(l));
        if (hasBlocks) li.appendChild(blocks(item));
        else li.appendChild(inline(item.join(' ')));
        list.appendChild(li);
        // A blank line between items keeps the list going if the next item follows.
        if (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length) {
          const nm = listRe.exec(lines[i + 1]);
          if (nm && nm[1].length === baseIndent) i++;
        }
      }
      frag.appendChild(list);
      continue;
    }

    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !fence.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i])
      && !hrRe.test(lines[i]) && !(para.length && listRe.test(lines[i]))) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { para.push(lines[i++].trim()); }
    const p = document.createElement('p');
    p.appendChild(inline(para.join('\n')));
    frag.appendChild(p);
  }
  return frag;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline spans, as DOM. Every character of `text` ends up in a text node. */
function inline(text) {
  const frag = document.createDocumentFragment();
  // Earliest match wins; each alternative is a group so we know which one hit.
  const re = /(\\[\\`*_{}[\]()#+\-.!|>~])|(`+)([\s\S]*?[^`])\2(?!`)|(\*\*|__)(?=\S)([\s\S]*?\S)\4|(\*|_)(?=\S)([\s\S]*?\S)\6|(!?)\[([^\]]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))*)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^\s>]+)>|(~~)(?=\S)([\s\S]*?\S)~~|(\n)/g;
  let last = 0, m;
  const text2 = (s) => frag.appendChild(document.createTextNode(s));
  while ((m = re.exec(text))) {
    if (m.index > last) text2(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) { text2(m[1].slice(1)); continue; }
    if (m[2]) { const c = document.createElement('code'); c.textContent = m[3].replace(/^ (.*) $/, '$1'); frag.appendChild(c); continue; }
    if (m[4]) {
      // Same rule as below: `__init__` and `a__b` are words, not emphasis.
      if (m[4] === '__' && (/\w/.test(text[m.index - 1] || ' ') || /\w/.test(text[re.lastIndex] || ' '))) {
        text2('_'); re.lastIndex = m.index + 1; last = re.lastIndex; continue;
      }
      const s = document.createElement('strong'); s.appendChild(inline(m[5])); frag.appendChild(s); continue; }
    if (m[6]) {
      // `snake_case_words` is not emphasis: an underscore run must sit at a word edge.
      const before = text[m.index - 1] || ' ';
      const after = text[re.lastIndex] || ' ';
      if (m[6] === '_' && (/\w/.test(before) || /\w/.test(after))) { text2(m[0][0]); re.lastIndex = m.index + 1; last = re.lastIndex; continue; }
      const e = document.createElement('em'); e.appendChild(inline(m[7])); frag.appendChild(e); continue;
    }
    if (m[9] !== undefined) {
      if (m[8] === '!') { text2(`[image: ${m[9] || m[10]}]`); continue; }
      if (SAFE_URL.test(m[10])) {
        const a = document.createElement('a');
        a.href = m[10];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.appendChild(inline(m[9] || m[10]));
        frag.appendChild(a);
      } else {
        // Unsafe or relative target: keep the words, drop the link.
        frag.appendChild(inline(m[9]));
      }
      continue;
    }
    if (m[11]) { const a = document.createElement('a'); a.href = m[11]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = m[11]; frag.appendChild(a); continue; }
    if (m[12]) { const d = document.createElement('del'); d.appendChild(inline(m[13])); frag.appendChild(d); continue; }
    if (m[14]) { frag.appendChild(document.createElement('br')); continue; }
  }
  if (last < text.length) text2(text.slice(last));
  return frag;
}

/* ─────────────────────────────────────────────────────────── archive ─── */

async function renderArchive(ctx) {
  const { api, body, say, renderActions, path } = ctx;
  renderActions();
  const data = await api.archive(path);
  body.classList.add('vw-body--doc');
  if (!data.entries.length) {
    body.appendChild(emptyState('This archive is empty', `${data.tool} lists no entries in ${basename(path)}.`));
    say('0 entries');
    body.dataset.loaded = '1';
    return null;
  }
  const hasMode = data.entries.some((e) => e.mode);
  const table = el('table', 'vw-table vw-table--archive');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['Name', 'Size', 'Modified', ...(hasMode ? ['Mode', 'Owner'] : [])]) hr.appendChild(cell('th', h));
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  let files = 0, total = 0;
  for (const e of data.entries) {
    const tr = document.createElement('tr');
    const name = cell('td', e.link ? `${e.name} → ${e.link}` : e.name, 'vw-arch__name');
    const glyph = document.createElement('span');
    glyph.className = 'vw-arch__icon';
    glyph.innerHTML = icon(e.isDirectory ? 'folder' : e.link ? 'link-2' : 'file-text', { size: 14 });
    name.prepend(glyph);
    tr.append(name, cell('td', e.isDirectory ? '' : formatBytes(e.size), 'vw-num'), cell('td', e.date));
    if (hasMode) tr.append(cell('td', e.mode || '', 'vw-mono'), cell('td', e.owner || ''));
    tbody.appendChild(tr);
    if (!e.isDirectory) { files++; total += e.size; }
  }
  table.append(thead, tbody);
  const wrap = el('div', 'vw-tablewrap');
  wrap.appendChild(table);
  body.appendChild(wrap);
  say(`${data.entries.length} entr${data.entries.length === 1 ? 'y' : 'ies'}${data.truncated ? ' shown (listing capped)' : ''}`
    + `  ·  ${files} file${files === 1 ? '' : 's'}, ${formatBytes(total)} uncompressed  ·  listed with ${data.tool} on the server`);
  body.dataset.loaded = '1';
  return null;
}

/* ─────────────────────────────────────────────────────────────── hex ─── */

async function renderHex(ctx) {
  const { api, body, say, renderActions, path } = ctx;
  renderActions({ edit: false });
  const peek = await api.peek(path, HEX_BYTES);
  const bytes = base64Bytes(peek.base64);
  body.classList.add('vw-body--doc');

  const pre = el('pre', 'vw-hex');
  pre.textContent = hexDump(bytes);
  body.appendChild(pre);
  say(peek.truncated
    ? `First ${formatBytes(peek.read)} of ${formatBytes(peek.size)}  ·  hex preview`
    : `${formatBytes(peek.size)}  ·  hex preview`);
  body.dataset.loaded = '1';
  return null;
}

/** Classic `hexdump -C` layout: offset, 16 bytes in two groups of 8, ASCII. */
export function hexDump(bytes) {
  const out = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    let hex = '';
    let asc = '';
    for (let j = 0; j < 16; j++) {
      if (j === 8) hex += ' ';
      if (j < row.length) {
        hex += row[j].toString(16).padStart(2, '0') + ' ';
        asc += row[j] >= 0x20 && row[j] < 0x7f ? String.fromCharCode(row[j]) : '.';
      } else hex += '   ';
    }
    out.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${asc}|`);
  }
  return out.join('\n') || '(empty file)';
}

/* ─────────────────────────────────────────────────────────── helpers ─── */

function base64Bytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

/** A toolbar button: icon + optional text; `label` is its accessible name and tooltip. */
function button(iconName, text, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tbar__btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `${iconName ? icon(iconName, { size: 15 }) : ''}${text ? `<span>${escapeHtml(text)}</span>` : ''}`;
  return b;
}

function emptyState(title, message) {
  const box = el('div', 'empty');
  const s = document.createElement('strong');
  s.textContent = title;
  box.append(s, document.createTextNode(message));
  return box;
}
