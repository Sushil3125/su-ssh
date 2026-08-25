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

/** Registered on /ws/terminal by ws-router.js, which has already authenticated. */
export function terminalRoute(ws, session, url) {
  openShell(ws, session, {
    cols: Number(url.searchParams.get('cols')) || 80,
    rows: Number(url.searchParams.get('rows')) || 24,
  });
}

function openShell(ws, session, size) {
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
