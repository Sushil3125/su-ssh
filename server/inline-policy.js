/**
 * inline-policy.js
 * -----------------------------------------------------------------------------
 * What the download route may hand the browser *inline*, and how a `Range`
 * header is read. Pure functions, no I/O, so both are testable on their own.
 *
 * Why this file exists at all: the viewers show remote files from the app's
 * own origin. A remote `.html` (or an `.svg`, which is a document that can
 * carry <script>) served inline and rendered as a page would run *as su-ssh* —
 * it could call /api/* with the user's cookie and a token it scrapes from the
 * URL, i.e. drive every connected server. So the rule is an allowlist, not a
 * blocklist:
 *
 *   - Inline is granted only to types on INLINE below. Everything else is
 *     `application/octet-stream` + `attachment`, which a browser saves and
 *     never renders.
 *   - HTML and XHTML are never on it, under any name.
 *   - SVG is inline ONLY when the browser says it is loading an image
 *     (`Sec-Fetch-Dest: image`, i.e. an <img>), because an <img> never runs a
 *     script inside the SVG. Loaded any other way — iframe, object, a typed-in
 *     URL — it is an attachment.
 *   - Every response from the route additionally carries
 *     `Content-Security-Policy: sandbox` (no allow-scripts, no
 *     allow-same-origin) and `X-Content-Type-Options: nosniff`, so even a
 *     mistake in the table below would render as an opaque-origin, script-less
 *     document that cannot reach the app.
 */

/** Extension → Content-Type for everything that may be shown inline. */
const INLINE = {
  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  // documents
  pdf: 'application/pdf',
  // video
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  // audio
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm',
  // text, always as plain text — "View raw" in the viewers
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
};

const SVG = 'image/svg+xml';
export const SANDBOX_CSP = 'sandbox';

/**
 * Decide the Content-Type and disposition for one response.
 * `fetchDest` is the request's Sec-Fetch-Dest header ('' when absent).
 * @returns {{ type: string, inline: boolean }}
 */
export function inlinePolicy(filename, { wantInline, fetchDest = '' }) {
  const ext = extOf(filename);
  if (!wantInline) return { type: 'application/octet-stream', inline: false };
  if (ext === 'svg' || ext === 'svgz') {
    return fetchDest === 'image' ? { type: SVG, inline: true } : { type: 'application/octet-stream', inline: false };
  }
  const type = INLINE[ext];
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

function extOf(name) {
  const base = String(name).split('/').pop();
  return base.includes('.') ? base.split('.').pop().toLowerCase() : '';
}

/**
 * Parse a `Range` header against a representation of `size` bytes.
 *
 * RFC 9110 §14: only the `bytes` unit is understood; `a-b`, `a-` and `-n`
 * (the last n bytes) are the three forms. Returns:
 *   null                         → no usable Range: serve the whole file (200).
 *                                  Also used for syntax we do not implement —
 *                                  a server MAY ignore Range, and multi-range
 *                                  (multipart/byteranges) is one of those.
 *   { unsatisfiable: true }      → 416 with `Content-Range: bytes * /size`.
 *   { start, end }               → 206, `end` inclusive and already clamped.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return null;
  const spec = m[1].trim();
  if (spec.includes(',')) return null;           // multi-range: ignored, full 200
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r || (r[1] === '' && r[2] === '')) return null;

  if (r[1] === '') {                              // suffix: the last n bytes
    const n = Number(r[2]);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  let end = r[2] === '' ? size - 1 : Number(r[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (r[2] !== '' && end < start) return null;    // invalid syntax → ignore (RFC 9110 §14.1.1)
  if (start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}
