/**
 * api.js — every call to the relay goes through here.
 *
 * The session token lives in sessionStorage so a page refresh does not drop
 * you back to the login screen. That is a prototype convenience with a real
 * cost: any script running on this origin can read it. For anything beyond a
 * prototype, move the token to an httpOnly, Secure, SameSite=Strict cookie.
 */

let token = sessionStorage.getItem('ssh-token') || null;

export function setToken(value) {
  token = value;
  if (value) sessionStorage.setItem('ssh-token', value);
  else sessionStorage.removeItem('ssh-token');
}

export function getToken() { return token; }

async function request(method, url, { body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers['X-Session-Token'] = token;

  if (raw) {
    opts.body = raw;
    opts.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, opts);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const err = new Error(isJson ? (payload.error || 'Request failed.') : payload);
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const api = {
  connect: (creds)      => request('POST', '/api/connect', { body: creds }),
  disconnect: ()        => request('POST', '/api/disconnect'),
  session: ()           => request('GET', '/api/session'),
  system: ()            => request('GET', '/api/system'),

  list:   (path)        => request('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
  read:   (path)        => request('GET', `/api/fs/read?path=${encodeURIComponent(path)}`),
  write:  (path, content) => request('POST', '/api/fs/write', { body: { path, content } }),
  mkdir:  (path)        => request('POST', '/api/fs/mkdir', { body: { path } }),
  rename: (from, to)    => request('POST', '/api/fs/rename', { body: { from, to } }),
  remove: (path)        => request('POST', '/api/fs/delete', { body: { path } }),
  upload: (path, buffer) => request('POST', `/api/fs/upload?path=${encodeURIComponent(path)}`, { raw: buffer }),

  /** Download and inline-preview URLs carry the token in the query string,
   *  because <img src> and window.open cannot set request headers. */
  downloadUrl: (path) => `/api/fs/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`,
  previewUrl:  (path) => `/api/fs/download?inline=1&path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`,
  terminalUrl: (cols, rows) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
  },
};
