/**
 * wm.js — a small window manager.
 *
 * Drag and resize both use pointer events with setPointerCapture rather than
 * document-level mousemove listeners. That is what keeps a drag alive when the
 * cursor crosses an iframe, a canvas, or the terminal — the usual reason
 * home-grown window managers "stick" halfway through a drag.
 */

const layer = () => document.getElementById('windows');
const taskbar = () => document.getElementById('dock-running');

let zTop = 100;
let seq = 0;
const windows = new Map();

export function createWindow({ title, subtitle = '', icon = '▣', width = 720, height = 460, appId = null }) {
  const id = `win-${++seq}`;

  // Cascade diagonally so a second window never buries the first. The step is
  // wider than the title bar is tall, so every open window stays clickable.
  const step = windows.size % 6;
  const bounds = layer().getBoundingClientRect();
  const w = Math.min(width, bounds.width - 40);
  const h = Math.min(height, bounds.height - 70);
  const left = Math.max(90, (bounds.width - w) / 2 - 90 + step * 54);
  const top = Math.max(42, (bounds.height - h) / 2 - 50 + step * 38);

  const el = document.createElement('div');
  el.className = 'win';
  el.id = id;
  el.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
  el.innerHTML = `
    <div class="win__bar">
      <span class="win__title">${escapeHtml(title)} <span class="win__sub"></span></span>
      <div class="win__ctl">
        <button class="win__btn" data-act="min" title="Minimise" aria-label="Minimise">–</button>
        <button class="win__btn" data-act="max" title="Maximise" aria-label="Maximise">□</button>
        <button class="win__btn win__btn--close" data-act="close" title="Close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="win__body"></div>
    <div class="win__grip" title="Resize"></div>`;

  layer().appendChild(el);

  const task = document.createElement('button');
  task.className = 'dock__task';
  task.textContent = icon;
  task.title = title;
  task.addEventListener('click', () => {
    if (el.classList.contains('is-min') || !el.classList.contains('is-focused')) restore(id);
    else minimise(id);
  });
  taskbar().appendChild(task);

  const win = {
    id, el, task, appId,
    body: el.querySelector('.win__body'),
    onClose: null,
    onResize: null,
    setSubtitle: (text) => { el.querySelector('.win__sub').textContent = text; },
    setTitle: (text) => { el.querySelector('.win__title').firstChild.textContent = `${text} `; },
    close: () => closeWindow(id),
  };
  windows.set(id, win);

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

  makeDraggable(el, el.querySelector('.win__bar'));
  makeResizable(win, el.querySelector('.win__grip'));

  focus(id);
  if (appId) markDockRunning(appId, true);
  return win;
}

function makeDraggable(el, handle) {
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
    const bounds = layer().getBoundingClientRect();
    // Keep at least a slice of the title bar reachable so a window can never
    // be dragged fully off-screen and stranded.
    const nextLeft = clamp(originLeft + e.clientX - startX, -el.offsetWidth + 110, bounds.width - 60);
    const nextTop = clamp(originTop + e.clientY - startY, 30, bounds.height - 44);
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
  const win = windows.get(id);
  if (!win) return;
  for (const w of windows.values()) w.el.classList.remove('is-focused');
  win.el.classList.add('is-focused');
  win.el.classList.remove('is-min');
  win.el.style.zIndex = ++zTop;
}

function restore(id) {
  windows.get(id)?.el.classList.remove('is-min');
  focus(id);
}

function minimise(id) {
  const win = windows.get(id);
  if (!win) return;
  win.el.classList.add('is-min');
  win.el.classList.remove('is-focused');
}

function toggleMax(id) {
  const win = windows.get(id);
  if (!win) return;
  win.el.classList.toggle('is-max');
  win.onResize?.();
}

export function closeWindow(id) {
  const win = windows.get(id);
  if (!win) return;
  // A window can veto its own close (the editor uses this for unsaved changes).
  if (win.onClose?.() === false) return;
  win.el.remove();
  win.task.remove();
  windows.delete(id);
  if (win.appId && ![...windows.values()].some((w) => w.appId === win.appId)) {
    markDockRunning(win.appId, false);
  }
}

export function closeAll() {
  for (const id of [...windows.keys()]) closeWindow(id);
}

function markDockRunning(appId, running) {
  document.querySelector(`.dock__item[data-launch="${appId}"]`)?.classList.toggle('is-running', running);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
