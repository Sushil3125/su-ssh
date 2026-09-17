# Changelog — WebSSH Ubuntu Desktop

## Unreleased

### Keyboard — the browser stops eating the terminal's keys
- **Nano and vi get their chords back, with nothing to turn on.** While a
  terminal has focus, `Ctrl+A/B/D/E/F/G/H/J/K/L/O/P/R/S/U/X/Y` are
  `preventDefault()`ed at the window, so they reach the PTY instead of opening
  Find, Downloads, History, the address bar or a bookmark dialog. The event is
  *not* stopped, only defaulted, so xterm still sees it and still writes the
  control byte. Verified end to end: each byte was dispatched as a real key
  through CDP and read back out of a `cat -v` running on the far side of a pty.
- **Selection-aware `Ctrl+C`.** With a selection it copies and clears the
  selection; with nothing selected it is SIGINT exactly as before. xterm has no
  such rule of its own — it sends ETX unconditionally.
- **`Ctrl+Shift+C` / `Ctrl+Shift+V`,** and a right-click menu in the terminal
  with Copy / Paste / Select all / Clear. Both paste paths that can raise the
  browser's clipboard-read prompt duplicate paths that cannot (`Ctrl+V`,
  `Shift+Insert`, middle-click), so denying the permission costs nothing.
- **"Capture keys" (`Alt+Shift+K`, or the top-bar chip)** — JS-initiated
  fullscreen plus `navigator.keyboard.lock()`. The only mechanism that recovers
  `Ctrl+W`, `Ctrl+T` and `Ctrl+N`, and Chromium-only. `Escape` is in the locked
  set on purpose: a tap reaches the terminal, a two-second hold leaves. The chip
  is painted from `fullscreenchange` and never from its own click, so it cannot
  report a capture that failed; a half-entered state is rolled back. On Firefox
  and Safari, where the API has never existed, the control says so instead of
  failing silently.
- **A keyboard panel, `Alt+Shift+H`** (or `F1` when a terminal does *not* have
  focus — nano owns `F1`). Lists the app's shortcuts, what capture does, the
  copy/paste table, and, honestly, which combinations each browser keeps for
  itself. That table is read from Chromium's `IsReservedCommandOrKey` and
  Firefox's `reserved="true"` keyset, not guessed.
- **A scoped `beforeunload` guard.** Registered only while a connected session
  has at least one terminal window open, and removed the moment it does not, so
  a mistyped `Ctrl+W` costs a dialog rather than a root shell — and the greeter
  never nags.
- **A web app manifest**, so Chrome and Edge offer "Install su-ssh…". A Chromium
  app window reserves nothing at all, which is a second route to `Ctrl+W`.
- **Deliberately no service worker,** and the reasoning is written into the
  README so nobody adds one "for the PWA" later. A stale cached `main.js` served
  against a freshly upgraded relay breaks the WebSocket protocol and the session
  token format in a tool that holds live root shells, and the user's instinctive
  fix — a hard reload — is exactly what a service worker survives. Nothing is
  gained: install has not needed one since Chrome 112.
- The comment in `rail.js` claiming `Ctrl+1..9` and `Ctrl+K` cannot be
  intercepted is corrected: both *are* preventable in both browsers. They remain
  the wrong choice for app shortcuts, for the reasons now written there.

**Not verified, and not claimed.** Whether Keyboard Lock actually captures
`Ctrl+W` cannot be shown in a headless browser: there is no browser chrome and
no OS-level window to hook, and `lock()` rejects with `InvalidStateError`
whatever the code does. The API surface, the secure-context requirement, the
argument validation and the rollback path are all tested; the capture itself
needs a headed Chrome on a real desktop.

### Multi-session switching
- **Several servers in one tab.** A host rail sits left of the app dock with one
  chip per connection: colour bar, initials, status dot, open-window count and an
  activity dot when a background host produced output while you were away. Up to
  eight per tab; the relay caps its own total with `MAX_SESSIONS` (default 16)
  and answers a further connect with 429.
- **A session owns a workspace.** Windows, dock task buttons, desktop icons,
  top-bar meters and the system info line all belong to the session they were
  opened on. Switching hides one set of DOM nodes and shows another: no socket is
  closed, no long-running command dies, no unsaved editor buffer is lost, and
  position, size, minimise/maximise, z-order and keyboard focus come back exactly
  as they were. A window is bound to its session's token at open time and can
  never be pointed at another host.
- **Background sessions keep running** — terminals, journal streams, port
  forwards and uploads all continue. Only the active session streams
  `/ws/metrics`; a backgrounded one stops sampling and resumes on activation.
- **Add a connection without losing what you have.** The greeter opens as an
  overlay over the live desktop (`+` on the rail or `Alt+Shift+N`), with Esc and
  Cancel to back out. A failed connect leaves the overlay open with the error and
  the form intact, and the session underneath untouched. Connecting to a target
  you already hold offers "Switch to it" or "Connect again".
- **Disconnect one or all.** Every confirmation names the label *and* the host,
  counts the windows and forwards it will close, and is drawn in the session's
  colour. Disconnecting the active session activates the most recently used one;
  disconnecting the last shows the full-screen greeter.
- **Drop detection.** A dropped connection is noticed three ways — a WebSocket
  closing, a 401 on any request carrying that token, and a ten-second batched
  liveness poll. The entry greys out, a toast names it, its windows freeze with a
  Reconnect / Close banner, and the app never auto-switches away from what you
  are looking at. Reconnecting puts the new session in the same rail slot.
- **Refresh restores sessions** (not window layout, as before) via a new
  `POST /api/sessions/validate`, which answers only for the tokens the request
  supplies and never enumerates the relay's sessions. Dead ones are dropped with
  one summary toast. A single `ssh-token` left by 0.1.0 is upgraded to a
  one-entry list.
- **Keyboard:** `Alt+Shift+1…8` jump to a session, `Alt+Shift+[` / `Alt+Shift+]`
  cycle, `Alt+Shift+N` adds one. Matched on `event.code`, captured before xterm,
  and never forwarded to the PTY; `Ctrl+C`, `Ctrl+D`, `Alt+B`, `Alt+F` and
  `Alt+.` reach the shell exactly as before. Switching is refused while a confirm
  or sudo prompt is open, so a dialog raised by one host can never be answered
  while looking at another.

### Knowing which machine you are on
- Every session gets an accent colour, auto-assigned from an eight-colour
  accessible palette and stable per `user@host:port`, plus an editable label and
  an optional `dev` / `staging` / `prod` tag (right-click a rail chip). The
  colour and the label appear together in the rail chip, the top-bar chip, a 2px
  line across the desktop, every window title bar and the browser tab title —
  colour is never the only signal.
- Marking a host `prod` forces red, adds a PROD tag, and makes destructive
  confirmations require the host name to be typed before the button enables.
- Every destructive confirmation now names the session and the host: systemctl
  stop/restart/disable/mask, unit-file save, `daemon-reload`, file delete and
  rename, closing a forward, disconnecting, and an elevated editor save.
- Toasts raised by a background session are prefixed with that session's label.

### Real connection status
- `#link-dot` in the top bar was hard-coded "live" and never changed. It now
  shows the active session's actual state — live, reconnecting, or dropped — with
  the state in its tooltip and accessible name.
- A terminal whose stream ends shows an inline strip above the scrollback with a
  Reconnect button, instead of a grey `[disconnected]` inside the black
  rectangle; the journal view's status word gains the same.

### Editor
- Saving a file the SSH user cannot write no longer dead-ends on a permission
  toast. The relay answers a denied write with `needsSudo`, the editor asks —
  naming the host — and retries through the same SFTP-temp-file plus `install`
  under `sudo` mechanism the unit-file editor already used, prompting for a sudo
  password only if that host needs one. An existing file keeps its owner and
  mode. See the security section of the README for why this one has no path
  whitelist.

### Accessibility and ergonomics
- `#toasts` is an `aria-live="polite"` region and failures carry `role="alert"`,
  so success and failure are announced rather than only shown.
- The greeter's authentication switcher is a real tab list: `aria-selected`,
  a roving `tabindex`, and Arrow/Home/End keys.
- Window minimise/maximise/close buttons are 24×24 (WCAG 2.2 SC 2.5.8), as are
  the recents and forward-row remove buttons and the rail chip actions.
- A recent connection that needs no secret (agent auth) connects on one click or
  Enter, instead of only filling in the form.
- `.greeter__foot` contrast raised from roughly 2.6:1 to pass AA.

### Security hardening
- **Per-launch access link.** The relay prints `http://127.0.0.1:3000/#k=<key>`
  and only serves its API to a browser that has traded that key for an
  `httpOnly; SameSite=Strict` cookie. The key travels in the URL fragment, so it
  never reaches a server log or a `Referer` header, and the page strips it from
  the address bar. Nothing is persisted: a restart issues a new link. Disable
  with `--no-auth` behind an authenticating proxy.
- **DNS-rebinding and cross-site protection.** A `Host` allowlist is enforced on
  every HTTP request and WebSocket upgrade, and an `Origin` check on upgrades and
  state-changing requests. Extend it with `--allowed-host` / `ALLOWED_HOSTS` for
  reverse proxies. Without this, any page the user visited could rebind its name
  to 127.0.0.1 and drive the relay — including signing in with the user's
  ssh-agent — as same-origin.
- **Host key verification** with trust on first use and pinning. Unknown hosts are
  refused with their SHA256 fingerprint, shown in a greeter dialog and pinned to
  `~/.config/su-ssh/known_hosts.json` (0600) only after explicit confirmation of
  that exact fingerprint. `~/.ssh/known_hosts` is consulted too (plain and hashed
  entries; `@revoked` is refused). A changed key is blocked outright, with no
  override in the browser — clear it with `su-ssh --forget-host host[:port]`.
- **Rate limiting** on `/api/connect` per client address: 10 attempts a minute
  plus a doubling lockout after three authentication failures, answered with 429,
  `Retry-After` and a countdown in the greeter.
- **Idle sessions are reaped.** A closed tab no longer leaves an SSH connection,
  its forwards and its sampler loops alive until restart; `--idle-timeout`
  (default 15 minutes, `0` disables) closes sessions with no open WebSocket and no
  HTTP traffic. An open desktop holds the metrics socket, so it stays alive.
- **Optional TLS** with `--tls-cert` / `--tls-key`.
- The ssh-agent socket can no longer be chosen by the request; only the relay's
  own `SSH_AUTH_SOCK` is used. Key-file errors are now one generic message, so
  the field cannot probe the relay host's filesystem.
- **Port forwarding.** Local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`)
  tunnels, created and closed against a live session without reconnecting.
  Queue them on the greeter to have them open with the session, or manage them
  from the new Ports app while connected.
- Per-forward live status, open/total connection counts and byte counters.
- Forwards are owned by the session: disconnecting, or the connection dropping,
  releases every listener rather than stranding a bound port.
- Non-loopback binds on the relay host refused unless `ALLOW_PUBLIC_FORWARDS=1`.
- Verified against an in-process ssh2 server: all three kinds carry traffic
  end-to-end and tear down cleanly.

### System monitor
- Live CPU, memory, disk-space, disk-active-time and latency meters in the top
  bar, left of the clock, updating every two seconds with colour thresholds and
  a tooltip on each (load average and core count, swap, filesystem sizes,
  per-device busy time, the two latency legs).
- Fed by one long-lived SSH channel running a `/proc` sampler loop — not an
  exec per tick — with the deltas computed on the relay from the *remote*
  clock, so network jitter cannot distort a percentage.
- Disk active time is io_ticks from `/proc/diskstats`, the same figure
  `iostat -x` reports as %util: the share of the interval with I/O in flight.
  A disk can sit at 100% busy while moving very little, which is exactly the
  state worth seeing.
- Disk space uses df's own Capacity column rather than used÷size, so it agrees
  with what `df -h` says on the same box (ext4 reserves 5% for root).
- Latency is the round trip a person actually feels: browser↔relay measured on
  the metrics socket, plus relay↔server measured by bouncing a byte off a
  remote `cat`. Both are timed with monotonic sub-millisecond clocks, so a LAN
  or loopback hop reads 0.4 ms rather than 0.
- The sampler is reaped when the tab closes, and the meters shed gracefully as
  the window narrows rather than wrapping the bar to two rows.

### Greeter and dialogs
- Recent connections on the login screen: host, user, port, how long ago, how
  many times, and which auth method. Click one to fill the form; pin the ones
  you use daily so they stay at the top and are never rolled out of the list.
  Only where you connect and as whom is stored — never a password, key or
  passphrase, which is what makes localStorage an acceptable home for it.
- Replaced every `alert`/`confirm`/`prompt` with an in-app dialog component
  (focus trap, Escape and backdrop dismissal, focus restored on close). The
  browser's own dialogs block the event loop — freezing a streaming log or a
  live terminal behind them — and Chrome suppresses repeated ones outright,
  which would have silently turned a delete guard into a deletion.
- Window close can now veto asynchronously, so unsaved-changes guards can use
  the new dialogs. Teardown paths close windows with `force` instead.
- Fixed: toasts, dialogs and the context menu lived inside the desktop shell,
  which is hidden until a session exists — so anything the greeter raised was
  invisible. They are now top-level overlays.

### Services (systemd)
- Browse every unit the manager has loaded **and** every service installed on
  disk, with live search, state filters, and a system/user scope switch.
- Per-unit detail: active/sub state, enablement, PID, memory, tasks, CPU time,
  restart count, restart policy, drop-ins, and the raw `systemctl status`.
- Live log streaming over a WebSocket carrying `journalctl -f`, with follow,
  line filtering, backlog size, and error/warning highlighting. The stream is
  run on a PTY so closing the window actually stops journalctl on the server.
- Edit the unit file or, preferably, its `override.conf` drop-in — written via
  a private temp file and `install`, then `daemon-reload`, optionally restart.
- Actions: start, stop, restart, reload, enable, disable, mask, unmask,
  reset-failed, freeze/thaw, and a standalone `daemon-reload`.
- Privilege is explicit: the relay detects root / passwordless sudo / password
  needed, asks for a sudo password only when required, uses it for that single
  command over stdin (never the command line), and never stores it.
- Unit names are validated against systemd's own naming rules before ever
  reaching a shell, and unit-file writes are confined to the systemd unit
  directories so the endpoint cannot become a general root-file-write.
- WebSocket endpoints now share one upgrade handler and one token check.

## v0.1.0 — 2026-08-20
Initial working prototype.

- SSH relay (Node 22 + ssh2) with a pooled, keepalive-maintained connection.
- Four authentication methods: password, pasted private key, key file path on
  the relay host, and ssh-agent. `keyboard-interactive` enabled as a fallback
  so password auth works against sshd configs that route it that way.
- Filesystem layer built on the SFTP subsystem rather than parsing `ls`, so
  spaces, newlines, locale and colour escapes cannot corrupt a listing.
- Operations: list, read, write, download, upload, mkdir, rename, recursive
  delete. Symlinks to directories are resolved and shown as enterable.
- Optional `ROOT_JAIL` confinement, with `realpath` resolved before the prefix
  check to close `..` traversal and symlink escape.
- Interactive PTY over WebSocket with working window-size propagation.
- Browser desktop: greeter, top bar, dock, desktop icons from `~/Desktop`
  (falling back to `$HOME`), window manager, Files, Editor, Terminal, Viewer.
- Yaru-derived visual system, responsive below 720px, reduced-motion respected.
- Verified end-to-end against a live sshd on Ubuntu 24.04.

### Known gaps
- No TLS, rate limiting, session expiry, host key verification, or audit log.
- Editor is a plain textarea; no syntax highlighting.
- Cannot run graphical Linux applications — needs a pixel-streaming layer.
