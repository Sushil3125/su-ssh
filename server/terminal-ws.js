/**
 * terminal-ws.js
 * -----------------------------------------------------------------------------
 * Bridges xterm.js in the browser to a real PTY on the remote host.
 *
 * This is a genuine interactive shell channel on the same SSH connection the
 * file manager uses — not `exec` per command. That is what makes vim, htop,
 * tab-completion, Ctrl-C and colours all work.
 *
 * Protocol: text frames are JSON control messages, binary frames are raw
 * keystrokes. Splitting them this way avoids having to escape user input that
 * happens to look like JSON.
 */

import { WebSocketServer } from 'ws';
import { getSession } from './ssh-session.js';

export function attachTerminal(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') return socket.destroy();

    // The browser cannot set headers on a WebSocket handshake, so the session
    // token rides in the query string. Over TLS that is acceptable; just be
    // aware it can land in proxy access logs, so keep tokens short-lived.
    const token = url.searchParams.get('token');
    try {
      getSession(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      openShell(ws, token, {
        cols: Number(url.searchParams.get('cols')) || 80,
        rows: Number(url.searchParams.get('rows')) || 24,
      });
    });
  });

  return wss;
}

function openShell(ws, token, size) {
  let session;
  try {
    session = getSession(token);
  } catch {
    return ws.close(4001, 'Session expired');
  }

  session.conn.shell(
    { term: 'xterm-256color', cols: size.cols, rows: size.rows },
    (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Could not open a shell: ${err.message}` }));
        return ws.close();
      }

      session.channels.add(stream);
      ws.send(JSON.stringify({ type: 'ready' }));

      stream.on('data', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      stream.stderr.on('data', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      stream.on('close', () => {
        session.channels.delete(stream);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exit' }));
          ws.close();
        }
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return stream.write(data);

        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return stream.write(data); }

        if (msg.type === 'resize') {
          // Without this, `clear`, vim and htop all render at the wrong width.
          stream.setWindow(msg.rows, msg.cols, 0, 0);
        } else if (msg.type === 'input') {
          stream.write(msg.data);
        }
      });

      ws.on('close', () => {
        session.channels.delete(stream);
        try { stream.end(); } catch { /* already closed */ }
      });
    }
  );
}
