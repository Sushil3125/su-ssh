/**
 * access.js — trade the launch link's key for a cookie, or explain why not.
 *
 * The relay prints http://127.0.0.1:3000/#k=<secret> when it starts. The key
 * lives in the fragment because browsers never send a fragment to a server: it
 * cannot land in an access log, a proxy log or a Referer header. Here it is
 * posted once, exchanged for an httpOnly SameSite=Strict cookie the page itself
 * can never read, and wiped from the address bar so a screenshot or a shared
 * URL does not carry it.
 *
 * This module is imported first by main.js and awaits at the top level, so no
 * other code runs until access is settled — and if it is not settled, nothing
 * runs at all beyond the screen below.
 */

import { relayApi, setAccessLostHandler } from './api.js';

const screen = document.getElementById('access-screen');
const detail = document.getElementById('access-detail');

function showLocked(err) {
  if (err?.message) {
    detail.textContent = err.message;
    detail.classList.remove('is-hidden');
  }
  screen.classList.remove('is-hidden');
}

const params = new URLSearchParams(location.hash.replace(/^#/, ''));
const key = params.get('k');
if (key) {
  // Strip it before anything else can fail: the key must not survive in the
  // address bar even if the exchange itself errors.
  params.delete('k');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  try { await relayApi.redeemAccess(key); } catch { /* reported by the status check below */ }
}

let status;
try {
  status = await relayApi.accessStatus();
} catch (err) {
  status = { required: true, granted: false, error: err };
}

if (status.required && !status.granted) {
  showLocked(status.error);
  // Deliberately never resolves: main.js and every app module below it stay
  // unevaluated, so there is no half-live desktop behind this screen.
  await new Promise(() => {});
}

// The relay issues a new key on every start, so a restart mid-session lands
// here rather than in a pile of confusing 401s.
setAccessLostHandler(showLocked);
