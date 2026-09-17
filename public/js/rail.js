/**
 * rail.js — the host rail: which servers are connected, which one you are on.
 *
 * A rail rather than tabs, and rather than a dropdown. The top bar is already
 * full of meters and the dock is already vertical, so a second vertical strip
 * reads as "which machine" while the dock reads as "which app". A dropdown
 * would hide both how many hosts are connected and their status — and the
 * failure mode this whole feature exists to prevent is acting on the wrong box,
 * which a hidden list makes more likely, not less.
 *
 * Each chip is a real button in the tab order with `aria-current` on the active
 * one, carries the host colour as a 4px bar, the label's initials, a status dot
 * and a window count, and never relies on colour alone: the label is in the
 * accessible name and the tooltip, and the status is a word in both.
 */

import { escapeHtml } from './wm.js';
import {
  allSessions, activeSession, atFull, MAX_PER_TAB, sessionById,
} from './sessions.js';
import { contextMenu } from './ui.js';

const list = () => document.getElementById('rail-list');

let hooks = {};

const STATUS_WORD = {
  connecting: 'connecting',
  connected: 'connected',
  dropped: 'disconnected — connection lost',
};

/**
 * Two characters, chosen from whatever part of the label actually differs
 * between hosts. Words win when there are words ("prod-db" → PD,
 * "deploy@web1" → DW); for a bare IP the letters are all the same `u@` prefix,
 * so the digits at the end — the last octet and the port — are what tells two
 * chips apart.
 */
export function initialsOf(label) {
  const words = String(label).match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2).toUpperCase();
  const digits = String(label).replace(/[^0-9]/g, '');
  return digits.slice(-2) || (words[0] || '?').toUpperCase().padEnd(2, '?');
}

/** Two chips that read alike are worse than no chip, so collisions get a suffix. */
function uniqueInitials(sessions) {
  const seen = new Map();
  return sessions.map((s) => {
    const base = initialsOf(s.label);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  });
}

export function initRail(callbacks) {
  hooks = callbacks;

  list().addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const session = sessionById(btn.closest('.chip').dataset.id);
    if (!session) return;
    if (btn.dataset.act === 'switch') return hooks.onSwitch(session);
    if (btn.dataset.act === 'close') return hooks.onDisconnect(session);
    if (btn.dataset.act === 'reconnect') return hooks.onReconnect(session);
  });

  // Right-click a chip for the things that do not fit in 56 pixels.
  list().addEventListener('contextmenu', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    e.preventDefault();
    const session = sessionById(chip.dataset.id);
    if (!session) return;
    contextMenu(e.clientX, e.clientY, [
      { label: `Switch to ${session.label}`, onClick: () => hooks.onSwitch(session) },
      { label: 'Rename / colour…', onClick: () => hooks.onRename(session) },
      ...(session.status === 'dropped'
        ? [{ label: 'Reconnect…', onClick: () => hooks.onReconnect(session) },
           { label: 'Close', danger: true, onClick: () => hooks.onCloseDropped(session) }]
        : [{ label: 'Disconnect…', danger: true, onClick: () => hooks.onDisconnect(session) }]),
    ]);
  });

  // Left/Right (or Up/Down) move between chips the way a real tab list does.
  list().addEventListener('keydown', (e) => {
    const keys = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
    if (!(e.key in keys)) return;
    const buttons = [...list().querySelectorAll('.chip__main')];
    const at = buttons.indexOf(document.activeElement);
    if (at === -1) return;
    e.preventDefault();
    buttons[(at + keys[e.key] + buttons.length) % buttons.length].focus();
  });

  document.getElementById('rail-add').addEventListener('click', () => hooks.onAdd());
  document.getElementById('rail-menu').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sessions = allSessions();
    contextMenu(rect.right + 4, rect.top, [
      { label: 'Add connection…  (Alt+Shift+N)', onClick: () => hooks.onAdd() },
      'separator',
      ...sessions.map((s) => ({
        label: `${s.label}${s.id === activeSession()?.id ? '  ✓' : ''}`,
        onClick: () => hooks.onSwitch(s),
      })),
      'separator',
      { label: `Disconnect all (${sessions.length})`, danger: true, onClick: () => hooks.onDisconnectAll() },
    ]);
  });
}

export function renderRail() {
  const sessions = allSessions();
  const active = activeSession();

  const initials = uniqueInitials(sessions);
  list().innerHTML = sessions.map((s, i) => {
    const count = s.workspace ? s.workspace.windows.size : 0;
    const tip = `${s.label} · ${s.username}@${s.host}:${s.port} · ${STATUS_WORD[s.status]}`
      + ` · ${count} window${count === 1 ? '' : 's'}`
      + (i < MAX_PER_TAB ? ` · Alt+Shift+${i + 1}` : '');
    return `
      <div class="chip${s.id === active?.id ? ' is-active' : ''} chip--${s.status}" data-id="${s.id}" style="--chip-color:${escapeHtml(s.color)}">
        <button type="button" class="chip__main" role="tab" data-act="switch"
                aria-current="${s.id === active?.id}" aria-selected="${s.id === active?.id}"
                title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
          <span class="chip__bar" aria-hidden="true"></span>
          <span class="chip__initials">${escapeHtml(initials[i])}</span>
          <span class="chip__dot" aria-hidden="true"></span>
          ${count ? `<span class="chip__count" aria-hidden="true">${count}</span>` : ''}
          ${s.activity ? '<span class="chip__activity" aria-hidden="true"></span>' : ''}
          ${s.env ? `<span class="chip__env">${escapeHtml(s.env)}</span>` : ''}
        </button>
        ${s.status === 'dropped'
          ? `<button type="button" class="chip__act" data-act="reconnect" title="Reconnect ${escapeHtml(s.label)}" aria-label="Reconnect ${escapeHtml(s.label)}">⟳</button>`
          : `<button type="button" class="chip__act" data-act="close" title="Disconnect ${escapeHtml(s.label)}" aria-label="Disconnect ${escapeHtml(s.label)}">✕</button>`}
      </div>`;
  }).join('');

  const add = document.getElementById('rail-add');
  add.disabled = atFull();
  add.title = atFull()
    ? `Limit of ${MAX_PER_TAB} connections reached. Disconnect one first.`
    : 'Add a connection  (Alt+Shift+N)';
  document.getElementById('rail').classList.toggle('is-hidden', sessions.length === 0);
}

/**
 * Alt+Shift+digit / bracket / N, matched on `event.code`.
 *
 * `code` rather than `key` because on macOS Option+Shift+1 produces a
 * typographic character, not "1", and on a non-US layout the bracket keys are
 * somewhere else entirely. Capture phase at `window` so we win before xterm,
 * and `preventDefault` + `stopImmediatePropagation` so nothing reaches the PTY.
 *
 * Alt+Shift is free: bash, readline, vim and tmux leave it alone, and neither
 * Chrome nor Firefox binds it on Linux or Windows. (Ctrl+1..9 and Ctrl+K, which
 * the research suggested, are browser tab switching and the address bar.)
 */
export function railShortcut(e) {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
  const digit = /^Digit([1-8])$/.exec(e.code);
  if (digit) return { kind: 'jump', index: Number(digit[1]) - 1 };
  if (e.code === 'BracketLeft') return { kind: 'prev' };
  if (e.code === 'BracketRight') return { kind: 'next' };
  if (e.code === 'KeyN') return { kind: 'add' };
  return null;
}
