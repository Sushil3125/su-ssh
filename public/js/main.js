/** main.js — greeter, session lifecycle, desktop surface, dock. */

import { api, setToken, getToken } from './api.js';
import { openFiles, openEditor, openTerminal, openViewer } from './apps.js';
import { closeAll, escapeHtml } from './wm.js';
import { toast, contextMenu, GLYPH } from './ui.js';

const greeter = document.getElementById('greeter');
const shell = document.getElementById('shell');
const form = document.getElementById('connect-form');
const errorBox = document.getElementById('connect-error');
const connectBtn = document.getElementById('connect-btn');

let authMethod = 'password';
let clockTimer = null;

/* ══════════════════════════════════════════════════════════ greeter ════ */

// Remember only what is safe to remember. Never the password, never the key.
const REMEMBER_KEY = 'ssh-last-target';
try {
  const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}');
  if (saved.host) document.getElementById('f-host').value = saved.host;
  if (saved.port) document.getElementById('f-port').value = saved.port;
  if (saved.username) document.getElementById('f-username').value = saved.username;
} catch { /* corrupt entry; ignore and start fresh */ }

document.getElementById('auth-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn) return;
  authMethod = btn.dataset.auth;
  document.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  document.querySelectorAll('.auth-pane').forEach((p) => p.classList.toggle('is-hidden', p.dataset.pane !== authMethod));
});

// Reading the key in the browser means it never touches the relay host's disk.
document.getElementById('f-keyupload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('f-privatekey').value = await file.text();
  toast(`Loaded ${file.name}`, 'good');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('is-hidden');
  connectBtn.classList.add('is-busy');
  connectBtn.disabled = true;

  const creds = {
    host: document.getElementById('f-host').value.trim(),
    port: document.getElementById('f-port').value.trim() || 22,
    username: document.getElementById('f-username').value.trim(),
    authMethod,
    password: document.getElementById('f-password').value,
    privateKey: document.getElementById('f-privatekey').value,
    privateKeyPath: document.getElementById('f-keypath').value.trim(),
    passphrase: authMethod === 'keyfile'
      ? document.getElementById('f-passphrase2').value
      : document.getElementById('f-passphrase').value,
  };

  try {
    const session = await api.connect(creds);
    setToken(session.token);
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({
      host: creds.host, port: creds.port, username: creds.username,
    }));

    // Clear the secrets from the DOM the moment they are no longer needed.
    document.getElementById('f-password').value = '';
    document.getElementById('f-privatekey').value = '';
    document.getElementById('f-passphrase').value = '';
    document.getElementById('f-passphrase2').value = '';

    enterDesktop(session);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('is-hidden');
  } finally {
    connectBtn.classList.remove('is-busy');
    connectBtn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════ desktop ════ */

function enterDesktop(session) {
  greeter.classList.add('is-hidden');
  shell.classList.remove('is-hidden');

  document.getElementById('topbar-conn').textContent =
    `${session.username}@${session.host}${session.port === 22 ? '' : `:${session.port}`}`;

  startClock();
  loadSystemInfo();
  loadDesktopIcons(session.home);
}

function startClock() {
  const el = document.getElementById('topbar-clock');
  const tick = () => {
    el.textContent = new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 15_000);
}

async function loadSystemInfo() {
  try {
    const info = await api.system();
    const parts = [info.distro, info.kernel, info.memory && `RAM ${info.memory}`, info.disk]
      .filter((p) => p && p !== '-');
    const el = document.getElementById('topbar-sys');
    el.textContent = parts.slice(0, 2).join('  ·  ');
    el.title = parts.join('\n');
  } catch { /* non-essential; the desktop works without it */ }
}

/**
 * Desktop icons come from ~/Desktop if it exists. Falling back to the home
 * directory matters because a headless server almost never has a Desktop
 * folder — showing an empty desktop would look broken rather than accurate.
 */
async function loadDesktopIcons(home) {
  const container = document.getElementById('desktop-icons');
  const hint = document.getElementById('desktop-hint');

  let data;
  let source = `${home}/Desktop`;
  try {
    data = await api.list(source);
  } catch {
    source = home;
    try {
      data = await api.list(source);
      hint.textContent = 'No ~/Desktop on this server, so your home directory is shown instead.';
    } catch (err) {
      hint.textContent = `Could not read the home directory: ${err.message}`;
      return;
    }
  }

  if (source.endsWith('/Desktop')) hint.classList.add('is-hidden');

  const visible = data.entries.filter((e) => !e.name.startsWith('.'));
  if (!visible.length) {
    hint.classList.remove('is-hidden');
    hint.textContent = `${source} is empty. Open Files to look around.`;
    return;
  }

  container.innerHTML = '';
  for (const entry of visible.slice(0, 60)) {
    const el = document.createElement('div');
    el.className = 'dicon';
    el.tabIndex = 0;
    el.innerHTML = `<div class="dicon__glyph">${GLYPH[entry.kind] || GLYPH.binary}</div>
                    <div class="dicon__name">${escapeHtml(entry.name)}</div>`;

    const open = () => {
      if (entry.isDirectory) openFiles(entry.path);
      else if (entry.kind === 'image') openViewer(entry.path);
      else openEditor(entry.path);
    };

    el.addEventListener('click', () => {
      container.querySelectorAll('.dicon').forEach((n) => n.classList.remove('is-selected'));
      el.classList.add('is-selected');
    });
    el.addEventListener('dblclick', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open', onClick: open },
        { label: 'Show in Files', onClick: () => openFiles(entry.isDirectory ? entry.path : source) },
        { label: 'Download', onClick: () => window.open(api.downloadUrl(entry.path), '_blank') },
      ]);
    });
    container.appendChild(el);
  }
}

document.getElementById('desktop').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.dicon')) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Open Files', onClick: () => openFiles('~') },
    { label: 'Open Terminal', onClick: () => openTerminal() },
    { label: 'New text file', onClick: () => openEditor() },
    'separator',
    { label: 'Refresh desktop', onClick: () => api.session().then((s) => loadDesktopIcons(s.home)) },
  ]);
});

/* ═════════════════════════════════════════════════════════════ dock ════ */

document.getElementById('dock').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-launch]');
  if (!btn) return;
  ({ files: () => openFiles('~'), terminal: () => openTerminal(), editor: () => openEditor() })[btn.dataset.launch]?.();
});

document.getElementById('btn-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect from the server? Open windows will close.')) return;
  try { await api.disconnect(); } catch { /* the socket may already be gone */ }
  closeAll();
  setToken(null);
  clearInterval(clockTimer);
  document.getElementById('desktop-icons').innerHTML = '';
  shell.classList.add('is-hidden');
  greeter.classList.remove('is-hidden');
});

/* ══════════════════════════════════════════════════ restore on reload ══ */

(async function restore() {
  if (!getToken()) return;
  try {
    enterDesktop(await api.session());
  } catch {
    setToken(null); // Relay restarted or the connection dropped; show the greeter.
  }
})();
