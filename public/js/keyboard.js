/**
 * keyboard.js — stop the browser eating the terminal's keys.
 *
 * The user's complaint was "Ctrl+W in nano closes the tab". The honest answer
 * has three layers, and this file is all three:
 *
 *   Layer 0  Always on, every browser, no mode and no setting. While a terminal
 *            owns the keyboard we `preventDefault()` the Ctrl chords the browser
 *            is *willing* to give up, so nano's Ctrl+K/O/R/U/G/E and vi's chords
 *            reach the PTY instead of opening Find, Downloads or the address bar.
 *            Plus selection-aware Ctrl+C and the Ctrl+Shift+C/V that xterm has
 *            no binding for.
 *   Layer 1  "Capture keys" — JS-initiated fullscreen + `navigator.keyboard.lock()`.
 *            Chromium only. The *only* thing that recovers Ctrl+W, Ctrl+T, Ctrl+N.
 *   Layer 2  Installed-app window (manifest.webmanifest). Passive; Chromium
 *            reserves nothing at all in an app window. No UI of ours.
 *
 * Why Layer 0 can never recover Ctrl+W: both browsers keep a short list of
 * *reserved* chords handled by browser UI before the page sees a `keydown` at
 * all — Chromium's `BrowserCommandController::IsReservedCommandOrKey`
 * (IDC_CLOSE_TAB, IDC_NEW_TAB, IDC_NEW_WINDOW, IDC_EXIT, the tab-cycling
 * commands …) and Firefox's `reserved="true"` keys in `browser-sets.inc`
 * (Ctrl+N/T/W, Ctrl+Shift+W/P, Ctrl+Q). There is no `keydown` to preventDefault.
 * Everything *not* on those lists is ours the moment we ask for it — which is
 * the entire rest of the terminal's keyboard.
 */

import { toast } from './ui.js';

/* ════════════════════════════════════════════════════════ layer 0 ══════ */

/**
 * Ctrl chords a terminal wants and the browser is willing to surrender, keyed
 * by `event.code` so a non-US layout and macOS's Option-makes-a-glyph behaviour
 * do not break the match.
 *
 * Deliberately absent: KeyW, KeyT, KeyN, KeyQ and Tab. They never arrive in a
 * normal tab, so listing them would be a lie in the source as well as the UI.
 * Recovering those is what Layer 1 is for.
 */
export const TERMINAL_CLAIMS = new Set([
  'KeyA', 'KeyB', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK',
  'KeyL', 'KeyO', 'KeyP', 'KeyR', 'KeyS', 'KeyU', 'KeyX', 'KeyY',
]);

/** xterm's hidden textarea lives inside `.termhost`. */
export const terminalHasFocus = () => !!document.activeElement?.closest?.('.termhost');

/**
 * The whole of Layer 0's window half.
 *
 * The asymmetry is the trick: `preventDefault()` suppresses the *browser's*
 * action, while leaving the event propagating so xterm still receives it and
 * still writes the control byte to the PTY. `stopPropagation()` here would fix
 * the browser and break the terminal, which is the wrong half of the bug.
 *
 * Capture phase, but registered after main.js's rail handler so the
 * Alt+Shift family is consumed first (that one does stopImmediatePropagation).
 */
export function installTerminalKeyClaims() {
  window.addEventListener('keydown', (e) => {
    if (!terminalHasFocus()) return;              // editor Ctrl+S, greeter, dialogs keep theirs
    if (!e.ctrlKey || e.metaKey || e.altKey) return;
    if (!TERMINAL_CLAIMS.has(e.code)) return;
    e.preventDefault();
  }, true);
}

/* ═══════════════════════════════════════════════════════ clipboard ════ */

/**
 * Copy is the reliable half: `clipboard-write` is granted by default and only
 * wants a focused document plus the transient activation a keydown already
 * carries. If even that fails we say which platform gesture still works rather
 * than failing silently.
 */
export async function copySelection(term) {
  const text = term.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    term.clearSelection();
  } catch {
    toast('Could not write to the clipboard. Select and press Ctrl+Insert instead.', 'bad', 6000);
  }
}

/**
 * Paste is the unreliable half, and that is why it is never the only path.
 * `clipboard-read` starts as `prompt`; a user who denies it loses nothing,
 * because Ctrl+V, Shift+Insert and middle-click all go through xterm's own DOM
 * `paste` handler, which needs no permission and applies bracketed paste.
 * `term.paste()` routes through the same bracketing, so a multi-line paste is
 * safe against a shell with DECSET 2004 on.
 */
export async function pasteFromClipboard(term) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    toast('Your browser blocked reading the clipboard. Press Ctrl+V or Shift+Insert to paste.', 'bad', 6000);
  }
}

/* ════════════════════════════════════════════════════════ layer 1 ═════ */

/**
 * Locking a named list rather than calling `lock()` with no argument: a blanket
 * lock takes the entire keyboard, which is the behaviour that worried Chrome
 * enough to trial (and then withdraw) a permission prompt for this API.
 *
 * `Escape` is in the list on purpose. With it locked, a *tap* is delivered to
 * the page — so vi, nano and every TUI still work — and a ~2 second *hold*
 * exits fullscreen and the lock. That is exactly a terminal's requirement.
 *
 * Meta/Super is deliberately absent: it opens the desktop's own launcher and
 * fighting the OS for it is a losing and unfriendly game. Alt+Tab, Ctrl+Alt+Del
 * and Alt+F4 cannot be taken by this API at all — the spec exempts platform
 * secure-attention sequences.
 */
export const CAPTURE_KEYS = [
  'KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyR', 'KeyL', 'KeyD', 'KeyF', 'KeyP',
  'KeyO', 'KeyU', 'KeyJ', 'KeyH', 'KeyK', 'KeyE', 'KeyS', 'KeyG',
  'Tab', 'Escape', 'F1', 'F3', 'F5', 'F11', 'F12',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
];

/**
 * Feature detection, not user-agent sniffing. False in Firefox and Safari,
 * where `navigator.keyboard` has never existed and — seven years after Chrome
 * 68 shipped it — shows no sign of arriving.
 */
export const captureSupported = () =>
  typeof navigator !== 'undefined'
  && 'keyboard' in navigator
  && typeof navigator.keyboard?.lock === 'function';

export const captureActive = () => !!document.fullscreenElement;

/**
 * Fullscreen first: `lock()` only takes effect under a JS-initiated fullscreen
 * (explicitly not under the user's own F11), and both calls spend the transient
 * activation of the click or keypress that got us here.
 */
export async function enterCapture() {
  if (!captureSupported()) return { ok: false, reason: 'unsupported' };
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await navigator.keyboard.lock(CAPTURE_KEYS);
    return { ok: true };
  } catch (err) {
    // Roll back a half-entered state. Fullscreen with no lock is worse than
    // neither: the chip would promise a capture we do not have, and the user
    // would find out by closing their tab mid-`nano`.
    try { navigator.keyboard?.unlock?.(); } catch { /* unlock never throws in practice */ }
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* already gone */ } }
    return { ok: false, reason: err?.name || 'failed' };
  }
}

export async function exitCapture() {
  try { navigator.keyboard?.unlock?.(); } catch { /* see above */ }
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* already gone */ } }
}

let captureBtn = null;

/**
 * The chip is painted from `fullscreenchange` and from nothing else — never
 * from our own click handler. Hold-Escape, F11 and the window manager can all
 * end fullscreen without telling us, and an indicator that can lie about
 * whether Ctrl+W is safe is worse than no indicator at all.
 */
function paintCaptureChip() {
  if (!captureBtn) return;
  const on = captureActive();
  captureBtn.setAttribute('aria-pressed', String(on));
  captureBtn.classList.toggle('is-on', on);
  const label = captureBtn.querySelector('.topbar__btn-label');
  if (label) label.textContent = on ? 'Keys captured' : 'Capture keys';
  document.getElementById('shell')?.classList.toggle('is-captured', on);
  if (!captureSupported()) {
    captureBtn.title = 'Capture keys — not available in this browser (Chrome or Edge only)';
  } else {
    captureBtn.title = on
      ? 'Keys captured — hold Esc for two seconds to leave  (Alt+Shift+K)'
      : 'Capture keyboard — send Ctrl+W, Ctrl+T and Ctrl+N to the terminal  (Alt+Shift+K)';
  }
}

export async function toggleCapture() {
  if (captureActive()) return void exitCapture();

  if (!captureSupported()) {
    toast('Only Chrome and Edge let a page take Ctrl+W back from the browser. '
      + 'Everything else already works here.', 'info', 7000);
    openShortcutsPanel('limits');
    return;
  }

  const res = await enterCapture();
  if (res.ok) {
    toast('Keyboard captured. Ctrl+W, Ctrl+T and Ctrl+N now go to the terminal. '
      + 'Hold Esc for two seconds to leave.', 'good', 7000);
  } else {
    toast(`Could not capture the keyboard (${res.reason}). The browser keeps Ctrl+W for now.`, 'bad', 6000);
  }
  // Not painted here: fullscreenchange does it, success or failure.
}

export function initCapture() {
  captureBtn = document.getElementById('btn-capture');
  if (captureBtn) {
    captureBtn.addEventListener('click', () => { toggleCapture(); });
    if (!captureSupported()) captureBtn.classList.add('is-unsupported');
  }
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => openShortcutsPanel());

  document.addEventListener('fullscreenchange', () => {
    // Chrome unlocks implicitly when fullscreen ends; this is belt and braces
    // for the paths where it does not, and it is documented as safe to call
    // unconditionally.
    if (!document.fullscreenElement) { try { navigator.keyboard?.unlock?.(); } catch { /* ignore */ } }
    paintCaptureChip();
  });

  paintCaptureChip();
}

/* ══════════════════════════════════════════════ the beforeunload guard ═ */

/**
 * Narrowly scoped on purpose. `beforeunload` is the only thing standing between
 * a misfired nano Ctrl+W and a dead root shell on a production box — but it
 * also fires on every deliberate reload, and the browser's dialog text cannot
 * be customised, so an always-on guard is a generic nag.
 *
 * So: register it only while at least one session is live *and* has at least
 * one terminal window open. Never on the greeter, never on a desktop showing
 * only a Files window.
 */
let guardOn = false;
const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };

export function makeUnloadGuard(allSessions) {
  return function syncUnloadGuard() {
    // 'connected' and not merely "not dropped": a session still in 'connecting'
    // has no shell yet, and a 'dropped' one has already lost it.
    const atRisk = allSessions().some((s) => s.status === 'connected'
      && [...(s.workspace?.windows?.values?.() || [])].some((w) => w.appId === 'terminal'));
    if (atRisk === guardOn) return;
    guardOn = atRisk;
    if (atRisk) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

/** Exposed for the test harness; there is no other way to observe a listener. */
export const unloadGuardArmed = () => guardOn;

/* ═══════════════════════════════════════════ the shortcuts help panel ══ */

const mod = () => (navigator.platform?.startsWith?.('Mac') ? 'Cmd' : 'Ctrl');

/**
 * What each browser keeps for itself, in a normal tab. This is the table the
 * user's complaint lands on, and it is deliberately blunt: the app cannot fix
 * these and pretending otherwise would waste their afternoon.
 */
const KEPT = [
  ['Ctrl+W', 'Close tab', 'kept', 'kept', 'Capture keys, or install as an app'],
  ['Ctrl+T', 'New tab', 'kept', 'kept', 'Capture keys, or install as an app'],
  ['Ctrl+N', 'New window', 'kept', 'kept', 'Capture keys, or install as an app'],
  ['Ctrl+Shift+W', 'Close window', 'kept', 'kept', 'Capture keys'],
  ['Ctrl+Shift+T', 'Reopen closed tab', 'kept', 'yours', '—'],
  ['Ctrl+Shift+N / Ctrl+Shift+P', 'Private window', 'kept', 'kept', 'Capture keys'],
  ['Ctrl+Q', 'Quit the browser', 'kept', 'kept', 'Capture keys'],
  ['Ctrl+Tab', 'Next tab', 'kept', 'probably kept', 'Capture keys'],
  ['Alt+Tab, Super, Ctrl+Alt+Del', 'The operating system', 'kept', 'kept', 'Nothing. Ever.'],
];

const APP_KEYS = [
  ['Alt+Shift+1 … 8', 'Switch to that connection'],
  ['Alt+Shift+[ / ]', 'Previous / next connection'],
  ['Alt+Shift+N', 'New connection'],
  ['Alt+Shift+K', 'Toggle Capture keys'],
  ['Alt+Shift+H', 'This panel'],
  ['Ctrl+S', 'Save — in the editor only, never in a terminal'],
];

const CLIP_KEYS = () => [
  [`${mod()}+C with a selection`, 'Copies the selection. No SIGINT is sent.'],
  [`${mod()}+C with nothing selected`, 'SIGINT, exactly as always.'],
  ['Ctrl+Shift+C', 'Always copies the selection.'],
  [`${mod()}+V, Shift+Insert, middle-click`, 'Paste, with bracketed paste. Never prompts.'],
  ['Ctrl+Shift+V', 'Paste. May ask the browser for clipboard permission — deny it and Ctrl+V still works.'],
  ['Right-click in a terminal', 'Copy / Paste / Select all / Clear.'],
];

const row = (cells, tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let panel = null;

/**
 * A plain overlay rather than `openDialog`: that primitive renders a list of
 * single-line text inputs, which is the wrong shape for three tables. It keeps
 * the same manners — Escape closes, focus is restored, Tab is trapped.
 */
export function openShortcutsPanel(scrollTo = null) {
  if (panel) { panel.querySelector(`#kbd-${scrollTo || 'limits'}`)?.scrollIntoView(); return; }
  const previous = document.activeElement;

  panel = document.createElement('div');
  panel.className = 'modal';
  panel.innerHTML = `
    <div class="modal__card modal__card--wide" role="dialog" aria-modal="true" aria-labelledby="kbd-title">
      <h2 class="modal__title" id="kbd-title">Keyboard</h2>
      <div class="kbd-panel">
        <section id="kbd-limits">
          <h3>Why some shortcuts don't work</h3>
          <p>Every browser keeps a short list of shortcuts for itself and handles them before this
             page ever sees the key. su-ssh already takes back everything that is not on that list —
             nano's Ctrl+K, Ctrl+O, Ctrl+R, Ctrl+U, Ctrl+G and every vi chord reach the shell.
             The handful below are the browser's, and no web page can change that in a normal tab.</p>
          <p class="kbd-capture-line"></p>
          <table class="kbd-table">
            ${row(['Shortcut', 'The browser does', 'Chrome / Edge', 'Firefox', 'How to get it back'], 'th')}
            ${KEPT.map((r) => row(r.map(esc))).join('')}
          </table>
          <p class="hint">On macOS none of this bites: the browser's commands live on Command and a
             terminal's live on Control. They do not collide.</p>
        </section>
        <section id="kbd-capture">
          <h3>Capture keys</h3>
          <p>Puts the page into fullscreen and asks Chromium's Keyboard Lock API for the keys above,
             so Ctrl+W goes to the terminal instead of closing the tab. Firefox and Safari have never
             implemented this API, so the button is disabled there and says so.</p>
          <p>Leave it by holding <kbd>Esc</kbd> for about two seconds, by pressing Alt+Shift+K, or by
             clicking the chip. A <em>tap</em> of Esc still goes to the terminal, so vi and nano are
             unaffected. Alt+Tab and Super always belong to the operating system.</p>
        </section>
        <section id="kbd-app">
          <h3>su-ssh shortcuts</h3>
          <table class="kbd-table">${APP_KEYS.map((r) => row(r.map(esc))).join('')}</table>
          <p class="hint">Alt+Shift is used because bash, readline, vim and tmux all leave it alone,
             and neither browser binds it.</p>
        </section>
        <section id="kbd-clip">
          <h3>Terminal copy and paste</h3>
          <table class="kbd-table">${CLIP_KEYS().map((r) => row(r.map(esc))).join('')}</table>
        </section>
      </div>
      <div class="modal__row">
        <button type="button" class="btn" data-act="capture"></button>
        <button type="button" class="btn btn--primary" data-act="close">Close</button>
      </div>
    </div>`;

  const capBtn = panel.querySelector('[data-act="capture"]');
  const line = panel.querySelector('.kbd-capture-line');
  if (captureSupported()) {
    capBtn.textContent = captureActive() ? 'Stop capturing keys' : 'Capture keys now';
    capBtn.addEventListener('click', () => { closeShortcutsPanel(); toggleCapture(); });
    line.textContent = 'This browser can take them back — turn on Capture keys in the top bar, or here.';
  } else {
    capBtn.disabled = true;
    capBtn.textContent = 'Capture keys — Chrome or Edge only';
    line.textContent = 'This browser has no Keyboard Lock API, so Ctrl+W, Ctrl+T and Ctrl+N cannot be '
      + 'recovered here at all. Everything else works. Open su-ssh in Chrome or Edge if you need them.';
  }

  panel.querySelector('[data-act="close"]').addEventListener('click', closeShortcutsPanel);
  panel.addEventListener('pointerdown', (e) => { if (e.target === panel) closeShortcutsPanel(); });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); return void closeShortcutsPanel(); }
    if (e.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button')].filter((el) => !el.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  panel.__previous = previous;
  document.getElementById('modals').appendChild(panel);
  panel.querySelector('[data-act="close"]').focus();
  if (scrollTo) panel.querySelector(`#kbd-${scrollTo}`)?.scrollIntoView();
}

export function closeShortcutsPanel() {
  if (!panel) return;
  const previous = panel.__previous;
  panel.remove();
  panel = null;
  try { previous?.focus?.(); } catch { /* the element may be gone */ }
}

export const shortcutsPanelOpen = () => !!panel;

/* ═══════════════════════════════════════════════════ the first hint ═══ */

/**
 * We cannot detect Ctrl+W being pressed — that is the whole problem, there is
 * no keydown — so we say it before it happens, once, the first time a terminal
 * is opened on this browser.
 */
const HINT_KEY = 'su-ssh-keyboard-hint-seen';

export function hintOnce() {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch { return; }          // private mode: skip the hint rather than nag every time
  const extra = captureSupported()
    ? 'Turn on Capture keys in the top bar to send them to the terminal.'
    : 'This browser cannot give them back.';
  toast(`Your browser keeps Ctrl+W, Ctrl+T and Ctrl+N for itself. ${extra} Alt+Shift+H for all shortcuts.`,
    'info', 9000);
}
