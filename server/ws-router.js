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

export function attachWebSockets(server, routes) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
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

    wss.handleUpgrade(request, socket, head, (ws) => handler(ws, session, url));
  });

  return wss;
}
