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

import { icon } from './icon.js';

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

/**
 * restore.js subscribes: anything that moves, resizes, opens, closes, raises or
 * minimises a window makes the saved layout stale. Debouncing is the listener's
 * problem, not ours — this fires when a drag ends, not on every drag frame.
 */
let onLayoutChange = null;
export function setLayoutChangeListener(fn) { onLayoutChange = fn; }
function layoutChanged(ws) { if (ws) onLayoutChange?.(ws); }

export const allWorkspaces = () => [...workspaces];

/* ──────────────────────────────────────────────── geometry and restore ── */

/**
 * Below this width a window is not a window: it is a full-bleed card, one at a
 * time, with the taskbar as the switcher (UX research S4/F8). The number is a
 * half-width 1080p laptop browser, which is where the desktop offsets first
 * start clipping — not a phone-only breakpoint.
 */
export const NARROW_PX = 900;
export const isNarrow = () => window.innerWidth <= NARROW_PX;

/**
 * Geometry handed to the next createWindow call instead of the cascade.
 *
 * Restoring happens into a workspace that is still hidden (only one layer is
 * ever visible), and a hidden layer measures 0×0 — so the cascade maths cannot
 * run there. Passing the saved rectangle straight through side-steps the
 * measurement entirely, which is also exactly what "it came back where I left
 * it" has to mean.
 */
let pendingGeometry = null;
export function withGeometry(geo, fn) {
  pendingGeometry = geo;
  try { return fn(); } finally { pendingGeometry = null; }
}

/** The numbers restore.js writes down. Read from inline style rather than the
 *  rendered box, so a hidden or maximised window still reports its real place. */
export function windowGeometry(win) {
  const el = win.el;
  return {
    left: Math.round(parseFloat(el.style.left) || 0),
    top: Math.round(parseFloat(el.style.top) || 0),
    width: Math.round(parseFloat(el.style.width) || el.offsetWidth || 720),
    height: Math.round(parseFloat(el.style.height) || el.offsetHeight || 460),
    max: el.classList.contains('is-max'),
    min: el.classList.contains('is-min'),
    z: Number(el.style.zIndex) || 100,
  };
}

/** Re-apply the parts of a saved state that createWindow cannot take. */
export function applyWindowState(win, { min = false, max = false, z = null } = {}) {
  win.el.classList.toggle('is-max', !!max);
  if (z != null) {
    win.el.style.zIndex = z;
    win.ws.zTop = Math.max(win.ws.zTop, z);
  }
  if (min) {
    win.el.classList.add('is-min');
    win.el.classList.remove('is-focused');
    if (win.ws.lastFocused === win.id) win.ws.lastFocused = null;
  }
}

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

export function createWindow({ title, subtitle = '', iconName = 'app-window', width = 720, height = 460, appId = null }) {
  const ws = current;
  if (!ws) throw new Error('No active session: open a connection first.');
  const id = `win-${++seq}`;

  // A restore hands us the rectangle the window had before the refresh; a fresh
  // window cascades diagonally so a second one never buries the first. The step
  // is wider than the title bar is tall, so every open window stays clickable.
  const saved = pendingGeometry;
  let w, h, left, top;
  if (saved) {
    w = Math.max(320, Math.round(saved.width) || width);
    h = Math.max(200, Math.round(saved.height) || height);
    left = Math.round(saved.left) || 0;
    top = Math.max(0, Math.round(saved.top) || 0);
  } else {
    const step = ws.windows.size % 6;
    const bounds = ws.layer.getBoundingClientRect();
    w = Math.min(width, Math.max(320, bounds.width - 40));
    h = Math.min(height, Math.max(200, bounds.height - 50));
    left = Math.max(12, (bounds.width - w) / 2 - 60 + step * 54);
    top = Math.max(8, (bounds.height - h) / 2 - 40 + step * 38);
  }

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
        <button class="win__btn" data-act="min" title="Minimise" aria-label="Minimise">${icon('minus', { size: 14 })}</button>
        <button class="win__btn" data-act="max" title="Maximise" aria-label="Maximise" aria-pressed="false">${icon('square', { size: 13 })}</button>
        <button class="win__btn win__btn--close" data-act="close" title="Close" aria-label="Close">${icon('x', { size: 14 })}</button>
      </div>
    </div>
    <div class="win__body"></div>
    <div class="win__grip" title="Resize" aria-hidden="true">${icon('move-diagonal-2', { size: 13 })}</div>`;

  el.querySelector('.win__host').textContent = ws.label;
  el.querySelector('.win__host').title = ws.host;
  ws.layer.appendChild(el);

  const task = document.createElement('button');
  task.className = 'dock__task';
  task.type = 'button';
  task.innerHTML = `${icon(iconName, { size: 18 })}<span class="dock__task-ord is-hidden"></span>`
    + `<span class="dock__task-label"></span>`;
  task.addEventListener('click', () => {
    if (el.classList.contains('is-min') || !el.classList.contains('is-focused')) restore(id);
    else minimise(id);
  });
  ws.taskbar.appendChild(task);

  const win = {
    id, el, task, appId, ws,
    session: ws.id,
    /** The size the user asked for, so a clamp for a narrow viewport is
     *  reversible when the viewport grows back. */
    pref: { width: w, height: h },
    body: el.querySelector('.win__body'),
    onClose: null,
    onResize: null,
    /**
     * Set by each app to `() => ({ ... })`: the few values that describe what
     * this window was *showing* (a path, a unit, a tab), so a refresh can put
     * it back. Geometry is wm's job; content is the app's. A window that never
     * sets this is remembered as its app with no state, which is still better
     * than being forgotten.
     */
    restore: null,
    setSubtitle: (text) => { el.querySelector('.win__sub').textContent = text; },
    setTitle: (text) => {
      el.querySelector('.win__title').firstChild.textContent = `${text} `;
      nameTask(win);
    },
    close: () => closeWindow(id),
  };
  ws.windows.set(id, win);
  nameSiblings(ws, appId);

  el.addEventListener('pointerdown', () => focus(id), true);
  el.querySelector('.win__ctl').addEventListener('click', (e) => {
    // closest(), not e.target: the click usually lands on the <svg> inside the
    // button now that these are icons rather than characters.
    const act = e.target.closest('[data-act]')?.dataset.act;
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
  layoutChanged(ws);
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
    // Below the breakpoint a window fills the viewport and has no position to
    // drag it to; letting the drag run would only write geometry the CSS then
    // overrides, and the layout would "jump" on the way back to a wide screen.
    if (e.target.closest('.win__ctl') || el.classList.contains('is-max') || isNarrow()) return;
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
    layoutChanged(ws);
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function makeResizable(win, grip) {
  const el = win.el;
  let startX, startY, startW, startH, resizing = false;

  grip.addEventListener('pointerdown', (e) => {
    if (isNarrow()) return;      // Full-bleed cards have nothing to resize.
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = el.offsetWidth; startH = el.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = Math.max(320, startW + e.clientX - startX);
    const h = Math.max(200, startH + e.clientY - startY);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    win.pref = { width: w, height: h };
    win.onResize?.();
  });

  const stop = (e) => {
    if (!resizing) return;
    resizing = false;
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    win.onResize?.();
    layoutChanged(win.ws);
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

export function focus(id) {
  const win = lookup(id);
  if (!win) return;
  const ws = win.ws;
  for (const w of ws.windows.values()) {
    w.el.classList.remove('is-focused');
    w.task.classList.remove('is-active');
  }
  win.el.classList.add('is-focused');
  win.task.classList.add('is-active');
  win.el.classList.remove('is-min');
  // Only raise a window that is not already on top. Otherwise re-focusing on
  // every session switch would walk z-index upward forever and, worse, make
  // "the layout came back exactly as I left it" quietly untrue.
  if (Number(win.el.style.zIndex) !== ws.zTop) win.el.style.zIndex = ++ws.zTop;
  ws.lastFocused = id;
  layoutChanged(ws);
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
  win.task.classList.remove('is-active');
  // Below the breakpoint only the focused window is on screen, so minimising
  // the last one must leave *something* focused or the desktop looks empty
  // with a full taskbar. Fall back to the next window down the stack.
  if (isNarrow()) {
    const next = [...win.ws.windows.values()]
      .filter((w) => w !== win && !w.el.classList.contains('is-min'))
      .sort((a, b) => (Number(b.el.style.zIndex) || 0) - (Number(a.el.style.zIndex) || 0))[0];
    if (next) focus(next.id);
  }
  layoutChanged(win.ws);
}

function toggleMax(id) {
  const win = lookup(id);
  if (!win) return;
  const max = win.el.classList.toggle('is-max');
  const btn = win.el.querySelector('[data-act="max"]');
  btn.setAttribute('aria-pressed', String(max));
  // Maximise and Restore are different actions, so they get different names and
  // different glyphs — `square` fills the screen, `copy` puts the window back.
  const label = max ? 'Restore' : 'Maximise';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon(max ? 'copy' : 'square', { size: 13 });
  win.onResize?.();
  layoutChanged(win.ws);
}

/**
 * Name a taskbar button: "<window title> — <session label>", with an ordinal
 * when the session holds more than one window of the same app, so two Terminals
 * are never two identical buttons with two identical names. Both the visible
 * label and the accessible name come from the same string.
 */
function nameTask(win) {
  const siblings = [...win.ws.windows.values()].filter((w) => w.appId && w.appId === win.appId);
  const nth = siblings.length > 1 ? ` ${siblings.indexOf(win) + 1}` : '';
  const title = win.el.querySelector('.win__title').firstChild.textContent.trim();
  const full = `${title}${nth} — ${win.ws.label}`;
  win.task.title = full;
  win.task.setAttribute('aria-label', full);
  win.task.querySelector('.dock__task-label').textContent = title;
  // The label is truncated at 52px, so the ordinal would disappear inside it.
  // It gets its own corner badge instead: two Terminals must never be two
  // identical glyphs above two identical truncations.
  const ord = win.task.querySelector('.dock__task-ord');
  ord.textContent = nth.trim();
  ord.classList.toggle('is-hidden', !nth);
}

/**
 * Re-derive the names of every window of one appId. Called after a create and
 * after a close, never only for the window that changed: an ordinal that goes
 * stale is worse than no ordinal, because the user then clicks "Terminal 2" and
 * gets Terminal 3.
 */
function nameSiblings(ws, appId) {
  for (const w of ws.windows.values()) {
    if (!appId || w.appId === appId || !w.appId) nameTask(w);
  }
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
  nameSiblings(ws, win.appId);
  if (ws.lastFocused === id) ws.lastFocused = null;
  syncDockRunning();
  onWindowCountChange?.(ws);
  layoutChanged(ws);

  // On a narrow screen the closed card was the only thing visible; without
  // this the user is dropped on the empty desktop with windows still open.
  if (isNarrow() && ws === current) {
    const next = [...ws.windows.values()]
      .filter((w) => !w.el.classList.contains('is-min'))
      .sort((a, b) => (Number(b.el.style.zIndex) || 0) - (Number(a.el.style.zIndex) || 0))[0];
    if (next) focus(next.id);
  }
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

/* ────────────────────────────────────────── viewport changes ──────────── */

/**
 * Keep every window inside the space that still exists.
 *
 * Before this, halving a browser window left the desktop's absolute offsets
 * untouched: windows kept a 130px left edge and a 960px width and simply ran
 * off the right edge, with no way to reach them (F8). Now each window is pulled
 * back in — but against `pref`, the size the user actually chose, so widening
 * the browser again gives that size back instead of leaving everything stuck at
 * whatever the narrowest moment allowed.
 */
export function clampWindows() {
  const bounds = layersHost().getBoundingClientRect();
  if (bounds.width < 40 || bounds.height < 40) return;   // Mid-layout; try again later.
  let touched = false;

  for (const ws of workspaces) {
    for (const win of ws.windows.values()) {
      const el = win.el;
      const pref = win.pref || { width: el.offsetWidth, height: el.offsetHeight };
      const w = Math.max(280, Math.min(pref.width, Math.round(bounds.width) - 8));
      const h = Math.max(180, Math.min(pref.height, Math.round(bounds.height) - 8));
      const left = clamp(parseFloat(el.style.left) || 0, 0, Math.max(0, bounds.width - w));
      const top = clamp(parseFloat(el.style.top) || 0, 0, Math.max(0, bounds.height - h));

      if (el.style.width !== `${w}px` || el.style.height !== `${h}px`
        || el.style.left !== `${left}px` || el.style.top !== `${top}px`) {
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        win.onResize?.();
        touched = true;
      }
    }
  }
  if (touched) layoutChanged(current);
}

/**
 * `is-narrow` on <body> rather than CSS alone, because the behaviour change is
 * not only visual: drag and resize stop, closing a card promotes the next one.
 * Those are decisions the JS has to know about too.
 */
function syncNarrow() {
  document.body.classList.toggle('is-narrow', isNarrow());
  clampWindows();
  // Entering card mode with nothing focused would show the desktop under a full
  // taskbar; promote the top of the stack instead.
  if (isNarrow() && current && current.windows.size
    && ![...current.windows.values()].some((w) => w.el.classList.contains('is-focused'))) {
    const top = [...current.windows.values()]
      .filter((w) => !w.el.classList.contains('is-min'))
      .sort((a, b) => (Number(b.el.style.zIndex) || 0) - (Number(a.el.style.zIndex) || 0))[0];
    if (top) focus(top.id);
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(syncNarrow, 90);
});
syncNarrow();

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
