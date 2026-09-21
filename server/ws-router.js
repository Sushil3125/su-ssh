/**
 * ws-router.js — one upgrade handler, several WebSocket endpoints.
 *
 * Node fires 'upgrade' on every listener, so an endpoint that destroys sockets
 * it does not recognise makes it impossible to add a second one. Routing in a
 * single place also means the session-token check happens exactly once, in a
 * spot you can point at during a review.
 */

import { WebSocketServer } from 'ws';
import { getSession } from './ssh-session.js';

/**
 * `authorize(request)` returns null to allow the handshake, or a reason to
 * refuse it. It runs before routing and before the token check: a WebSocket is
 * exempt from CORS, so the Host/Origin check is the only thing standing between
 * a hostile page and a live shell.
 */
export function attachWebSockets(server, routes, { authorize = () => null } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const refusal = authorize(request);
    if (refusal) {
      console.warn(`[guard] WS ${request.url.split('?')[0]} host=${request.headers.host} origin=${request.headers.origin ?? '-'}`);
      const body = JSON.stringify({ error: refusal, code: 'FORBIDDEN_HOST' });
      // end(), not write()+destroy(): destroy can drop the buffered response,
      // and the client then sees a reset instead of the reason.
      return socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    }

    const url = new URL(request.url, 'http://localhost');
    const handler = routes[url.pathname];
    if (!handler) return socket.destroy();

    // The browser cannot set headers on a WebSocket handshake, so the session
    // token rides in the query string. Over TLS that is acceptable; just be
    // aware it can land in proxy access logs, so keep tokens short-lived.
    const token = url.searchParams.get('token');
    let session;
    try {
      session = getSession(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Kept so the relay can close this socket later if the cookie that let it
      // in stops verifying (passphrase changed or reset, cookie expired).
      ws.accessCookie = request.headers.cookie || '';
      // Counted here, once, rather than in each endpoint: the idle reaper only
      // needs to know that *some* socket is still attached to the session.
      session.openSockets += 1;
      ws.on('close', () => { session.openSockets -= 1; session.touch(); });
      handler(ws, session, url);
    });
  });

  return wss;
}
