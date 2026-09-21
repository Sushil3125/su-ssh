/**
 * icon.js — one icon system for the whole app.
 *
 * The set is Lucide (ISC, plus MIT for the icons inherited from Feather); the
 * full notice ships verbatim at public/icons/LICENSE.lucide.txt. Every glyph is
 * 24×24 stroke art, so one CSS rule (`.icon` in desktop.css) styles all of them.
 *
 * Returns an HTML string, because every view here is built with template
 * literals. The sprite is an external file (public/icons/icons.svg) referenced
 * with <use>, so the path data is downloaded once and each call site costs ~60
 * bytes instead of repeating the paths.
 *
 * Two gotchas, both load-bearing:
 *   1. Do NOT inline the sprite as a `data:` URI. Chrome removed data:-URI
 *      <use> in 120 and Firefox in 122; Safari never had it.
 *   2. External <use> is same-origin only. Ours is served by our own
 *      express.static, so there is no CDN and no network dependency — but it
 *      also means the app must never be opened from file://.
 *
 * Colour comes from `currentColor`, so an icon is themed by setting `color` on
 * any ancestor — which is how the session colour reaches the taskbar for free.
 *
 * Accessibility: the <svg> is ALWAYS aria-hidden and focusable="false". An icon
 * never carries the name of the thing it sits in; the control does, via
 * aria-label. See iconButton() below.
 */

/**
 * The names the sprite actually contains. Kept here so a typo is a loud console
 * error rather than an invisible gap in a toolbar nobody notices for six months.
 * Regenerate both this list's source (tools/icon-names.json) and the sprite with
 * `node tools/build-sprite.mjs`.
 */
export const NAMES = new Set([
  'folder', 'folder-open', 'file-text', 'image', 'file-archive', 'binary', 'link-2', 'file-question',
  'terminal', 'file-pen', 'settings', 'server', 'network', 'cable', 'globe', 'arrow-right-left',
  'arrow-down-to-line', 'arrow-up-from-line', 'minus', 'square', 'copy', 'x', 'move-diagonal-2',
  'maximize-2', 'house', 'arrow-left', 'arrow-right', 'arrow-up', 'refresh-cw', 'rotate-cw', 'plus',
  'upload', 'download', 'pencil', 'trash-2', 'clipboard-paste', 'search', 'list-filter', 'eraser',
  'save', 'pin', 'pin-off', 'unplug', 'plug-zap', 'shield', 'shield-check', 'chevron-right',
  'chevron-down', 'ellipsis', 'ellipsis-vertical', 'circle-check', 'circle-x', 'circle-alert',
  'triangle-alert', 'circle-dot', 'circle-minus', 'ban', 'play', 'pause', 'zap', 'loader', 'star',
  'keyboard', 'maximize', 'help-circle', 'log-out', 'check', 'lock', 'unlock', 'clock', 'cpu', 'hard-drive',
  'memory-stick', 'activity', 'app-window', 'eye', 'eye-off',
  // File viewers (public/js/viewers.js).
  'file-video', 'file-music', 'file-braces', 'file-spreadsheet', 'file-code', 'zoom-in', 'zoom-out',
  'rotate-ccw', 'chevron-left', 'scan',
]);

/**
 * An icon, as an HTML string.
 * `size` is px; 16 inline in lists, 20 in toolbars and the taskbar, 25 in the dock.
 */
export function icon(name, { size = 20, className = '' } = {}) {
  if (!NAMES.has(name)) {
    console.error(`icon(): unknown icon "${name}"`);
    name = 'circle-alert';
  }
  const cls = ['icon', className].filter(Boolean).join(' ');
  return `<svg class="${cls}" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
       + `<use href="/icons/icons.svg#i-${name}"></use></svg>`;
}

/**
 * An icon-only control. `label` is mandatory and becomes both the accessible
 * name and the tooltip — there is no way to call this and get an unnamed button,
 * which is the entire point. Keeping the two strings identical means a screen
 * reader and a sighted mouse user are told the same thing.
 *
 * State belongs in aria-pressed / aria-current / aria-expanded (pass it through
 * `attrs`), never in the label.
 */
export function iconButton(name, label, { size = 20, className = '', attrs = '' } = {}) {
  if (!label) throw new Error('iconButton() requires a label');
  const safe = escapeHtml(label);
  return `<button type="button" class="iconbtn${className ? ` ${className}` : ''}" `
       + `title="${safe}" aria-label="${safe}"${attrs ? ` ${attrs}` : ''}>${icon(name, { size })}</button>`;
}

/** Local copy rather than an import from wm.js: icon.js is imported by wm.js
 *  itself, and a module with no imports at all cannot be part of a cycle. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** An icon as a real element, for the DOM-building paths that do not use strings. */
export function iconEl(name, opts) {
  const host = document.createElement('span');
  host.className = 'icon-host';
  host.innerHTML = icon(name, opts);
  return host.firstElementChild;
}
