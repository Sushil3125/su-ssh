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
