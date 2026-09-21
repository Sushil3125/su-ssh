/**
 * access.js — the passphrase screen: choose one, enter it, or change it.
 *
 * The relay stores a scrypt hash of a passphrase the owner chose, and trades a
 * correct one for an httpOnly, SameSite=Strict cookie this page can never
 * read. The cookie is signed with a key the relay keeps on disk, so it
 * survives a restart; changing the passphrase rotates that key.
 *
 *   no passphrase yet → "Choose a passphrase" (accepted only from a browser on
 *                        the relay machine itself; elsewhere, an explanation)
 *   no valid cookie   → "Unlock"
 *   from the greeter  → "Change passphrase" / "Lock this browser"
 *
 * This module is imported first by main.js and awaits at the top level, so no
 * other code runs until access is settled — and if it is not settled, nothing
 * runs at all beyond the screen below.
 */

import { relayApi, setAccessLostHandler } from './api.js';

const $ = (id) => document.getElementById(id);
const screen = $('access-screen');
const form = $('access-form');
const title = $('access-title');
const lede = $('access-lede');
const why = $('access-why');
const fields = $('access-fields');
const currentField = $('access-current-field');
const current = $('access-current');
const pass = $('access-pass');
const passLabel = $('access-pass-label');
const confirmField = $('access-confirm-field');
const confirm = $('access-confirm');
const rememberField = $('access-remember-field');
const remember = $('access-remember');
const detail = $('access-detail');
const btn = $('access-btn');
const btnLabel = btn.querySelector('.btn__label');
const cancel = $('access-cancel');
const foot = $('access-foot');

let mode = null;          // 'setup' | 'setup-remote' | 'unlock' | 'change'
let minLength = 8;
let settle = null;        // resolves the pending "wait until unlocked"
let unlockAt = 0;
let timer = null;

const show = (el, on) => el.classList.toggle('is-hidden', !on);

/** Text with the one shell command in it kept whole, as <code>. */
function setText(el, text) {
  el.replaceChildren();
  text.split(/(su-ssh --reset-passphrase)/).forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const c = document.createElement('code'); c.textContent = part; el.append(c); } else el.append(part);
  });
}

function setError(message) {
  detail.textContent = message || '';
  show(detail, Boolean(message));
}

function configure(next) {
  mode = next;
  form.reset();
  remember.checked = true;
  setError('');
  const copy = {
    setup: {
      title: 'Choose a passphrase',
      lede: 'You will type it to open this desktop from any browser. It can be anything you will remember.',
      why: `At least ${minLength} characters — words, spaces, symbols, any mix. There are no other rules: length is what makes a guess slow. `
        + 'Only a scrypt hash is stored on this machine. If you forget it, run su-ssh --reset-passphrase here and choose again.',
      label: 'Passphrase', button: 'Set passphrase', foot: '',
    },
    'setup-remote': {
      title: 'Set a passphrase on the relay machine',
      lede: 'This relay has no passphrase yet, and one can only be chosen from a browser on the machine the relay runs on.',
      why: `Otherwise whoever reached it first would pick it. Open ${location.protocol}//127.0.0.1:${location.port || (location.protocol === 'https:' ? 443 : 80)}/ on that machine (or tunnel in with ssh -L) and choose one there, then reload this page.`,
      label: '', button: 'Check again', foot: '',
    },
    unlock: {
      title: 'Unlock su-ssh',
      lede: 'Enter the passphrase you chose for this relay.',
      why: '', label: 'Passphrase', button: 'Unlock',
      foot: 'Forgotten it? Run su-ssh --reset-passphrase on the relay machine.',
    },
    change: {
      title: 'Change passphrase',
      lede: 'Every other browser will be signed out and must enter the new passphrase.',
      why: `At least ${minLength} characters; anything goes.`,
      label: 'New passphrase', button: 'Change passphrase', foot: '',
    },
  }[next];
  title.textContent = copy.title;
  lede.textContent = copy.lede;
  setText(why, copy.why);
  show(why, Boolean(copy.why));
  passLabel.textContent = copy.label;
  btnLabel.textContent = copy.button;
  setText(foot, copy.foot);
  show(foot, Boolean(copy.foot));
  show(fields, next !== 'setup-remote');
  show(currentField, next === 'change');
  show(confirmField, next === 'setup' || next === 'change');
  show(rememberField, next === 'setup' || next === 'unlock');
  show(cancel, next === 'change');
  pass.autocomplete = next === 'unlock' ? 'current-password' : 'new-password';
  btn.disabled = Date.now() < unlockAt && next !== 'setup-remote';
  screen.classList.remove('is-hidden');
  setTimeout(() => (next === 'change' ? current : pass).focus(), 0);
}

function hide() {
  screen.classList.add('is-hidden');
  mode = null;
}

/** A 429 becomes a live countdown, the same way the connect form does it. */
function throttled(err) {
  unlockAt = Date.now() + err.retryAfter * 1000;
  const base = err.message.replace(/\s*Wait .*$/, '');
  clearInterval(timer);
  const tick = () => {
    const left = Math.ceil((unlockAt - Date.now()) / 1000);
    if (left > 0) {
      setError(`${base} Try again in ${left}s.`);
      btn.disabled = true;
    } else {
      clearInterval(timer);
      setError(`${base} You can try again now.`);
      btn.disabled = false;
    }
  };
  timer = setInterval(tick, 500);
  tick();
}

async function refresh() {
  let status;
  try {
    status = await relayApi.accessStatus();
  } catch (err) {
    configure('unlock');
    setError(err.message);
    return false;
  }
  minLength = status.minLength || minLength;
  if (!status.required || status.granted) return true;
  configure(status.setUp ? 'unlock' : (status.setupAllowed ? 'setup' : 'setup-remote'));
  return false;
}

function granted() {
  hide();
  settle?.();
  settle = null;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (btn.disabled) return;
  if (mode === 'setup-remote') { if (await refresh()) granted(); return; }

  const value = pass.value;
  if (mode === 'setup' || mode === 'change') {
    if ([...value.normalize('NFC')].length < minLength) { setError(`Use at least ${minLength} characters.`); pass.focus(); return; }
    if (value !== confirm.value) { setError('The two entries do not match.'); confirm.focus(); return; }
  } else if (!value) { pass.focus(); return; }

  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    if (mode === 'setup') await relayApi.setupAccess(value, remember.checked);
    else if (mode === 'unlock') await relayApi.unlockAccess(value, remember.checked);
    else if (mode === 'change') await relayApi.changeAccess(current.value, value);
    clearInterval(timer);
    unlockAt = 0;
    granted();
  } catch (err) {
    if (err.code === 'RATE_LIMITED' && err.retryAfter) return throttled(err);
    // Someone else finished setup, or it was reset: show the screen that fits now.
    if (err.code === 'ALREADY_SET' || err.code === 'NOT_SET') { await refresh(); setError(err.message); return; }
    setError(err.message);
    (mode === 'change' && err.code === 'BAD_PASSPHRASE' ? current : pass).select();
  } finally {
    btn.classList.remove('is-busy');
    if (Date.now() >= unlockAt) btn.disabled = false;
  }
});

cancel.addEventListener('click', () => { if (mode === 'change') hide(); });
screen.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode === 'change') { e.stopPropagation(); hide(); } });

/* ------------------------------------------------------------------ start */

if (!(await refresh())) {
  // Deliberately never resolves until unlocked: main.js and every app module
  // below it stay unevaluated, so there is no half-live desktop behind this.
  await new Promise((resolve) => { settle = resolve; });
}

// Only offer change/lock when there is a passphrase to change.
relayApi.accessStatus().then((s) => {
  if (!s.required) return;
  show($('access-links'), true);
  $('access-change-open').addEventListener('click', () => configure('change'));
  $('access-lock').addEventListener('click', async () => {
    try { await relayApi.lockAccess(); } catch { /* the reload below shows the truth */ }
    location.reload();
  });
}).catch(() => {});

// The passphrase was changed or reset elsewhere, or the cookie expired: ask
// again in place. The desktop behind stays as it was and carries on once the
// right passphrase is entered.
setAccessLostHandler(() => { if (mode !== 'unlock' && mode !== 'setup' && mode !== 'setup-remote') refresh(); });
