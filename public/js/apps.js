/** apps.js — Files, Editor, Terminal, Viewer. Each returns its window. */

import { createWindow, escapeHtml } from './wm.js';
import { contextMenu, confirmDialog, promptDialog, promptSecret, formatBytes, formatDate, fileIcon } from './ui.js';
import { icon, iconButton } from './icon.js';
import { forwardFormHtml, wireForwardForm, forwardRowHtml, describeSpec } from './forwards.js';
import { requireSession, hostPhrase, dangerOpts, markActivity, markDropped } from './sessions.js';
import {
  profileFor, forwardKeyOf, forgetSavedForward, loadProfiles, onProfilesChange,
} from './profiles.js';
import { copySelection, pasteFromClipboard, hintOnce } from './keyboard.js';

const basename = (p) => p.split('/').filter(Boolean).pop() || '/';
const dirname = (p) => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/**
 * A toolbar button. `title` alone is a tooltip — mouse-only, delayed and not
 * reliably announced — so every one of these carries an identical aria-label.
 */
const tbarBtn = (name, label, nav) =>
  `<button type="button" class="tbar__btn" data-nav="${nav}" title="${label}" aria-label="${label}">`
  + `${icon(name, { size: 16 })}</button>`;

/* ═══════════════════════════════════════════════════════ file manager ═══ */

export function openFiles(startPath = '~') {
  // Captured once, here. Every call below is bound to the session this window
  // was opened on, whatever the user switches to afterwards.
  const session = requireSession();
  const { api, toast } = session;
  const win = createWindow({ title: 'Files', iconName: 'folder', width: 780, height: 500, appId: 'files' });

  win.body.innerHTML = `
    <div class="tbar">
      ${tbarBtn('arrow-left',  'Back',          'back')}
      ${tbarBtn('arrow-right', 'Forward',       'forward')}
      ${tbarBtn('arrow-up',    'Parent folder', 'up')}
      ${tbarBtn('house',       'Home',          'home')}
      <input class="tbar__path" spellcheck="false" aria-label="Current path">
      ${tbarBtn('refresh-cw', 'Refresh',      'refresh')}
      ${tbarBtn('plus',       'New folder',   'mkdir')}
      ${tbarBtn('upload',     'Upload files', 'upload')}
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
      grid.innerHTML = '<div class="empty"><strong>Nothing here yet</strong>Use New folder to add a folder, or Upload files to add a file.</div>';
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
        <div class="fitem__glyph" aria-hidden="true">${fileIcon(entry, 30)}</div>
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
      title: `Rename ${entry.isDirectory ? 'folder' : 'file'} on ${session.label}`,
      message: `${entry.path} on ${hostPhrase(session)}`,
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
      title: entry.isDirectory
        ? `Delete "${entry.name}" and its contents on ${session.label}?`
        : `Delete "${entry.name}" on ${session.label}?`,
      message: `This removes ${entry.path} on ${hostPhrase(session)} and cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      ...dangerOpts(session, { typed: true }),
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
    // closest(): the click lands on the <svg> inside an icon button.
    const action = e.target.closest('[data-nav]')?.dataset.nav;
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

  // What a refresh needs to put this window back: the folder it is looking at.
  // History is not persisted — Back after a reload leading somewhere the user
  // never navigated to in this page would be a lie about where they have been.
  win.restore = () => ({ app: 'files', path: current || startPath });

  go(startPath);
  return win;
}

/* ═════════════════════════════════════════════════════════════ editor ═══ */

export function openEditor(filePath = null) {
  const session = requireSession();
  const { api, toast } = session;
  const win = createWindow({ title: 'Editor', iconName: 'file-pen', width: 720, height: 500, appId: 'editor' });

  win.body.innerHTML = `
    <div class="tbar">
      <input class="tbar__path" spellcheck="false" placeholder="~/notes.txt" aria-label="File path">
      <button type="button" class="tbar__btn" data-act="open">${icon('folder-open', { size: 15 })}<span>Open</span></button>
      <button type="button" class="tbar__btn" data-act="save">${icon('save', { size: 15 })}<span>Save</span></button>
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
    // Show the path we are opening before the read, not after it succeeds: a
    // failed open used to leave an empty field, so a restored editor whose file
    // could not be read gave no clue which file it had been showing.
    pathInput.value = target;
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

  /**
   * Save, and — when the SSH user cannot write the file — offer the same
   * elevated path the unit-file editor has always had, rather than the dead end
   * of a "permission denied" toast on `/etc/nginx/nginx.conf`.
   *
   * Elevation is never automatic. The relay answers a denied write with
   * `needsSudo`, this asks in as many words which host is about to be written
   * as root, and only then retries with `sudo: true`; if that host wants a sudo
   * password the relay comes back `needsPassword` and it is asked for once,
   * used for that one command, and dropped (ui.js promptSecret — the same
   * mechanism services.js uses).
   */
  async function save() {
    const target = pathInput.value.trim();
    if (!target) return toast('Enter a file path first.', 'bad');
    state.textContent = 'Saving…';
    try {
      const res = await api.write(target, area.value);
      afterSave(res, target);
    } catch (err) {
      if (!err.needsSudo) {
        state.textContent = 'Save failed';
        return toast(err.message, 'bad');
      }
      state.textContent = 'Needs root';
      const ok = await confirmDialog({
        title: `Write ${basename(target)} as root on ${session.label}?`,
        message: `${session.username} cannot write ${target} on ${hostPhrase(session)}.`
          + ' It can be written with sudo instead — the file goes up to your home directory first and is'
          + ' then moved into place with `install`, keeping its current owner and mode.',
        confirmLabel: 'Write as root',
        danger: true,
        ...dangerOpts(session, { typed: true }),
      });
      if (!ok) { state.textContent = 'Not saved'; return; }
      await saveAsRoot(target);
    }
  }

  async function saveAsRoot(target, password) {
    state.textContent = 'Saving as root…';
    try {
      const res = await api.write(target, area.value, { sudo: true, password });
      afterSave(res, target, { sudo: true });
    } catch (err) {
      if (err.needsPassword) {
        const secret = await promptSecret({
          title: 'sudo password needed',
          message: `Writing ${target} needs root on ${hostPhrase(session)}.`
            + ' It is used for this one command and never stored.',
          accent: session.color,
        });
        if (secret) return saveAsRoot(target, secret);
      }
      state.textContent = 'Save failed';
      toast(err.message, 'bad', 8000);
    }
  }

  function afterSave(res, target, { sudo = false } = {}) {
    info.textContent = `${formatBytes(res.size)} · saved ${new Date(res.savedAt).toLocaleTimeString()}${sudo ? ' as root' : ''}`;
    setDirty(false);
    toast(`Saved ${basename(target)}${sudo ? ' as root' : ''}`, 'good');
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

  // Every other destructive confirm in this app names the host it is about;
  // this one used to say only "Discard unsaved changes?", which with four
  // sessions open is a question about no particular machine.
  win.onClose = async () => {
    if (!dirty) return true;
    return confirmDialog({
      title: `Discard unsaved changes on ${session.label}?`,
      message: `${pathInput.value || 'This file'} on ${hostPhrase(session)}`
        + ' has edits that have not been written to the server.',
      confirmLabel: 'Discard',
      danger: true,
      ...dangerOpts(session),
    });
  };

  // The path, and whether there were edits in flight. The buffer itself is not
  // persisted: re-opening reads the file from the server, so what comes back is
  // what is actually on the machine. The `dirty` flag exists only so the restore
  // notice can admit that unsaved edits went with the page instead of quietly
  // presenting the server's copy as if nothing had happened.
  win.restore = () => ({ app: 'editor', path: pathInput.value.trim() || null, dirty });

  if (filePath) load(filePath);
  return win;
}

/* ═══════════════════════════════════════════════════════════ terminal ═══ */

/**
 * `fresh` marks a terminal that restore.js reopened after a reconnect.
 *
 * The window is *not* the shell the user left — that PTY died with the old SSH
 * session — and the entire value of putting the window back is lost if anybody
 * can mistake one for the other. "My command went somewhere" is the failure
 * this app exists to prevent, so it is said in three places somebody might
 * actually look: a banner drawn into the terminal above the shell's first
 * prompt (and it is the top of an empty scrollback, so it cannot be scrolled
 * past), a permanent "new shell" subtitle in the window's title bar, and the
 * restore notice on the desktop.
 */
export function openTerminal(cwd = null, { fresh = false } = {}) {
  const session = requireSession();
  const { api } = session;
  // Just "Terminal": the title bar already carries the host in .win__host, and
  // the taskbar rule appends "— <session>" itself. Repeating the label here
  // produced "prod-db — Terminal 2 — prod-db" in the taskbar.
  const win = createWindow({ title: 'Terminal', iconName: 'terminal', width: 760, height: 440, appId: 'terminal' });
  win.body.innerHTML = '<div class="termhost"></div><div class="term-lost is-hidden" data-role="lost"></div>';
  const host = win.body.querySelector('.termhost');
  const lost = win.body.querySelector('[data-role="lost"]');

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

  /**
   * One handler, three jobs, in this order:
   *   1. app chords (Alt+Shift+…) — already acted on at window level in main.js;
   *      here we only stop them also reaching the PTY.
   *   2. the clipboard chords xterm has no binding for.
   *   3. everything else → straight to the PTY, untouched.
   *
   * Returning false means "xterm must not process this AND must not send it".
   * Everything not named below — Ctrl+C without a selection, Ctrl+D, Ctrl+K,
   * Alt+B, Alt+F, Alt+. — is untouched and still goes to the shell. The
   * window-level handler in keyboard.js has already stopped the *browser*
   * acting on the Ctrl chords, without stopping their propagation to here.
   */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey
      && (/^Digit[1-8]$/.test(e.code)
        || ['BracketLeft', 'BracketRight', 'KeyN', 'KeyK', 'KeyH'].includes(e.code))) {
      return false;
    }

    const modKey = navigator.platform?.startsWith?.('Mac') ? e.metaKey : e.ctrlKey;

    // Windows-Terminal semantics, and the half of the complaint that needs no
    // mode: with a selection Ctrl+C copies, with none it is SIGINT — which is
    // the only reason anyone presses it in a terminal. xterm has no such rule;
    // it sends ETX unconditionally and never fires a `copy` event.
    if (modKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && term.hasSelection()) {
      copySelection(term);
      e.preventDefault();
      return false;
    }

    // Muscle memory from GNOME Terminal and Windows Terminal. Redundant with
    // the rule above by design, because the devtools chord is not guaranteed
    // preventable in every browser and this must never be the only copy path.
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyC') {
      copySelection(term);
      e.preventDefault();
      return false;
    }

    // Ctrl+V and Shift+Insert are deliberately NOT here: xterm's own DOM
    // `paste` handler does those with bracketed paste and no permission
    // prompt. This chord is the extra, never the path.
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyV') {
      pasteFromClipboard(term);
      e.preventDefault();
      return false;
    }

    return true;
  });

  // A right-click menu that names the gestures, so the two entries that can
  // raise a clipboard prompt are never the only way to reach either action.
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copy', onClick: () => copySelection(term) },
      { label: 'Paste', onClick: () => pasteFromClipboard(term) },
      'separator',
      { label: 'Select all', onClick: () => { term.selectAll(); term.focus(); } },
      { label: 'Clear', onClick: () => { term.clear(); term.focus(); } },
    ]);
  });

  // Said once per browser, because the key we most need to warn about is the
  // one key we can never see a `keydown` for.
  hintOnce();

  // The first fit must wait a frame, or xterm measures a zero-height container
  // and every subsequent resize is computed from a wrong baseline.
  requestAnimationFrame(() => { fit.fit(); term.focus(); });

  // Written before the socket even opens, so it is the first thing in the
  // scrollback and the shell's prompt appears underneath it.
  if (fresh) {
    win.setSubtitle('— new shell');
    win.el.querySelector('.win__title')?.setAttribute('title',
      'This window was reopened. The shell inside it is new.');
    const line = '─'.repeat(58);
    term.writeln(`\x1b[33m┌${line}\x1b[0m`);
    term.writeln(`\x1b[33m│\x1b[0m \x1b[1;33mThis is a NEW shell on ${session.label}.\x1b[0m`);
    term.writeln(`\x1b[33m│\x1b[0m The terminal you left ended when that connection closed.`);
    term.writeln(`\x1b[33m│\x1b[0m Nothing above this line: no scrollback, no shell history,`);
    term.writeln(`\x1b[33m│\x1b[0m no jobs still running from before.`);
    if (cwd) term.writeln(`\x1b[33m│\x1b[0m Reopened in \x1b[1m${cwd}\x1b[0m, the directory it was started in.`);
    term.writeln(`\x1b[33m└${line}\x1b[0m`);
  }

  const socket = new WebSocket(api.terminalUrl(term.cols, term.rows));
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    // `clear` would wipe the banner above, which is the one thing here that
    // must survive. A reopened shell changes directory and says nothing else.
    if (cwd) socket.send(JSON.stringify({ type: 'input', data: `cd ${shellQuote(cwd)}${fresh ? '' : ' && clear'}\n` }));
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

  // Output arriving while you are looking elsewhere is what the rail's activity
  // badge is for; the scrollback keeps it either way.
  socket.addEventListener('message', () => markActivity(session));

  /**
   * A dead PTY used to be a grey word inside a black rectangle with nothing to
   * click. Now the stream that died says so above the terminal and offers the
   * one thing you want — another shell on the same host — while the scrollback
   * underneath stays readable and selectable.
   */
  function showLost(reason) {
    if (!lost.classList.contains('is-hidden')) return;
    lost.innerHTML = `<span class="term-lost__msg"></span>
      <button class="btn btn--sm" data-act="reconnect">Reconnect</button>`;
    lost.querySelector('.term-lost__msg').textContent = `${reason} on ${session.label}.`;
    lost.classList.remove('is-hidden');
    lost.querySelector('[data-act="reconnect"]').addEventListener('click', () => {
      win.close();
      // Also a new shell, for the same reason, so it says so the same way.
      openTerminal(cwd, { fresh: true });
    });
  }

  socket.addEventListener('close', () => {
    term.writeln('\r\n\x1b[90m[disconnected]\x1b[0m');
    showLost('This terminal stream ended');
    // A PTY closing is also the earliest signal that the SSH session itself
    // went away, so ask rather than wait for the ten-second poll.
    session.api.session().catch((err) => { if (err.status === 401) markDropped(session, 'connection lost'); });
  });
  socket.addEventListener('error', () => {
    term.writeln('\r\n\x1b[31m[connection error]\x1b[0m');
    showLost('This terminal lost its connection');
  });

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

  const teardown = () => {
    window.removeEventListener('resize', onWindowResize);
    try { socket.close(); } catch { /* already closed */ }
    term.dispose();
  };
  win.onClose = teardown;
  win.onForceClose = teardown;

  // Recorded, never replayed. restore.js will not reopen a terminal — the PTY
  // behind this one dies with the WebSocket — but it reports that it ended and
  // uses the directory to make "open a new one" land somewhere useful.
  win.restore = () => ({ app: 'terminal', cwd });

  return win;
}

/** Single-quote a path for the shell. Only used for the optional `cd` on open. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/* ═════════════════════════════════════════════════════════════ viewer ═══ */

export function openViewer(filePath) {
  const { api } = requireSession();
  const win = createWindow({ title: basename(filePath), iconName: 'image', width: 620, height: 480, appId: 'viewer' });
  win.body.innerHTML = `<div class="viewer"><img alt="${escapeHtml(basename(filePath))}" src="${api.previewUrl(filePath)}"></div>
    <div class="statusbar"><span>${escapeHtml(filePath)}</span><span data-role="dims">—</span></div>`;

  const img = win.body.querySelector('img');
  img.addEventListener('load', () => {
    win.body.querySelector('[data-role="dims"]').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
  });
  img.addEventListener('error', () => {
    win.body.querySelector('.viewer').innerHTML = '<div class="empty"><strong>Cannot display this image</strong>The file may be corrupt or unreadable.</div>';
  });
  win.restore = () => ({ app: 'viewer', path: filePath });
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
  const session = requireSession();
  const { api, toast } = session;
  const win = createWindow({ title: 'Port forwarding', iconName: 'arrow-right-left', width: 720, height: 560, appId: 'ports' });

  // "Add" first, list second. In a 560px window the form used to start below
  // the fold (F11/S5), so the app's primary action was the one thing you had to
  // scroll to find; the list grows downward and can afford to.
  win.body.innerHTML = `
    <div class="fwd-app">
      <details class="fwd-app__new" data-role="newfold" open>
        <summary class="fwd-app__h">New forward</summary>
        ${forwardFormHtml()}
      </details>
      <div class="fwd-app__listhead" data-role="listhead">Forwards</div>
      <div class="fwd-app__list" data-role="list"><p class="fwd-empty">No forwards yet.</p></div>

      <details class="fwd-app__new" data-role="savedfold">
        <summary class="fwd-app__h" data-role="savedhead">Saved for this server</summary>
        <p class="hint hint--block">Reopened automatically on every connect to
          <strong>${escapeHtml(session.username)}@${escapeHtml(session.host)}</strong>, from any browser.
          Closing a forward above stops that; so does forgetting it here.</p>
        <div class="fwd-app__list" data-role="saved"></div>
      </details>
    </div>`;

  const list = win.body.querySelector('[data-role="list"]');
  const savedList = win.body.querySelector('[data-role="saved"]');
  let timer = null;

  /**
   * The tunnels this server will bring back by itself. Separate from the live
   * list on purpose: a saved forward that is not running right now (its port
   * was taken, or the user closed the window it came from) is exactly the thing
   * the live list cannot show, and it is the thing you came here to delete.
   */
  function refreshSaved() {
    const saved = profileFor(session.target)?.forwards || [];
    win.body.querySelector('[data-role="savedhead"]').textContent =
      saved.length ? `Saved for this server · ${saved.length}` : 'Saved for this server · none';
    // Opened only when there is something in it: a fold that is always open
    // pushes the primary action — adding a forward — off the top of a 560px
    // window, which is the bug this app already had once.
    if (saved.length) win.body.querySelector('[data-role="savedfold"]').open = true;
    savedList.innerHTML = saved.length
      ? saved.map((spec) => `
        <div class="fwd-row fwd-row--saved" data-key="${escapeHtml(forwardKeyOf(spec))}">
          <span class="fwd-row__badge" role="img" aria-label="Saved forward">${icon('save', { size: 15 })}</span>
          <div class="fwd-row__main">
            <div class="fwd-row__title">
              ${spec.label ? `<strong>${escapeHtml(spec.label)}</strong>` : ''}
              <code>${escapeHtml(describeSpec(spec))}</code>
            </div>
            <div class="fwd-row__meta">reopens on every connect to this server</div>
          </div>
          <span class="fwd-row__status fwd-row__status--queued">saved</span>
          ${iconButton('x', `Forget the saved forward ${describeSpec(spec)}`,
            { size: 14, className: 'fwd-row__x', attrs: 'data-act="forget"' })}
        </div>`).join('')
      : '<p class="fwd-empty">Nothing saved yet. Any forward you open here is remembered for next time.</p>';
  }

  savedList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="forget"]');
    if (!btn) return;
    const row = btn.closest('.fwd-row');
    const ok = await confirmDialog({
      title: `Forget this saved forward on ${session.label}?`,
      message: `${row.querySelector('.fwd-row__title')?.textContent.trim() || 'The tunnel'} will not be reopened `
        + `the next time you connect to ${hostPhrase(session)}. Any forward running right now keeps running.`,
      confirmLabel: 'Forget it',
      danger: true,
      ...dangerOpts(session),
    });
    if (!ok) return;
    try {
      await forgetSavedForward(session.target, row.dataset.key);
      toast('Saved forward forgotten.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    refreshSaved();
  });

  async function refresh() {
    try {
      const { forwards } = await api.forwards();
      const active = forwards.filter((f) => f.status === 'active').length;
      const queued = forwards.filter((f) => f.status === 'queued' || f.status === 'pending').length;
      win.setSubtitle(`— ${active} active${queued ? `, ${queued} queued` : ''}`);
      win.body.querySelector('[data-role="listhead"]').textContent = forwards.length
        ? `Forwards · ${active} active${queued ? ` · ${queued} queued` : ''}`
        : 'Forwards';
      list.innerHTML = forwards.length
        ? forwards.map((f) => forwardRowHtml(f, { actions: true })).join('')
        : '<p class="fwd-empty">No forwards yet. Add one above — it opens straight away.</p>';
    } catch (err) {
      list.innerHTML = `<p class="fwd-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  /**
   * Copy without assuming the async clipboard exists. It does over
   * http://127.0.0.1 (a secure context), but a relay reached through someone
   * else's tunnel on a plain http origin has no `navigator.clipboard` at all,
   * and silently copying nothing is the worst of the three outcomes.
   */
  async function copyAddress(text) {
    try {
      await navigator.clipboard.writeText(text);
      return toast(`Copied ${text}`, 'good');
    } catch { /* fall through to the old way */ }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.style.cssText = 'position:fixed;top:-1000px';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      scratch.remove();
      toast(ok ? `Copied ${text}` : `Could not copy. The address is ${text}`, ok ? 'good' : 'bad', ok ? 3800 : 9000);
    } catch {
      toast(`Could not copy. The address is ${text}`, 'bad', 9000);
    }
  }

  list.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-act="copy"]');
    if (copy) return copyAddress(copy.dataset.addr);

    const open = e.target.closest('[data-act="open"]');
    if (open) {
      window.open(open.dataset.url, '_blank', 'noopener');
      return;
    }

    const btn = e.target.closest('[data-act="remove"]');
    if (!btn) return;
    const row = btn.closest('.fwd-row');
    const id = row.dataset.id;
    const ok = await confirmDialog({
      title: `Close this forward on ${session.label}?`,
      message: `${row.querySelector('.fwd-row__title')?.textContent.trim() || 'The tunnel'} on ${hostPhrase(session)}.`
        + ' Anything using it loses the connection.',
      confirmLabel: 'Close forward',
      danger: true,
      ...dangerOpts(session),
    });
    if (!ok) return;
    try {
      await api.closeForward(id);
      // Closing it by hand also un-saves it on the relay; say so where the
      // consequence is, rather than leaving the saved list silently stale.
      toast('Forward closed, and it will not be reopened next time.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    refresh();
    loadProfiles().catch(() => { /* the saved list simply stays as it was */ });
  });

  wireForwardForm(win.body.querySelector('.fwd-form'), async (spec) => {
    const fwd = await api.addForward(spec);
    toast(`Forward open: ${fwd.description}. Saved for next time.`, 'good');
    refresh();
    loadProfiles().catch(() => { /* the saved list simply stays as it was */ });
  });

  refresh();
  refreshSaved();
  // Cheap, and it is the only way this window learns about a forward opened
  // from another window on the same host.
  const stopWatching = onProfilesChange(refreshSaved);
  loadProfiles().catch(() => { /* already painted from the cache */ });

  timer = setInterval(refresh, 2000);
  const stop = () => { clearInterval(timer); stopWatching(); };
  win.onClose = stop;   // The forwards themselves keep running.
  win.onForceClose = stop;
  win.restore = () => ({ app: 'ports' });
  return win;
}
