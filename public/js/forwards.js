/**
 * forwards.js — the port-forwarding form and row renderer.
 *
 * Shared deliberately: the greeter queues forwards before a session exists,
 * the Ports app creates them against a live one. Same fields, same validation,
 * same wording — so what you learn on the login screen still applies later.
 */

import { formatBytes } from './ui.js';
import { escapeHtml } from './wm.js';

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

const KIND_BADGE = { local: '−L', remote: '−R', dynamic: '−D' };

/**
 * The address a running forward actually answers on — the reason the tunnel
 * exists, and until now the one thing the Ports app would not tell you (F11/S5).
 *
 * `listenPort` rather than `bindPort`: when the user asks for port 0 the relay
 * picks one, and showing the requested port would hand somebody a
 * `localhost:0` to paste into a config file.
 *
 * Only a local forward is openable in a browser. A SOCKS proxy is something you
 * point a browser *at*, not somewhere you navigate to, and a remote forward
 * listens on the server, where this browser has no route. Both still get a
 * copyable address, because pasting it somewhere is the whole job.
 */
export function forwardAddress(fwd) {
  const port = fwd.listenPort || fwd.bindPort || fwd.remotePort;
  if (!port || String(port) === '0') return null;
  if (fwd.kind === 'local') {
    const host = fwd.bindAddr || '127.0.0.1';
    return { text: `${host}:${port}`, url: `http://${host}:${port}`, note: 'listening on this machine' };
  }
  if (fwd.kind === 'dynamic') {
    return { text: `socks5://${fwd.bindAddr || '127.0.0.1'}:${port}`, url: null, note: 'SOCKS5 proxy on this machine' };
  }
  return { text: `${fwd.remoteAddr || '127.0.0.1'}:${port}`, url: null, note: 'listening on the server' };
}

/** The same words the greeter uses, so "queued" means one thing in both places. */
const STATUS_WORD = {
  queued: 'queued', active: 'active', error: 'failed', stopped: 'closed', unknown: 'unknown',
};

/**
 * One row per forward. `queued` rows are the greeter's: they have no id, no
 * traffic, and no live status yet — only an intention. `actions` adds the
 * copy/open buttons, which only the live Ports app can offer.
 */
export function forwardRowHtml(fwd, { queued = false, actions = false } = {}) {
  const status = queued ? 'queued' : (fwd.status || 'unknown');
  const traffic = queued
    ? 'opens when you connect'
    : `${fwd.connections} open · ${fwd.total} total · ↓${formatBytes(fwd.bytesIn || 0)} ↑${formatBytes(fwd.bytesOut || 0)}`;

  const addr = actions && status === 'active' ? forwardAddress(fwd) : null;
  const addrLine = addr
    ? `<div class="fwd-row__addr"><code>${escapeHtml(addr.text)}</code><em>${escapeHtml(addr.note)}</em></div>`
    : '';
  const addrActions = addr
    ? `<button class="fwd-row__act" data-act="copy" data-addr="${escapeHtml(addr.text)}"
               title="Copy ${escapeHtml(addr.text)}" aria-label="Copy address ${escapeHtml(addr.text)}">Copy</button>`
      + (addr.url
        ? `<button class="fwd-row__act" data-act="open" data-url="${escapeHtml(addr.url)}"
                   title="Open ${escapeHtml(addr.url)} in a new tab" aria-label="Open ${escapeHtml(addr.url)} in a browser tab">Open</button>`
        : '')
    : '';

  return `
    <div class="fwd-row fwd-row--${status}" data-id="${escapeHtml(fwd.id || '')}">
      <span class="fwd-row__badge">${KIND_BADGE[fwd.kind] || '?'}</span>
      <div class="fwd-row__main">
        <div class="fwd-row__title">
          ${fwd.label ? `<strong>${escapeHtml(fwd.label)}</strong>` : ''}
          <code>${escapeHtml(fwd.description || describeSpec(fwd))}</code>
        </div>
        ${addrLine}
        <div class="fwd-row__meta">${escapeHtml(traffic)}${fwd.error ? ` · ${escapeHtml(fwd.error)}` : ''}</div>
      </div>
      <div class="fwd-row__acts">${addrActions}</div>
      <span class="fwd-row__status fwd-row__status--${status}">${STATUS_WORD[status] || escapeHtml(status)}</span>
      <button class="fwd-row__x" data-act="remove" title="${queued ? 'Remove from the queue' : 'Close this forward'}" aria-label="${queued ? 'Remove from the queue' : 'Close this forward'}">✕</button>
    </div>`;
}

/** Client-side twin of the server's describe(), for rows that never reached it. */
export function describeSpec(s) {
  if (s.kind === 'local') return `${s.bindAddr}:${s.bindPort || 'auto'} → ${s.destHost}:${s.destPort}`;
  if (s.kind === 'remote') return `server ${s.remoteAddr || '*'}:${s.remotePort || 'auto'} → ${s.destHost}:${s.destPort}`;
  return `SOCKS5 ${s.bindAddr}:${s.bindPort || 'auto'}`;
}
