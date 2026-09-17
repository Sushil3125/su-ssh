/**
 * wm.js — a small window manager, one workspace per SSH session.
 *
 * Drag and resize both use pointer events with setPointerCapture rather than
 * document-level mousemove listeners. That is what keeps a drag alive when the
 * cursor crosses an iframe, a canvas, or the terminal — the usual reason
 * home-grown window managers "stick" halfway through a drag.
 *
 * Multi-session shape: there is no longer one `windows` Map and one layer.
 * Each session owns a *workspace* — its own window layer, its own taskbar strip
 * and its own desktop-icon surface — and switching sessions hides one set of
 * DOM nodes and shows another. Nothing is destroyed, nothing is re-created, so
 * no socket closes and no unsaved editor buffer is lost; position, size,
 * minimise/maximise state and z-order survive a switch for free, because the
 * elements themselves were never touched.
 *
 * A window belongs to the workspace that was current when it was created and
 * never moves. That is the whole wrong-server defence: there is no code path
 * that can put a prod window on the staging desktop.
 */

const layersHost = () => document.getElementById('windows');
const taskHost = () => document.getElementById('dock-running');
const iconsHost = () => document.getElementById('desktop-icons');

let seq = 0;

/** The workspace new windows are created into. Set by main.js on activation. */
let current = null;

/** Every live workspace, so a window can be found by id without guessing. */
const workspaces = new Set();

/** main.js subscribes so the rail chip's window count stays honest. */
let onWindowCountChange = null;
export function setWindowCountListener(fn) { onWindowCountChange = fn; }

export function createWorkspace({ id, label, color, host }) {
  const layer = document.createElement('div');
  layer.className = 'windows__layer is-hidden';
  layer.dataset.session = id;
  layersHost().appendChild(layer);

  const taskbar = document.createElement('div');
  taskbar.className = 'dock__tasks is-hidden';
  taskbar.dataset.session = id;
  taskHost().appendChild(taskbar);

  const icons = document.createElement('div');
  icons.className = 'desktop__iconset is-hidden';
  icons.dataset.session = id;
  iconsHost().appendChild(icons);

  const ws = {
    id, label, color, host, layer, taskbar, icons,
    windows: new Map(),
    zTop: 100,
    /** Restored on activation so the terminal you were typing in gets focus back. */
    lastFocused: null,
  };
  workspaces.add(ws);
  return ws;
}

/** Make `ws` the workspace new windows go into, without changing what is shown. */
export function useWorkspace(ws) { current = ws; }

export function activeWorkspace() { return current; }

/** Show one workspace's DOM and hide every other. Closes nothing. */
export function showWorkspace(ws) {
  for (const host of [layersHost(), taskHost(), iconsHost()]) {
    for (const child of host.children) child.classList.add('is-hidden');
  }
  ws.layer.classList.remove('is-hidden');
  ws.taskbar.classList.remove('is-hidden');
  ws.icons.classList.remove('is-hidden');
  current = ws;
  syncDockRunning();
  // Give the keyboard back to whatever had it here before we left.
  if (ws.lastFocused && ws.windows.has(ws.lastFocused)) focus(ws.lastFocused);
}

export function destroyWorkspace(ws) {
  closeAll(ws);
  workspaces.delete(ws);
  ws.layer.remove();
  ws.taskbar.remove();
  ws.icons.remove();
  if (current === ws) current = null;
}

/** Windows open on a dropped session are frozen: visible, but not interactive. */
export function setWorkspaceFrozen(ws, frozen) {
  ws.layer.classList.toggle('is-frozen', frozen);
}

export function createWindow({ title, subtitle = '', icon = '▣', width = 720, height = 460, appId = null }) {
  const ws = current;
  if (!ws) throw new Error('No active session: open a connection first.');
  const id = `win-${++seq}`;

  // Cascade diagonally so a second window never buries the first. The step is
  // wider than the title bar is tall, so every open window stays clickable.
  const step = ws.windows.size % 6;
  const bounds = ws.layer.getBoundingClientRect();
  const w = Math.min(width, Math.max(320, bounds.width - 40));
  const h = Math.min(height, Math.max(200, bounds.height - 50));
  const left = Math.max(12, (bounds.width - w) / 2 - 60 + step * 54);
  const top = Math.max(8, (bounds.height - h) / 2 - 40 + step * 38);

  const el = document.createElement('div');
  el.className = 'win';
  el.id = id;
  // The session colour on the title bar's left edge, per UX research §4: the
  // one identity signal that is visible in a screenshot and in peripheral
  // vision. It is never the only signal — the label sits beside it.
  el.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px;--session-color:${ws.color}`;
  el.innerHTML = `
    <div class="win__bar">
      <span class="win__title">${escapeHtml(title)} <span class="win__sub"></span>
        <span class="win__host"></span></span>
      <div class="win__ctl">
        <button class="win__btn" data-act="min" title="Minimise" aria-label="Minimise">–</button>
        <button class="win__btn" data-act="max" title="Maximise" aria-label="Maximise">□</button>
        <button class="win__btn win__btn--close" data-act="close" title="Close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="win__body"></div>
    <div class="win__grip" title="Resize"></div>`;

  el.querySelector('.win__host').textContent = ws.label;
  el.querySelector('.win__host').title = ws.host;
  ws.layer.appendChild(el);

  const task = document.createElement('button');
  task.className = 'dock__task';
  task.textContent = icon;
  task.title = `${title} — ${ws.label}`;
  task.setAttribute('aria-label', `${title} on ${ws.label}`);
  task.addEventListener('click', () => {
    if (el.classList.contains('is-min') || !el.classList.contains('is-focused')) restore(id);
    else minimise(id);
  });
  ws.taskbar.appendChild(task);

  const win = {
    id, el, task, appId, ws,
    session: ws.id,
    body: el.querySelector('.win__body'),
    onClose: null,
    onResize: null,
    setSubtitle: (text) => { el.querySelector('.win__sub').textContent = text; },
    setTitle: (text) => {
      el.querySelector('.win__title').firstChild.textContent = `${text} `;
      task.title = `${text} — ${ws.label}`;
    },
    close: () => closeWindow(id),
  };
  ws.windows.set(id, win);

  el.addEventListener('pointerdown', () => focus(id), true);
  el.querySelector('.win__ctl').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'close') closeWindow(id);
    if (act === 'min') minimise(id);
    if (act === 'max') toggleMax(id);
  });
  el.querySelector('.win__bar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.win__ctl')) toggleMax(id);
  });

  makeDraggable(ws, el, el.querySelector('.win__bar'));
  makeResizable(win, el.querySelector('.win__grip'));

  focus(id);
  syncDockRunning();
  onWindowCountChange?.(ws);
  return win;
}

/** Find a window by id across every workspace — close/focus never guess a session. */
function lookup(id) {
  for (const ws of workspaces) {
    const win = ws.windows.get(id);
    if (win) return win;
  }
  return null;
}

function makeDraggable(ws, el, handle) {
  let startX, startY, originLeft, originTop, dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.win__ctl') || el.classList.contains('is-max')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    originLeft = el.offsetLeft; originTop = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const bounds = ws.layer.getBoundingClientRect();
    // Keep at least a slice of the title bar reachable so a window can never
    // be dragged fully off-screen and stranded.
    const nextLeft = clamp(originLeft + e.clientX - startX, -el.offsetWidth + 110, bounds.width - 60);
    const nextTop = clamp(originTop + e.clientY - startY, 0, bounds.height - 44);
    el.style.left = `${nextLeft}px`;
    el.style.top = `${nextTop}px`;
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function makeResizable(win, grip) {
  const el = win.el;
  let startX, startY, startW, startH, resizing = false;

  grip.addEventListener('pointerdown', (e) => {
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = el.offsetWidth; startH = el.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    el.style.width = `${Math.max(320, startW + e.clientX - startX)}px`;
    el.style.height = `${Math.max(200, startH + e.clientY - startY)}px`;
    win.onResize?.();
  });

  const stop = (e) => {
    if (!resizing) return;
    resizing = false;
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    win.onResize?.();
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

export function focus(id) {
  const win = lookup(id);
  if (!win) return;
  const ws = win.ws;
  for (const w of ws.windows.values()) w.el.classList.remove('is-focused');
  win.el.classList.add('is-focused');
  win.el.classList.remove('is-min');
  // Only raise a window that is not already on top. Otherwise re-focusing on
  // every session switch would walk z-index upward forever and, worse, make
  // "the layout came back exactly as I left it" quietly untrue.
  if (Number(win.el.style.zIndex) !== ws.zTop) win.el.style.zIndex = ++ws.zTop;
  ws.lastFocused = id;
}

function restore(id) {
  lookup(id)?.el.classList.remove('is-min');
  focus(id);
}

function minimise(id) {
  const win = lookup(id);
  if (!win) return;
  win.el.classList.add('is-min');
  win.el.classList.remove('is-focused');
}

function toggleMax(id) {
  const win = lookup(id);
  if (!win) return;
  win.el.classList.toggle('is-max');
  win.onResize?.();
}

/**
 * A window can veto its own close (the editor does, for unsaved changes).
 * `onClose` may be async, because the confirmation it shows is a real dialog
 * rather than the browser's blocking `confirm`. `force` skips the veto, for
 * teardown paths like disconnecting where a prompt would be in the way.
 */
export async function closeWindow(id, { force = false } = {}) {
  const win = lookup(id);
  if (!win || win.closing) return;
  const ws = win.ws;

  if (!force) {
    win.closing = true;   // A second click while the dialog is up must not stack.
    try {
      if (await win.onClose?.() === false) return;
    } finally {
      win.closing = false;
    }
    if (!ws.windows.has(id)) return;  // Closed underneath us while we waited.
  } else {
    // A forced close still has to stop what the window started — a WebSocket,
    // a poll timer, a window-resize listener — it just skips the veto dialog.
    try { win.onForceClose?.(); } catch { /* teardown is best effort */ }
  }

  win.el.remove();
  win.task.remove();
  ws.windows.delete(id);
  if (ws.lastFocused === id) ws.lastFocused = null;
  syncDockRunning();
  onWindowCountChange?.(ws);
}

/** Close every window of one workspace (defaults to the active one). */
export function closeAll(ws = current) {
  if (!ws) return;
  for (const id of [...ws.windows.keys()]) closeWindow(id, { force: true });
}

/**
 * The dock launchers show a "running" pip. With several sessions that pip must
 * describe the session you are looking at, so it is recomputed from the active
 * workspace rather than toggled as windows come and go.
 */
function syncDockRunning() {
  const open = new Set([...(current?.windows.values() || [])].map((w) => w.appId).filter(Boolean));
  for (const item of document.querySelectorAll('.dock__item[data-launch]')) {
    item.classList.toggle('is-running', open.has(item.dataset.launch));
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
