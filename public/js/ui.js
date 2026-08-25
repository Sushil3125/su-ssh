/** ui.js — toasts and the right-click menu, shared by every app. */

export function toast(message, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(16px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/** items: [{ label, onClick, danger }] or 'separator' */
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
    btn.className = `ctxmenu__item${item.danger ? ' ctxmenu__item--danger' : ''}`;
    btn.textContent = item.label;
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
 * `fields` entries: { name, label, type, value, placeholder, hint }.
 */
export function openDialog({
  title,
  message = '',
  fields = [],
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  dismissable = true,
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

    wrap.querySelector('.modal__title').textContent = title;
    const msg = wrap.querySelector('.modal__msg');
    msg.textContent = message;
    msg.classList.toggle('is-hidden', !message);
    wrap.querySelector('[data-act="ok"]').textContent = confirmLabel;
    if (cancelLabel) wrap.querySelector('[data-act="cancel"]').textContent = cancelLabel;

    const fieldHost = wrap.querySelector('.modal__fields');
    for (const field of fields) {
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML = `<span></span><input class="modal__input"><em class="modal__hint"></em>`;
      label.querySelector('span').textContent = field.label || field.name;
      const input = label.querySelector('input');
      input.type = field.type || 'text';
      input.value = field.value || '';
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.name = field.name;
      const hint = label.querySelector('.modal__hint');
      hint.textContent = field.hint || '';
      hint.classList.toggle('is-hidden', !field.hint);
      fieldHost.appendChild(label);
    }
    fieldHost.classList.toggle('is-hidden', !fields.length);

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
export async function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return (await openDialog({ title, message, confirmLabel, cancelLabel, danger })) !== null;
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
export async function promptSecret({ title = 'Password required', message = '', confirmLabel = 'Continue' } = {}) {
  const result = await openDialog({
    title, message, confirmLabel,
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

export const GLYPH = {
  directory: '📁',
  text: '📄',
  image: '🖼️',
  pdf: '📕',
  archive: '🗜️',
  binary: '⚙️',
};
