/**
 * journal-ws.js — `journalctl -f` for one unit, streamed to the browser.
 *
 * Protocol, matching the terminal endpoint: binary frames are log bytes, text
 * frames are JSON control messages. Log lines can contain anything at all,
 * including something that parses as JSON, so the two must never share a frame
 * type.
 *
 * The stream is started only after the client's first control message. That is
 * what lets a sudo password be delivered over the established socket instead of
 * in the URL, where it would land in every proxy log between here and there.
 */

import { assertUnit, assertScope, probePrivilege } from './services.js';

const MAX_LINES = 5000;

export function journalRoute(ws, session, url) {
  let unit, scope;
  try {
    unit = assertUnit(url.searchParams.get('unit'));
    scope = assertScope(url.searchParams.get('scope'));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return ws.close(4400, 'Bad request');
  }

  const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 1), MAX_LINES);
  const follow = url.searchParams.get('follow') !== '0';

  let stream = null;
  let starting = false;

  ws.on('message', async (data, isBinary) => {
    if (isBinary || stream || starting) return;

    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { /* treat as an empty start */ }
    if (msg.type && msg.type !== 'start') return;

    starting = true;
    try {
      stream = await startJournal(session, { scope, unit, lines, follow, password: msg.password });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message, needsPassword: !!err.needsPassword }));
      return ws.close(4401, 'Could not start');
    }

    ws.send(JSON.stringify({ type: 'ready', unit, scope, lines, follow }));

    const forward = (chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk); };
    stream.on('data', forward);
    stream.stderr?.on('data', forward);
    stream.on('close', () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit' }));
        ws.close();
      }
    });
  });

  ws.on('close', () => {
    // Closing the channel hangs up the PTY, which is what actually stops a
    // `journalctl -f` on the far side. See Session.execStream for why.
    try { stream?.close?.() ?? stream?.end?.(); } catch { /* already gone */ }
  });
}

async function startJournal(session, { scope, unit, lines, follow, password }) {
  // journalctl reads other units' logs only for members of systemd-journal or
  // adm. Rather than fail with a bare "no entries", elevate when we can.
  let prefix = '';
  let stdin = null;

  if (scope === 'system' && password) {
    prefix = 'sudo -S -p "" ';
    stdin = `${password}\n`;
  } else if (scope === 'system') {
    const { mode } = await probePrivilege(session);
    if (mode === 'passwordless') prefix = 'sudo -n ';
  }

  const selector = scope === 'user' ? `--user --user-unit '${unit}'` : `-u '${unit}'`;
  const command = `${prefix}env SYSTEMD_COLORS=0 LC_ALL=C journalctl ${selector} -n ${lines} --no-pager -o short-iso${follow ? ' -f' : ''} 2>&1`;

  return session.execStream(command, { pty: true, stdin });
}
