/**
 * forwards.js — the port-forwarding form and row renderer.
 *
 * Shared deliberately: the greeter queues forwards before a session exists,
 * the Ports app creates them against a live one. Same fields, same validation,
 * same wording — so what you learn on the login screen still applies later.
 */

import { formatBytes } from './ui.js';
import { escapeHtml } from './wm.js';
import { icon, iconButton } from './icon.js';

export const KIND_HELP = {
  local: 'Listen on this machine, and let the <strong>server</strong> reach the destination. Use this to open a remote database or web app in your local browser.',
  remote: 'Ask the <strong>server</strong> to listen, and let <strong>this machine</strong> reach the destination. Use this to expose something local to the remote host.',
  dynamic: 'Listen on this machine as a <strong>SOCKS5 proxy</strong>, so anything you point at it browses from the server. Point a browser or <code>curl --socks5</code> at it.',
};

/** The fields each forward type actually uses. Everything else is hidden. */
const FIELDS = {
  local:   ['bindAddr', 'bindPort', 'destHost', 'destPort'],
  remote:  ['remoteAddr', 'remotePort', 'destHost', 'destPort'],
  dynamic: ['bindAddr', 'bindPort'],
};

export function forwardFormHtml({ compact = false } = {}) {
  return `
    <div class="fwd-form${compact ? ' fwd-form--compact' : ''}">
      <div class="fwd-form__kinds segmented" role="tablist" data-role="kinds">
        <button type="button" role="tab" class="segmented__btn is-active" data-kind="local">Local  −L</button>
        <button type="button" role="tab" class="segmented__btn" data-kind="remote">Remote  −R</button>
        <button type="button" role="tab" class="segmented__btn" data-kind="dynamic">SOCKS  −D</button>
      </div>

      <p class="fwd-form__help hint hint--block" data-role="help">${KIND_HELP.local}</p>

      <div class="fwd-form__grid">
        <label class="field" data-field="bindAddr">
          <span>Listen on <em>this machine</em></span>
          <input data-in="bindAddr" value="127.0.0.1" spellcheck="false">
        </label>
        <label class="field field--port" data-field="bindPort">
          <span>Port</span>
          <input data-in="bindPort" inputmode="numeric" placeholder="0 = any">
        </label>

        <label class="field" data-field="remoteAddr">
          <span>Listen on <em>the server</em></span>
          <input data-in="remoteAddr" value="127.0.0.1" spellcheck="false">
        </label>
        <label class="field field--port" data-field="remotePort">
          <span>Port</span>
          <input data-in="remotePort" inputmode="numeric" placeholder="0 = any">
        </label>

        <label class="field" data-field="destHost">
          <span>Forward to host</span>
          <input data-in="destHost" value="127.0.0.1" spellcheck="false">
        </label>
        <label class="field field--port" data-field="destPort">
          <span>Port</span>
          <input data-in="destPort" inputmode="numeric" placeholder="5432">
        </label>

        <label class="field field--grow" data-field="label">
          <span>Name <em>optional</em></span>
          <input data-in="label" placeholder="postgres" maxlength="60">
        </label>
      </div>

      <p class="fwd-form__preview" data-role="preview">—</p>
      <p class="alert is-hidden" data-role="error" role="alert"></p>
      <button type="button" class="btn btn--primary" data-role="add">Add forward</button>
    </div>`;
}

/**
 * Wire a form rendered by forwardFormHtml. `onAdd(spec)` may be async and may
 * throw — a rejection is shown inline and the form keeps its values, because
 * retyping four fields after a typo in one is the fastest way to lose a user.
 */
export function wireForwardForm(root, onAdd) {
  const kinds = root.querySelector('[data-role="kinds"]');
  const help = root.querySelector('[data-role="help"]');
  const preview = root.querySelector('[data-role="preview"]');
  const errorBox = root.querySelector('[data-role="error"]');
  const addBtn = root.querySelector('[data-role="add"]');
  const input = (name) => root.querySelector(`[data-in="${name}"]`);

  let kind = 'local';

  function applyKind() {
    kinds.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.kind === kind));
    help.innerHTML = KIND_HELP[kind];
    root.querySelectorAll('[data-field]').forEach((f) => {
      const name = f.dataset.field;
      f.classList.toggle('is-hidden', name !== 'label' && !FIELDS[kind].includes(name));
    });
    updatePreview();
  }

  function read() {
    const spec = { kind, label: input('label').value.trim() };
    for (const name of FIELDS[kind]) spec[name] = input(name).value.trim();
    return spec;
  }

  function updatePreview() {
    const s = read();
    if (kind === 'local') {
      preview.textContent = `${s.bindAddr || '127.0.0.1'}:${s.bindPort || '?'}  →  via server  →  ${s.destHost || '?'}:${s.destPort || '?'}`;
    } else if (kind === 'remote') {
      preview.textContent = `server ${s.remoteAddr || '*'}:${s.remotePort || '?'}  →  via this machine  →  ${s.destHost || '?'}:${s.destPort || '?'}`;
    } else {
      preview.textContent = `SOCKS5 ${s.bindAddr || '127.0.0.1'}:${s.bindPort || '?'}  →  via server  →  anywhere`;
    }
  }

  kinds.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented__btn');
    if (!btn) return;
    kind = btn.dataset.kind;
    applyKind();
  });

  root.addEventListener('input', updatePreview);

  addBtn.addEventListener('click', async () => {
    errorBox.classList.add('is-hidden');
    addBtn.disabled = true;
    try {
      await onAdd(read());
      input('label').value = '';
      if (kind !== 'dynamic') input('destPort').value = '';
      updatePreview();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('is-hidden');
    } finally {
      addBtn.disabled = false;
    }
  });

  applyKind();
  return { read, reset: applyKind };
}

/**
 * The badge for a forward's direction. Each kind gets a distinct shape and the
 * ssh flag stays in the accessible name, so "-L" is still findable by anyone
 * who thinks in ssh flags rather than arrows.
 */
const KIND_BADGE = {
  local:   { name: 'arrow-down-to-line', label: 'Local forward (-L)' },
  remote:  { name: 'arrow-up-from-line', label: 'Remote forward (-R)' },
  dynamic: { name: 'globe', label: 'SOCKS proxy (-D)' },
};

/**
 * One row per forward. `queued` rows are the greeter's: they have no id, no
 * traffic, and no live status yet — only an intention.
 */
export function forwardRowHtml(fwd, { queued = false } = {}) {
  const status = queued ? 'queued' : (fwd.status || 'unknown');
  const traffic = queued
    ? 'opens when you connect'
    : `${fwd.connections} open · ${fwd.total} total`;
  const bytes = queued ? '' :
    `<span class="fwd-row__bytes">${icon('download', { size: 12 })}<span>${formatBytes(fwd.bytesIn || 0)}</span>`
    + `${icon('upload', { size: 12 })}<span>${formatBytes(fwd.bytesOut || 0)}</span></span>`;
  const badge = KIND_BADGE[fwd.kind] || { name: 'circle-alert', label: 'Unknown forward kind' };

  return `
    <div class="fwd-row fwd-row--${status}" data-id="${escapeHtml(fwd.id || '')}">
      <span class="fwd-row__badge" role="img" title="${badge.label}" aria-label="${badge.label}">${icon(badge.name, { size: 15 })}</span>
      <div class="fwd-row__main">
        <div class="fwd-row__title">
          ${fwd.label ? `<strong>${escapeHtml(fwd.label)}</strong>` : ''}
          <code>${escapeHtml(fwd.description || describeSpec(fwd))}</code>
        </div>
        <div class="fwd-row__meta">${escapeHtml(traffic)}${bytes}${fwd.error ? ` · ${escapeHtml(fwd.error)}` : ''}</div>
      </div>
      <span class="fwd-row__status">${status}</span>
      ${iconButton('x', `${queued ? 'Remove from the queue' : 'Close forward'}: ${fwd.description || describeSpec(fwd)}`,
        { size: 14, className: 'fwd-row__x', attrs: 'data-act="remove"' })}
    </div>`;
}

/** Client-side twin of the server's describe(), for rows that never reached it. */
export function describeSpec(s) {
  if (s.kind === 'local') return `${s.bindAddr}:${s.bindPort || 'auto'} → ${s.destHost}:${s.destPort}`;
  if (s.kind === 'remote') return `server ${s.remoteAddr || '*'}:${s.remotePort || 'auto'} → ${s.destHost}:${s.destPort}`;
  return `SOCKS5 ${s.bindAddr}:${s.bindPort || 'auto'}`;
}
