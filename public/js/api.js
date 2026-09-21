/**
 * api.js — every call to the relay goes through here.
 *
 * There used to be one module-level `token` and one `api` object bound to it.
 * That worked while a tab held exactly one SSH session; with several it would
 * be the worst possible bug, because "the current token" is read at request
 * time and a background terminal, a journal stream or a file save would follow
 * whichever session the user happened to be looking at.
 *
 * So the token is now a closure, not a variable: `createApi(token)` returns a
 * complete client bound to that one session, forever. Every app window captures
 * its session's client when it opens and can never be pointed at another host.
 * `relayApi` is the small tokenless part — access, connect, validate — that is
 * about the relay itself rather than about any one session.
 *
 * Tokens still live in sessionStorage (see sessions.js) so a refresh does not
 * drop you back to the login screen. That is a prototype convenience with a
 * real cost: any script on this origin can read them. Beyond a prototype, move
 * them to httpOnly, Secure, SameSite=Strict cookies.
 */

/** Called when the relay says the access cookie is gone (e.g. it restarted). */
let onAccessLost = null;
export function setAccessLostHandler(fn) { onAccessLost = fn; }

/** Called with the token whenever the relay says that token is no longer live. */
let onTokenRejected = null;
export function setTokenRejectedHandler(fn) { onTokenRejected = fn; }

async function request(token, method, url, { body, raw, headers = {} } = {}) {
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
    // The systemd routes use this to say "retry me with a sudo password".
    err.needsPassword = isJson && !!payload.needsPassword;
    // The plain editor uses this to say "retry me as root, if you meant to".
    err.needsSudo = isJson && !!payload.needsSudo;
    // Structured refusals (host key trust, rate limiting, access key) are acted
    // on by code, never by matching the message text.
    if (isJson) {
      err.code = payload.code || null;
      err.hostKey = payload.hostKey || null;
      err.retryAfter = Number(res.headers.get('Retry-After')) || payload.retryAfter || null;
    }
    if (err.code === 'ACCESS_REQUIRED') onAccessLost?.(err);
    // A 401 on a call that carried a token normally means that session is gone
    // — the relay restarted, the idle reaper took it, or the SSH link dropped.
    // This is one of the three ways a drop is noticed (the others are a
    // WebSocket closing and the liveness poll).
    //
    // Except when it is `needsPassword`: the systemd and file routes answer
    // "give me a sudo password and retry" with 401 as well, and treating that
    // as a dead token would grey out a perfectly live session every time
    // somebody edited a root-owned file.
    else if (res.status === 401 && token && !err.needsPassword) onTokenRejected?.(token, err);
    throw err;
  }
  return payload;
}

/** Calls that are about the relay rather than about one SSH session. */
export const relayApi = {
  accessStatus: ()    => request(null, 'GET', '/api/access'),
  redeemAccess: (key) => request(null, 'POST', '/api/access', { body: { key } }),
  connect: (creds)    => request(null, 'POST', '/api/connect', { body: creds }),

  /** Batched liveness check. The relay answers only for the tokens we send. */
  validateSessions: (tokens) => request(null, 'POST', '/api/sessions/validate', { body: { tokens } }),

  /* Connection profiles: the relay's memory of which servers you use, what you
     call them, which tunnels to reopen and which windows to put back. Tokenless
     on purpose — the greeter needs them before any session exists, and they
     describe a server rather than a live connection. Never a credential; see
     profiles.js on both sides for why that is enforced and not just intended. */
  profiles:           ()      => request(null, 'GET', '/api/profiles'),
  updateProfile:      (patch) => request(null, 'POST', '/api/profiles/update', { body: patch }),
  forgetProfile:      (body)  => request(null, 'POST', '/api/profiles/forget', { body }),
  forgetSavedForward: (body)  => request(null, 'POST', '/api/profiles/forwards/forget', { body }),
  migrateProfiles:    (body)  => request(null, 'POST', '/api/profiles/migrate', { body }),
};

/**
 * A complete relay client bound to one SSH session. Hold the object, not the
 * token: passing the token around is how the wrong-host bug comes back.
 */
export function createApi(token) {
  const req = (method, url, opts) => request(token, method, url, opts);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = `${proto}//${location.host}`;
  const t = encodeURIComponent(token);

  return {
    token,

    disconnect: ()  => req('POST', '/api/disconnect'),
    session: ()     => req('GET', '/api/session'),
    system: ()      => req('GET', '/api/system'),

    list:   (path)          => req('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
    read:   (path)          => req('GET', `/api/fs/read?path=${encodeURIComponent(path)}`),
    /** `sudo` and `password` are only ever set after the user confirmed an elevated save. */
    write:  (path, content, { sudo = false, password } = {}) =>
      req('POST', '/api/fs/write', { body: { path, content, ...(sudo ? { sudo: true, password } : {}) } }),
    mkdir:  (path)          => req('POST', '/api/fs/mkdir', { body: { path } }),
    rename: (from, to)      => req('POST', '/api/fs/rename', { body: { from, to } }),
    remove: (path)          => req('POST', '/api/fs/delete', { body: { path } }),
    /** The first `bytes` of a file (the relay caps it at 2 MB), base64 in JSON. */
    peek:    (path, bytes)  => req('GET', `/api/fs/peek?path=${encodeURIComponent(path)}&bytes=${bytes}`),
    /** An archive's table of contents, listed on the remote host. Never extracts. */
    archive: (path)         => req('GET', `/api/fs/archive?path=${encodeURIComponent(path)}`),

    forwards:     ()     => req('GET', '/api/forwards'),
    addForward:   (spec) => req('POST', '/api/forwards', { body: spec }),
    closeForward: (id)   => req('DELETE', `/api/forwards/${encodeURIComponent(id)}`),

    /* systemd. `scope` is 'system' or 'user'; a sudo password, when one is
       needed, is sent per request and never stored on either side. */
    services:     (scope)              => req('GET', `/api/services?scope=${scope}`),
    service:      (unit, scope)        => req('GET', `/api/services/${encodeURIComponent(unit)}?scope=${scope}`),
    serviceLogs:  (unit, scope, lines) => req('GET', `/api/services/${encodeURIComponent(unit)}/logs?scope=${scope}&lines=${lines}`),
    unitFile:     (unit, scope, which, password) =>
      req('GET', `/api/services/${encodeURIComponent(unit)}/file?scope=${scope}&which=${which}`
        + (password ? `&password=${encodeURIComponent(password)}` : '')),
    saveUnitFile: (unit, body)          => req('POST', `/api/services/${encodeURIComponent(unit)}/file`, { body }),
    serviceAction: (unit, action, body) => req('POST', `/api/services/${encodeURIComponent(unit)}/${action}`, { body }),
    daemonReload: (body)                => req('POST', '/api/daemon-reload', { body }),

    upload: (path, buffer) => req('POST', `/api/fs/upload?path=${encodeURIComponent(path)}`, { raw: buffer }),

    /** Download and inline-preview URLs carry the token in the query string,
     *  because <img src> and window.open cannot set request headers. */
    downloadUrl: (path) => `/api/fs/download?path=${encodeURIComponent(path)}&token=${t}`,
    // The trailing file name is cosmetic (the relay ignores it): it is what the
    // browser's PDF viewer shows as the title and suggests when saving.
    previewUrl:  (path) => `/api/fs/download/${encodeURIComponent(path.split('/').pop() || 'file')}`
      + `?inline=1&path=${encodeURIComponent(path)}&token=${t}`,

    metricsUrl: (interval) => `${wsBase}/ws/metrics?token=${t}&interval=${interval}`,
    /** `span` is one of the fixed keys journal-ws.js knows (15m/1h/today/boot/
     *  all); `format=json` is what makes the stream carry PRIORITY, which is
     *  where the log view's colouring comes from. */
    journalUrl: (unit, scope, lines, follow, { span = 'all', format = 'json' } = {}) =>
      `${wsBase}/ws/journal?token=${t}&unit=${encodeURIComponent(unit)}&scope=${scope}&lines=${lines}`
      + `&follow=${follow ? 1 : 0}&span=${encodeURIComponent(span)}&format=${encodeURIComponent(format)}`,
    terminalUrl: (cols, rows) => `${wsBase}/ws/terminal?token=${t}&cols=${cols}&rows=${rows}`,
  };
}
