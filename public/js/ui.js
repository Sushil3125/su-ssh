/** ui.js — toasts and the right-click menu, shared by every app. */

import { icon } from './icon.js';

/**
 * The container is an `aria-live="polite"` region (see index.html), so every
 * toast is announced instead of being visible only to people who happen to be
 * looking at the bottom-right corner. Failures additionally carry `role="alert"`,
 * which is announced assertively: "Saved" can wait for a pause in speech,
 * "Permission denied writing /etc/nginx.conf" cannot. The role is set before the
 * node is inserted, because a live region only announces what changes *after*
 * it is in the document.
 */
export function toast(message, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  if (kind === 'bad') el.setAttribute('role', 'alert');
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(16px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/** items: [{ label, onClick, danger, icon }] or 'separator' */
export function contextMenu(x, y, items) {
  const menu = document.getElementById('ctxmenu');
  menu.innerHTML = '';

  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'ctxmenu__sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctxmenu__item${item.danger ? ' ctxmenu__item--danger' : ''}`;
    // The label stays the accessible name; the icon is decoration beside it,
    // which is why it goes in its own aria-hidden slot rather than the text.
    const slot = document.createElement('span');
    slot.className = 'ctxmenu__icon';
    slot.setAttribute('aria-hidden', 'true');
    if (item.icon) slot.innerHTML = icon(item.icon, { size: 15 });
    const text = document.createElement('span');
    text.className = 'ctxmenu__label';
    text.textContent = item.label;
    btn.append(slot, text);
    btn.addEventListener('click', () => { hideContextMenu(); item.onClick(); });
    menu.appendChild(btn);
  }

  menu.classList.remove('is-hidden');
  // Measure after showing, then nudge back inside the viewport if it overflows.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

export function hideContextMenu() {
  document.getElementById('ctxmenu').classList.add('is-hidden');
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.ctxmenu')) hideContextMenu();
});
window.addEventListener('blur', hideContextMenu);

/* ═══════════════════════════════════════════════════════════ dialogs ═══ */

/**
 * One modal primitive, three wrappers. The browser's alert/confirm/prompt are
 * not used anywhere in this app: they freeze the whole page (so a streaming log
 * or a live terminal stalls behind them), they cannot be styled, and Chrome
 * suppresses them outright after a few in a row — which would silently turn a
 * "delete this file?" guard into a deletion.
 *
 * Resolves to an object of field values, or null if the user backed out.
 * `fields` entries: { name, label, type, value, placeholder, hint, readonly }.
 */
export function openDialog({
  title,
  message = '',
  fields = [],
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  dismissable = true,
  requireText = null,
  requireLabel = '',
  accent = null,
  titleIcon = null,
} = {}) {
  return new Promise((resolve) => {
    const host = document.getElementById('modals');
    const previous = document.activeElement;

    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <form class="modal__card" role="dialog" aria-modal="true">
        <h2 class="modal__title"></h2>
        <p class="modal__msg"></p>
        <div class="modal__fields"></div>
        <div class="modal__row">
          ${cancelLabel ? `<button type="button" class="btn" data-act="cancel"></button>` : ''}
          <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok"></button>
        </div>
      </form>`;

    const titleEl = wrap.querySelector('.modal__title');
    titleEl.textContent = title;
    // Prepended, not concatenated into the string: the icon must not become
    // part of the heading's accessible name.
    if (titleIcon) titleEl.insertAdjacentHTML('afterbegin', icon(titleIcon, { size: 18, className: 'icon--warn' }));
    const msg = wrap.querySelector('.modal__msg');
    msg.textContent = message;
    msg.classList.toggle('is-hidden', !message);
    wrap.querySelector('[data-act="ok"]').textContent = confirmLabel;
    if (cancelLabel) wrap.querySelector('[data-act="cancel"]').textContent = cancelLabel;

    // The session colour on the dialog's edge: a confirm raised for production
    // should not look like any other confirm, at a glance and in a screenshot.
    if (accent) wrap.querySelector('.modal__card').style.setProperty('--session-color', accent);
    wrap.querySelector('.modal__card').classList.toggle('modal__card--accented', !!accent);

    // A production host asks you to type its name. Not theatre: it is the only
    // guard that survives muscle memory, because the muscle memory is
    // "Enter on the red button".
    const allFields = requireText
      ? [...fields, { name: '__confirmText', label: requireLabel || `Type ${requireText} to confirm`, placeholder: requireText }]
      : fields;

    const fieldHost = wrap.querySelector('.modal__fields');
    for (const field of allFields) {
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML = `<span></span><input class="modal__input"><em class="modal__hint"></em>`;
      label.querySelector('span').textContent = field.label || field.name;
      const input = label.querySelector('input');
      input.type = field.type || 'text';
      input.value = field.value || '';
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
    // Read-only fields show values the user should inspect or copy (a host key
    // fingerprint, a command) without implying they can be edited.
    input.readOnly = !!field.readonly;
      input.spellcheck = false;
      input.dataset.name = field.name;
      const hint = label.querySelector('.modal__hint');
      hint.textContent = field.hint || '';
      hint.classList.toggle('is-hidden', !field.hint);
      fieldHost.appendChild(label);
    }
    fieldHost.classList.toggle('is-hidden', !allFields.length);

    const okBtn = wrap.querySelector('[data-act="ok"]');
    if (requireText) {
      const input = fieldHost.querySelector('[data-name="__confirmText"]');
      const check = () => { okBtn.disabled = input.value.trim() !== requireText; };
      input.addEventListener('input', check);
      check();
    }

    host.appendChild(wrap);

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      wrap.remove();
      // Put focus back where it was, or the next Tab starts from the top of
      // the page and keyboard users lose their place entirely.
      try { previous?.focus?.(); } catch { /* the element may be gone */ }
      resolve(value);
    };

    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (okBtn.disabled) return;
      const result = {};
      for (const input of fieldHost.querySelectorAll('input')) result[input.dataset.name] = input.value;
      done(result);
    });

    wrap.querySelector('[data-act="cancel"]')?.addEventListener('click', () => done(null));

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); done(null); }
      if (e.key !== 'Tab') return;
      // Trap Tab inside the dialog: a modal you can Tab out of is a modal that
      // lets you type into the window behind it.
      const focusable = [...wrap.querySelectorAll('input, button')].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    if (dismissable) {
      wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(null); });
    }

    (fieldHost.querySelector('input') || wrap.querySelector('[data-act="ok"]')).focus();
    fieldHost.querySelector('input')?.select();
  });
}

/** Yes/no. Resolves true only on an explicit confirm. */
export async function confirmDialog({
  title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, requireText = null, requireLabel = '', accent = null, titleIcon = null,
} = {}) {
  return (await openDialog({ title, message, confirmLabel, cancelLabel, danger, requireText, requireLabel, accent, titleIcon })) !== null;
}

/**
 * Is a modal open right now?
 *
 * Switching sessions is blocked while one is: a confirm or a sudo prompt was
 * raised *by* a session, and answering it while looking at a different desktop
 * is precisely the mistake this feature exists to prevent.
 */
export function modalOpen() {
  return document.getElementById('modals').childElementCount > 0;
}

/** One line of text. Resolves to the string, or null if cancelled. */
export async function promptDialog({ title, message = '', label = '', value = '', placeholder = '', confirmLabel = 'OK' } = {}) {
  const result = await openDialog({
    title, message, confirmLabel,
    fields: [{ name: 'value', label: label || title, value, placeholder }],
  });
  return result ? result.value : null;
}

/** Something the user only needs to acknowledge. */
export function alertDialog({ title, message = '', confirmLabel = 'Close' } = {}) {
  return openDialog({ title, message, confirmLabel, cancelLabel: '' });
}

/**
 * Ask for a secret. Nothing here caches it: it lives in the resolved string
 * for as long as the caller holds it, so a tab left open on a shared screen is
 * never a standing root shell.
 */
export async function promptSecret({ title = 'Password required', message = '', confirmLabel = 'Continue', accent = null } = {}) {
  const result = await openDialog({
    title, message, confirmLabel, accent,
    fields: [{ name: 'password', label: 'sudo password', type: 'password' }],
  });
  return result?.password || null;
}

export function formatBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * File kind -> Lucide icon name (+ an optional tint class). Lucide has no PDF
 * glyph, so a PDF is a red `file-text`: a tint plus the filename says more than
 * an invented glyph would.
 */
export const GLYPH = {
  directory: { name: 'folder' },
  text:      { name: 'file-text' },
  image:     { name: 'image' },
  video:     { name: 'file-video' },
  audio:     { name: 'file-music' },
  pdf:       { name: 'file-text', className: 'icon--bad' },
  archive:   { name: 'file-archive' },
  binary:    { name: 'binary' },
  symlink:   { name: 'link-2' },
  broken:    { name: 'file-question', className: 'icon--warn' },
};

/** Text files the viewers render as something richer get a glyph that says so. */
const TEXT_GLYPH = { json: 'file-braces', csv: 'file-spreadsheet', tsv: 'file-spreadsheet' };
function byExtension(entry) {
  if (entry.kind !== 'text') return null;
  const ext = String(entry.name || '').split('.').pop().toLowerCase();
  return TEXT_GLYPH[ext] ? { name: TEXT_GLYPH[ext] } : null;
}

/** The icon markup for a directory entry, at `size` px. */
export function fileIcon(entry, size = 30) {
  const g = (entry.broken && GLYPH.broken) || byExtension(entry) || GLYPH[entry.kind] || GLYPH.binary;
  return icon(g.name, { size, className: g.className || '' });
}
