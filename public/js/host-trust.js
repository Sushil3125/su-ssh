/**
 * host-trust.js — the greeter half of host key verification and throttling.
 *
 * Kept out of main.js so the submit handler stays a handful of lines: it calls
 * connectWithTrust() instead of api.connect(), and presentConnectError() in its
 * catch. Everything the relay refuses with a structured code is turned into a
 * dialog here.
 */

import { relayApi } from './api.js';
import { openDialog, toast } from './ui.js';

/**
 * Connect, resolving a first-use host key prompt if one comes back.
 *
 * The retry sends the fingerprint the user was actually shown, so if the key
 * changes between the prompt and the retry the relay refuses again rather than
 * trusting whatever turned up second.
 */
export async function connectWithTrust(creds) {
  try {
    return await relayApi.connect(creds);
  } catch (err) {
    if (err.code === 'HOST_KEY_CHANGED') { await warnChanged(err); throw markHandled(err); }
    if (err.code !== 'HOST_KEY_UNKNOWN' || !err.hostKey) throw err;

    const trusted = await askToTrust(err.hostKey);
    if (!trusted) {
      throw markHandled(new Error(`Not connected: the host key for ${where(err.hostKey)} was not verified.`));
    }
    try {
      return await relayApi.connect({ ...creds, trustHostKey: err.hostKey.fingerprint });
    } catch (retryErr) {
      if (retryErr.code === 'HOST_KEY_CHANGED') { await warnChanged(retryErr); throw markHandled(retryErr); }
      throw retryErr;
    }
  }
}

const where = (hk) => `${hk.host}${hk.port === 22 ? '' : `:${hk.port}`}`;
const markHandled = (err) => Object.assign(err, { shownInDialog: true });

function askToTrust(hk) {
  return openDialog({
    title: `First time connecting to ${where(hk)}`,
    message: 'This server has never been seen by this relay, so there is nothing to compare its key against.\n\n'
      + 'Verify the fingerprint below out of band — on the server run `ssh-keygen -lf /etc/ssh/ssh_host_'
      + `${hk.keyType.replace(/^ssh-|^ecdsa-sha2-/, '').replace(/-cert.*/, '')}_key.pub\`, or ask whoever runs it. `
      + 'If it does not match, someone is sitting between you and that machine.\n\n'
      + 'Trusting it pins this exact key on the relay host; you will not be asked again, and a different key later will be refused.',
    fields: [
      { name: 'type', label: 'Key type', value: hk.keyType, readonly: true },
      { name: 'fingerprint', label: 'SHA256 fingerprint', value: hk.fingerprint, readonly: true },
    ],
    confirmLabel: 'Fingerprint matches — connect',
    cancelLabel: 'Cancel',
  }).then((result) => result !== null);
}

/**
 * A changed key is a dead end in the browser on purpose. Clearing the pin needs
 * a command on the relay host, which is a deliberate step by someone with
 * access to that machine — not a button next to the warning, which is exactly
 * what an attacker would want the victim to click.
 */
async function warnChanged(err) {
  const hk = err.hostKey || {};
  const expected = (hk.expected || []).map((e) => `${e.keyType} ${e.fingerprint}`).join('  or  ') || 'unknown';
  const result = await openDialog({
    title: `Host key for ${where(hk)} has CHANGED`,
    titleIcon: 'triangle-alert',
    message: 'The key this server presented is not the one that was pinned. Either someone is intercepting the '
      + 'connection and could capture everything you type — including your password — or the server was rebuilt '
      + 'or its host key was rotated.\n\nThe connection was refused. Confirm the new fingerprint with whoever runs '
      + 'the server, over a channel that is not this one. Only then remove the old pin on the machine running the '
      + 'relay with the command below, and connect again.',
    fields: [
      { name: 'presented', label: 'Presented now', value: `${hk.keyType} ${hk.fingerprint}`, readonly: true },
      { name: 'expected', label: 'Pinned earlier', value: expected, readonly: true },
      { name: 'fix', label: 'Run on the relay host', value: hk.fix || '', readonly: true },
    ],
    confirmLabel: 'Copy the command',
    cancelLabel: 'Close',
    danger: true,
  });
  if (result && hk.fix) {
    try {
      await navigator.clipboard.writeText(hk.fix);
      toast('Command copied. Run it on the machine running the relay.', 'info', 6000);
    } catch {
      toast('Could not copy automatically — select the command in the dialog.', 'bad');
    }
  }
}

/* ------------------------------------------------------------- throttling */

let unlockAt = 0;

/** True while the relay is rate limiting us, so the button stays disabled. */
export function isThrottled() {
  return Date.now() < unlockAt;
}

/**
 * Show a failed connection in the greeter's alert box. A 429 is shown as a live
 * countdown: "try again later" with no number is the kind of message people
 * respond to by clicking Connect eight more times.
 */
export function presentConnectError(err, { errorBox, connectBtn }) {
  if (err.code === 'RATE_LIMITED' && err.retryAfter) {
    unlockAt = Date.now() + err.retryAfter * 1000;
    const base = err.message.replace(/\s*Wait .*$/, '');
    const tick = () => {
      const left = Math.ceil((unlockAt - Date.now()) / 1000);
      if (left > 0) {
        errorBox.textContent = `${base} Try again in ${left}s.`;
        connectBtn.disabled = true;
      } else {
        clearInterval(timer);
        errorBox.textContent = `${base} You can try again now.`;
        connectBtn.disabled = false;
      }
    };
    const timer = setInterval(tick, 500);
    tick();
  } else if (err.code === 'HOST_KEY_CHANGED') {
    errorBox.textContent = `Refused: the host key has changed. See the warning above for what to do.`;
  } else {
    errorBox.textContent = err.message;
  }
  errorBox.classList.remove('is-hidden');
}
