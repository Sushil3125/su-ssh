/** apps.js — Files, Editor, Terminal, Viewer. Each returns its window. */

import { api } from './api.js';
import { createWindow, escapeHtml } from './wm.js';
import { toast, contextMenu, confirmDialog, promptDialog, formatBytes, formatDate, GLYPH } from './ui.js';
import { forwardFormHtml, wireForwardForm, forwardRowHtml } from './forwards.js';

const basename = (p) => p.split('/').filter(Boolean).pop() || '/';
const dirname = (p) => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/* ═══════════════════════════════════════════════════════ file manager ═══ */

export function openFiles(startPath = '~') {
  const win = createWindow({ title: 'Files', icon: '📁', width: 780, height: 500, appId: 'files' });

  win.body.innerHTML = `
    <div class="tbar">
      <button class="tbar__btn" data-nav="back"    title="Back">←</button>
      <button class="tbar__btn" data-nav="forward" title="Forward">→</button>
      <button class="tbar__btn" data-nav="up"      title="Parent folder">↑</button>
      <button class="tbar__btn" data-nav="home"    title="Home">⌂</button>
      <input class="tbar__path" spellcheck="false" aria-label="Current path">
      <button class="tbar__btn" data-nav="refresh" title="Refresh">⟳</button>
      <button class="tbar__btn" data-nav="mkdir"   title="New folder">＋</button>
      <button class="tbar__btn" data-nav="upload"  title="Upload files">⬆</button>
    </div>
    <div class="filepane"><div class="filegrid"></div></div>
    <div class="statusbar"><span data-role="count">—</span><span data-role="detail"></span></div>
    <input type="file" multiple hidden data-role="filepicker">`;

  const pathInput = win.body.querySelector('.tbar__path');
  const grid = win.body.querySelector('.filegrid');
  const pane = win.body.querySelector('.filepane');
  const count = win.body.querySelector('[data-role="count"]');
  const detail = win.body.querySelector('[data-role="detail"]');
  const picker = win.body.querySelector('[data-role="filepicker"]');

  const history = [];
  let cursor = -1;
  let current = null;
  let selected = null;

  async function go(target, { push = true } = {}) {
    count.textContent = 'Loading…';
    try {
      const data = await api.list(target);
      current = data.path;
      pathInput.value = data.path;
      win.setSubtitle(`— ${basename(data.path)}`);

      if (push) {
        history.splice(cursor + 1);
        history.push(data.path);
        cursor = history.length - 1;
      }
      render(data);
      updateNav();
    } catch (err) {
      count.textContent = 'Failed';
      grid.innerHTML = `<div class="empty"><strong>Cannot open this folder</strong>${escapeHtml(err.message)}</div>`;
      toast(err.message, 'bad');
    }
  }

  function render(data) {
    selected = null;
    detail.textContent = '';
    grid.innerHTML = '';

    if (!data.entries.length) {
      grid.innerHTML = '<div class="empty"><strong>Nothing here yet</strong>Use ＋ to add a folder, or ⬆ to upload a file.</div>';
      count.textContent = '0 items';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of data.entries) {
      const el = document.createElement('div');
      el.className = 'fitem';
      el.tabIndex = 0;
      el.title = `${entry.name}\n${entry.permissions}  ${formatBytes(entry.size)}  ${formatDate(entry.mtime)}`;
      el.innerHTML = `
        <div class="fitem__glyph">${entry.broken ? '❓' : GLYPH[entry.kind] || GLYPH.binary}</div>
        <div class="fitem__name">${escapeHtml(entry.name)}</div>
        <div class="fitem__meta">${entry.isDirectory ? '' : formatBytes(entry.size)}</div>`;

      el.addEventListener('click', () => {
        grid.querySelectorAll('.fitem').forEach((n) => n.classList.remove('is-selected'));
        el.classList.add('is-selected');
        selected = entry;
        detail.textContent = `${entry.permissions}   ${formatBytes(entry.size)}   ${formatDate(entry.mtime)}`;
      });
      el.addEventListener('dblclick', () => open(entry));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(entry); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selected = entry;
        showEntryMenu(e.clientX, e.clientY, entry);
      });
      frag.appendChild(el);
    }
    grid.appendChild(frag);

    const dirs = data.entries.filter((e) => e.isDirectory).length;
    count.textContent = `${dirs} folder${dirs === 1 ? '' : 's'}, ${data.entries.length - dirs} file${data.entries.length - dirs === 1 ? '' : 's'}`;
  }

  function open(entry) {
    if (entry.isDirectory) return go(entry.path);
    if (entry.kind === 'image') return openViewer(entry.path);
    if (entry.kind === 'text' || entry.size < 512 * 1024) return openEditor(entry.path);
    window.open(api.downloadUrl(entry.path), '_blank');
  }

  function showEntryMenu(x, y, entry) {
    contextMenu(x, y, [
      { label: entry.isDirectory ? 'Open' : 'Open in editor', onClick: () => open(entry) },
      { label: 'Download', onClick: () => window.open(api.downloadUrl(entry.path), '_blank') },
      'separator',
      { label: 'Rename…', onClick: () => doRename(entry) },
      { label: 'Delete', danger: true, onClick: () => doDelete(entry) },
    ]);
  }

  async function doRename(entry) {
    const next = await promptDialog({
      title: `Rename ${entry.isDirectory ? 'folder' : 'file'}`,
      label: 'New name',
      value: entry.name,
      confirmLabel: 'Rename',
    });
    if (!next || next === entry.name) return;
    if (next.includes('/')) return toast('A name cannot contain a slash.', 'bad');
    try {
      await api.rename(entry.path, joinPath(dirname(entry.path), next));
      toast(`Renamed to ${next}`, 'good');
      go(current, { push: false });
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function doDelete(entry) {
    const ok = await confirmDialog({
      title: entry.isDirectory ? `Delete "${entry.name}" and its contents?` : `Delete "${entry.name}"?`,
      message: 'This removes it on the server and cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(entry.path);
      toast(`Deleted ${entry.name}`, 'good');
      go(current, { push: false });
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function uploadFiles(fileList) {
    for (const file of fileList) {
      try {
        toast(`Uploading ${file.name}…`);
        await api.upload(joinPath(current, file.name), await file.arrayBuffer());
        toast(`Uploaded ${file.name}`, 'good');
      } catch (err) { toast(`${file.name}: ${err.message}`, 'bad'); }
    }
    go(current, { push: false });
  }

  function updateNav() {
    win.body.querySelector('[data-nav="back"]').disabled = cursor <= 0;
    win.body.querySelector('[data-nav="forward"]').disabled = cursor >= history.length - 1;
    win.body.querySelector('[data-nav="up"]').disabled = current === '/';
  }

  win.body.querySelector('.tbar').addEventListener('click', async (e) => {
    const action = e.target.dataset.nav;
    if (!action) return;
    if (action === 'back' && cursor > 0) return go(history[--cursor], { push: false });
    if (action === 'forward' && cursor < history.length - 1) return go(history[++cursor], { push: false });
    if (action === 'up') return go(dirname(current));
    if (action === 'home') return go('~');
    if (action === 'refresh') return go(current, { push: false });
    if (action === 'upload') return picker.click();
    if (action === 'mkdir') {
      const name = await promptDialog({ title: 'New folder', label: 'Folder name', placeholder: 'projects', confirmLabel: 'Create' });
      if (!name) return;
      try {
        await api.mkdir(joinPath(current, name));
        toast(`Created ${name}`, 'good');
        go(current, { push: false });
      } catch (err) { toast(err.message, 'bad'); }
    }
  });

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(pathInput.value.trim());
  });

  picker.addEventListener('change', () => {
    if (picker.files.length) uploadFiles([...picker.files]);
    picker.value = '';
  });

  // Drag files from the host machine straight into the remote folder.
  pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.style.background = 'rgba(233,84,32,.08)'; });
  pane.addEventListener('dragleave', () => { pane.style.background = ''; });
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.style.background = '';
    if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
  });

  pane.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fitem')) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'New folder…', onClick: () => win.body.querySelector('[data-nav="mkdir"]').click() },
      { label: 'Upload files…', onClick: () => picker.click() },
      { label: 'Refresh', onClick: () => go(current, { push: false }) },
      'separator',
      { label: 'Open terminal here', onClick: () => openTerminal(current) },
    ]);
  });

  go(startPath);
  return win;
}

/* ═════════════════════════════════════════════════════════════ editor ═══ */

export function openEditor(filePath = null) {
  const win = createWindow({ title: 'Editor', icon: '📝', width: 720, height: 500, appId: 'editor' });

  win.body.innerHTML = `
    <div class="tbar">
      <input class="tbar__path" spellcheck="false" placeholder="~/notes.txt" aria-label="File path">
      <button class="tbar__btn" data-act="open">Open</button>
      <button class="tbar__btn" data-act="save">Save</button>
    </div>
    <textarea class="editor" spellcheck="false" placeholder="Type a path above and choose Open, or start writing and Save to create the file."></textarea>
    <div class="statusbar"><span data-role="state">Ready</span><span data-role="info"></span></div>`;

  const pathInput = win.body.querySelector('.tbar__path');
  const area = win.body.querySelector('.editor');
  const state = win.body.querySelector('[data-role="state"]');
  const info = win.body.querySelector('[data-role="info"]');
  let dirty = false;

  function setDirty(value) {
    dirty = value;
    state.textContent = value ? 'Unsaved changes' : 'Saved';
    win.setSubtitle(pathInput.value ? `— ${basename(pathInput.value)}${value ? ' •' : ''}` : '');
  }

  async function load(target) {
    if (!target) return;
    state.textContent = 'Opening…';
    try {
      const data = await api.read(target);
      if (data.binary) {
        state.textContent = 'Binary file';
        area.value = '';
        area.placeholder = 'This file is not text. Download it from Files instead.';
        return;
      }
      area.value = data.content;
      pathInput.value = data.path;
      info.textContent = `${formatBytes(data.size)} · ${data.content.split('\n').length} lines`;
      setDirty(false);
    } catch (err) {
      state.textContent = 'Failed';
      toast(err.message, 'bad');
    }
  }

  async function save() {
    const target = pathInput.value.trim();
    if (!target) return toast('Enter a file path first.', 'bad');
    state.textContent = 'Saving…';
    try {
      const res = await api.write(target, area.value);
      info.textContent = `${formatBytes(res.size)} · saved ${new Date(res.savedAt).toLocaleTimeString()}`;
      setDirty(false);
      toast(`Saved ${basename(target)}`, 'good');
    } catch (err) {
      state.textContent = 'Save failed';
      toast(err.message, 'bad');
    }
  }

  area.addEventListener('input', () => setDirty(true));
  win.body.querySelector('[data-act="open"]').addEventListener('click', () => load(pathInput.value.trim()));
  win.body.querySelector('[data-act="save"]').addEventListener('click', save);
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathInput.value.trim()); });

  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = area;
      area.value = area.value.slice(0, a) + '  ' + area.value.slice(b);
      area.selectionStart = area.selectionEnd = a + 2;
      setDirty(true);
    }
  });

  win.onClose = async () => {
    if (!dirty) return true;
    return confirmDialog({
      title: 'Discard unsaved changes?',
      message: `${pathInput.value || 'This file'} has edits that have not been written to the server.`,
      confirmLabel: 'Discard',
      danger: true,
    });
  };

  if (filePath) load(filePath);
  return win;
}

/* ═══════════════════════════════════════════════════════════ terminal ═══ */

export function openTerminal(cwd = null) {
  const win = createWindow({ title: 'Terminal', icon: '▶', width: 760, height: 440, appId: 'terminal' });
  win.body.innerHTML = '<div class="termhost"></div>';
  const host = win.body.querySelector('.termhost');

  const term = new Terminal({
    fontFamily: '"Ubuntu Mono", ui-monospace, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#1B1719', foreground: '#EDE7E9', cursor: '#E95420',
      selectionBackground: 'rgba(233,84,32,.35)',
      black: '#2E292C', red: '#C01C28', green: '#26A269', yellow: '#F5C211',
      blue: '#3584E4', magenta: '#9141AC', cyan: '#2AA1B3', white: '#DEDDDA',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // The first fit must wait a frame, or xterm measures a zero-height container
  // and every subsequent resize is computed from a wrong baseline.
  requestAnimationFrame(() => { fit.fit(); term.focus(); });

  const socket = new WebSocket(api.terminalUrl(term.cols, term.rows));
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    if (cwd) socket.send(JSON.stringify({ type: 'input', data: `cd ${shellQuote(cwd)} && clear\n` }));
  });

  socket.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'error') term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      if (msg.type === 'exit') term.writeln('\r\n\x1b[90m[session ended]\x1b[0m');
      return;
    }
    term.write(new Uint8Array(e.data));
  });

  socket.addEventListener('close', () => term.writeln('\r\n\x1b[90m[disconnected]\x1b[0m'));
  socket.addEventListener('error', () => term.writeln('\r\n\x1b[31m[connection error]\x1b[0m'));

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
  });

  win.onResize = () => {
    try {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch { /* window is mid-animation; the next resize will settle it */ }
  };

  const onWindowResize = () => win.onResize();
  window.addEventListener('resize', onWindowResize);

  win.onClose = () => {
    window.removeEventListener('resize', onWindowResize);
    socket.close();
    term.dispose();
  };

  return win;
}

/** Single-quote a path for the shell. Only used for the optional `cd` on open. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/* ═════════════════════════════════════════════════════════════ viewer ═══ */

export function openViewer(filePath) {
  const win = createWindow({ title: basename(filePath), icon: '🖼', width: 620, height: 480 });
  win.body.innerHTML = `<div class="viewer"><img alt="${escapeHtml(basename(filePath))}" src="${api.previewUrl(filePath)}"></div>
    <div class="statusbar"><span>${escapeHtml(filePath)}</span><span data-role="dims">—</span></div>`;

  const img = win.body.querySelector('img');
  img.addEventListener('load', () => {
    win.body.querySelector('[data-role="dims"]').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
  });
  img.addEventListener('error', () => {
    win.body.querySelector('.viewer').innerHTML = '<div class="empty"><strong>Cannot display this image</strong>The file may be corrupt or unreadable.</div>';
  });
  return win;
}

/* ═════════════════════════════════════════════════════ port forwarding ═══ */

/**
 * The Ports app. Forwards are created and closed against the live session, so
 * everything here takes effect immediately — no reconnect, no restart.
 *
 * The list refreshes on a timer rather than a push channel: the only thing
 * that changes on its own is the traffic counter, and two seconds of lag on a
 * byte count is not worth a second WebSocket.
 */
export function openForwards() {
  const win = createWindow({ title: 'Port forwarding', icon: '🔀', width: 720, height: 560, appId: 'ports' });

  win.body.innerHTML = `
    <div class="fwd-app">
      <div class="fwd-app__list" data-role="list"><p class="fwd-empty">No forwards yet.</p></div>
      <div class="fwd-app__new">
        <h3 class="fwd-app__h">New forward</h3>
        ${forwardFormHtml()}
      </div>
    </div>`;

  const list = win.body.querySelector('[data-role="list"]');
  let timer = null;

  async function refresh() {
    try {
      const { forwards } = await api.forwards();
      win.setSubtitle(`— ${forwards.filter((f) => f.status === 'active').length} active`);
      list.innerHTML = forwards.length
        ? forwards.map((f) => forwardRowHtml(f)).join('')
        : '<p class="fwd-empty">No forwards yet. Add one below — it opens straight away.</p>';
    } catch (err) {
      list.innerHTML = `<p class="fwd-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="remove"]');
    if (!btn) return;
    const id = btn.closest('.fwd-row').dataset.id;
    try {
      await api.closeForward(id);
      toast('Forward closed.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    refresh();
  });

  wireForwardForm(win.body.querySelector('.fwd-form'), async (spec) => {
    const fwd = await api.addForward(spec);
    toast(`Forward open: ${fwd.description}`, 'good');
    refresh();
  });

  refresh();
  timer = setInterval(refresh, 2000);
  win.onClose = () => { clearInterval(timer); };  // The forwards themselves keep running.
  return win;
}
