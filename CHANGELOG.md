# Changelog — WebSSH Ubuntu Desktop

## Unreleased

### Window restore after a refresh
- **A reload no longer empties the desktop.** Every window's app, geometry,
  minimise/maximise state, z-order and *what it was showing* — Files path,
  Editor file, Services unit + scope + tab, Ports, Viewer path — is kept in
  `sessionStorage` per session token, and re-opened on the next load. The
  restore happens with each session made current in turn, so a restored window
  can only land on the session it was opened on; a Services window on staging
  cannot come back on prod.
- **Terminals are reported, never resurrected.** The PTY behind a terminal dies
  with the WebSocket, which a reload guarantees. Re-opening the window would
  give a different shell — new PID, no history, no `cd`, nothing that was on the
  screen — while looking exactly like the one that was there. So a restored
  session shows a notice saying how many terminals ended, with a button that
  opens a fresh one in the directory the old one started in.
- The notice names the session, lists what came back, says when an Editor's
  unsaved edits went with the page, and can be dismissed. At most ten windows
  per session are kept, so the layout can never crowd out the session tokens.
- Disconnecting a session forgets its layout; "Disconnect all" clears the lot.

### Journal viewer
- **Priority colouring from the journal, not from the words in the line.** The
  stream is `journalctl -o json`, so each line carries `PRIORITY` and is coloured
  by it, with the severity as a word in the row's tooltip. The previous regex
  over the message text mis-coloured real logs in both directions: on this
  machine's `systemd-journald.service`, 16 of 18 genuine warnings contain no
  warning word at all, and two say "Failed" and were painted as errors.
- **A time window** — last 15 min / last hour / today / this boot / all boots —
  applied server-side as `--since`, from a fixed table of flags the browser can
  only choose from by name. Following now says `streaming · this boot` when the
  window is "all boots", because `journalctl -f` only ever replays the current
  boot whatever `-n` says.
- **Pause on scroll-up** with a "Jump to latest · n new" pill. Scrolling up to
  read something stops the view following without stopping the stream; the
  buffer keeps filling and the pill counts what you have not seen.
- **Copy and Download** hand over exactly what is on screen — text filter and
  priority floor included — as `timestamp identifier[pid]: message` lines.
- A **priority floor** (all / info / warnings / errors) filters the buffer that
  is already loaded, so narrowing to "errors only" is instant.
- Wrapped lines now hang under their own message column instead of running back
  under the timestamp, and the log's scrollbar is styled rather than the
  browser's default light-on-black.
- A non-following read that finishes no longer reports itself as a dropped
  stream: only an unexpected close gets the red "disconnected · Reconnect".

### Narrow screens
- **Below 900px a window becomes a full-bleed card, one at a time,** with the
  dock's task strip as the switcher and the active card marked in it. Nothing is
  closed or re-created — the same elements, sockets and buffers, shown
  differently — so widening the browser brings the original layout straight back.
  Drag and resize are off at card width, and closing or minimising a card
  promotes the next one rather than dropping you on an empty desktop.
- **Window geometry is clamped to the viewport on resize,** against the size the
  user actually chose, so shrinking the browser pulls windows back in and
  widening it gives their size back. Before, windows kept their desktop offsets
  and ran off the right edge with no way to reach them.
- **The greeter no longer scrolls sideways at 400px:** the authentication
  segmented control wraps instead of overflowing the card, and the decorative
  glow is clipped rather than scrollable.
- Card-width fixes found by screenshotting every surface at 360px: the Files
  toolbar wraps instead of pushing ＋ and ⬆ off the edge, a forward row stacks
  its Copy/Open actions onto their own line instead of squeezing the address to
  one character, the Services unit list gives the detail pane more room, and the
  dock's launchers shrink so the window switcher has space.

### Access gate
- The relay's per-launch access cookie is **detected on load**. Arriving without
  it — a bookmark, a second browser, a restarted relay — shows the "open the
  link printed in your terminal" explanation over the whole viewport instead of
  letting you fill in six fields and discover it on Connect.
- Pasting the `#k=` link into the tab already showing that screen now works. A
  fragment-only change never reloads a page, so it previously did nothing at all.

### Ports
- **Per-forward Copy address and Open in browser.** A running local forward
  shows the address it answers on — using the port actually bound, not the one
  requested, so a `0 = any` forward never hands you `localhost:0`. Local
  forwards get both buttons; a SOCKS forward gets a copyable `socks5://` address
  and no "Open", because a proxy is something you point a browser at rather than
  visit; a remote forward shows the address it listens on *on the server*.
- **Add is above the fold.** The New forward form moved above the list and
  collapses, so the app's primary action is no longer the one thing you have to
  scroll to find in a 560px window.
- Queued and active no longer read as the same grey word: each status is a
  coloured badge, and the list header counts both.

### Per-session overview card
- The empty desktop — the largest region of the UI, previously carrying one line
  of grey text — now shows a summary of the session it belongs to: failed units,
  uptime, disk pressure and open forwards, in the session's colour and under its
  label. Failed units opens Services already filtered to failed, disk opens
  Files, forwards opens Ports.
- It reuses `/api/system`, `/api/services` and `/api/forwards`, loads on
  activation at most once every 30 seconds, and has a refresh button. No new
  polling.

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
