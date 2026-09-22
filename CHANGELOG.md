# Changelog — su-ssh

## Unreleased

### Runs in the background by default, and can start at login/boot

- `su-ssh` now starts the relay detached and returns to the prompt once it is
  actually listening, printing the URL, PID, log path and the passphrase
  set-up instructions. If it fails to start (port taken, bad TLS file…) the
  last log lines are shown and the exit code is non-zero.
- `--foreground` / `-f` runs attached exactly as before (debugging, containers,
  service managers).
- New commands: `start`, `stop`, `restart`, `status` (exit 0 running / 3 not),
  `logs [-f] [-n N]`, `enable`, `disable`. One managed instance per user; a
  second `su-ssh` shows the running one's status. Stale pidfiles (process gone,
  or PID reused by something else) are detected and removed.
- State in `$XDG_STATE_HOME/su-ssh/` (`~/.local/state/su-ssh/`, 0700):
  `su-ssh.pid`, `su-ssh.log` (rotated at 5 MB on start, one old copy).
- `su-ssh enable [flags]` installs a systemd user service (Linux, WSL with
  systemd) or a LaunchAgent (macOS, untested); `disable` removes it. When a
  service owns the relay, `stop`/`start`/`restart`/`logs` go through it.
  WSL without systemd, native Windows and npx's cache are refused with an
  explanation of what to do instead. su-ssh never runs sudo; it prints
  `loginctl enable-linger` for boot-before-login.
- A port already in use is now reported in one line instead of a stack trace.

## v0.2.0 — 2026-09-22

### A passphrase instead of a per-launch link

The request: *"ask the user for passphrase at the beginning which can be
anything … It should be persistent whether the server is down or the system is
rebooted."*

- **Choose once, enter it to get in.** First visit shows *Choose a passphrase*
  (enter + confirm, 8+ characters, no character-class rules). Setup is accepted
  only from a loopback peer address on the socket, never from a header; a relay
  bound to a network address with none set says so in its banner.
- **Stored as a hash.** `~/.config/su-ssh/auth.json` (0600, `SU_SSH_AUTH_FILE`)
  holds a salted scrypt hash with its parameters and a random cookie-signing
  key. Nothing reversible to the passphrase.
- **Survives restarts.** The access cookie is HMAC-signed with the persisted
  key: 30 days with "Remember this browser" (default), otherwise a session
  cookie capped at 12 hours. httpOnly, SameSite=Strict, Secure under TLS.
- **Rate limited** with escalating backoff and an on-screen countdown.
- **Change passphrase** (link under the connect form) needs the current one and
  rotates the key, signing out every other browser and closing their open
  sockets. **Lock this browser** clears the cookie.
- **`su-ssh --reset-passphrase`** forgets it; the next visit shows setup. Takes
  effect on a running relay immediately.
- **Removed:** the `#k=` access link, its banner line and fragment exchange.
  `--no-auth` / `NO_ACCESS_KEY=1` still disables access control, with its warning.
### Viewers: images, PDF, video, audio, Markdown, JSON, CSV, archives, hex

The ask: *"make support for viewing images, and other things that are important
and isn't complex to implement."* Double-clicking a file now opens the right
viewer, in Files and on the desktop, and every viewer has Download.

- **Images** — zoom (fit, 100 %, wheel around the cursor, buttons, keys), pan,
  rotate, previous/next through the folder's images, a checkerboard behind
  transparency, and dimensions / size / zoom in the status bar. SVG included,
  shown only through `<img>`.
- **PDF** — the browser's built-in viewer in an iframe, titled with the real
  file name; an honest message and a Download link where there is no viewer.
- **Video and audio** — native `<video>` / `<audio>`, seekable, with a clear
  message when the browser cannot play a codec.
- **Markdown** rendered by a small escape-first renderer, **JSON** as a
  collapsible tree, **CSV/TSV** as a table capped at 1,000 rows — each with
  **View raw** and **Edit** (opens the Editor).
- **Archives** — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.tar.bz2`, `.tar.xz` listed on
  the server with `unzip -l` / `tar -tv` (`GET /api/fs/archive`). Listing only.
- **Anything else** — sniffed: text to the Editor, binary to a hex + ASCII view
  of the first 64 KB. A text file over the Editor's 2 MB limit opens as a
  read-only preview of its first 2 MB instead of an error.
- **Open with → Viewer / Editor** in the Files and desktop context menus.
- **`GET /api/fs/download` supports `Range`**: `206 Partial Content`,
  `Accept-Ranges`, `Content-Range`, open-ended (`a-`) and suffix (`-n`) ranges,
  `416` with `bytes */size` past the end, `If-Range` against `Last-Modified`,
  `HEAD`. Reads start at the offset over SFTP, and the remote read stops when
  the browser abandons a request (every seek does).
- **`GET /api/fs/peek`** — the first N bytes of a file, never more than 2 MB.
- **Security:** every download response carries `Content-Security-Policy:
  sandbox` and `nosniff`; inline types come from an allowlist and everything
  else — HTML above all — is an `octet-stream` attachment; SVG is inline only
  for `Sec-Fetch-Dest: image`. The PDF iframe relies on the response's CSP
  sandbox because Chromium refuses to run its PDF viewer in a `sandbox`-attribute
  iframe. See README → *Viewing files safely*.
- Ten Lucide icons added to the sprite (`file-video`, `file-music`,
  `file-braces`, `file-spreadsheet`, `file-code`, `zoom-in`, `zoom-out`,
  `rotate-ccw`, `chevron-left`, `scan`), regenerated with `tools/build-sprite.mjs`.
- A restored Viewer window comes back in the renderer it was using.

### Saved on the relay, not in one browser

The complaint: *"I configured things in browser A, but when I open the same
thing in browser B the previous connection config and other things are gone."*
Everything the desktop remembered lived in one browser's `localStorage`, which
is per browser, per profile and per machine. It now lives on the relay host.

- **Connection profiles** (`server/profiles.js`, `public/js/profiles.js`) in
  `~/.config/su-ssh/profiles.json` — `$XDG_CONFIG_HOME` honoured, directory
  `0700`, file `0600`, write-then-rename, and a corrupt file is a loud error
  naming the path rather than a silent "you have no saved servers". The path is
  printed in the start-up banner. One profile per `user@host:port`: host, port,
  username, auth **method**, label, colour, environment tag, pinned, connection
  count, last connected, saved forwards, restore preference and saved layout.
- **Never a credential, and enforced.** Every write is rebuilt field by field
  from an allowlist, so a client that posts `password`, `privateKey` or
  `passphrase` has it dropped rather than written. Ids and forward specs from
  the browser are re-parsed and re-derived before use.
- **API:** `GET /api/profiles`, `POST /api/profiles/update`,
  `POST /api/profiles/forget`, `POST /api/profiles/forwards/forget`,
  `POST /api/profiles/migrate`. Tokenless, because the greeter needs them before
  any session exists, and behind the same access cookie and Host/Origin guard as
  the rest of `/api`.
- **The recents list and per-host identity moved.** `ssh-recent-targets` and
  `ssh-host-identity` are imported into the profile store once, on first load,
  and then removed from the browser. The relay merges rather than overwrites, so
  a second browser arriving later with its own stale copy cannot undo the first.
  `sessionStorage` still holds the per-tab session tokens and the refresh-path
  layout, which is correct: those are per tab by definition.
- **Survives a relay restart and a reboot**, because it is a file.

### Port forwards persist per server

- Opening a forward saves its spec against that server; the next connect reopens
  it automatically, alongside anything queued on the greeter, and reports each
  one separately — so a saved tunnel whose port has since been taken is named in
  a toast rather than costing you the session.
- Closing a forward by hand un-saves it. Disconnecting does not: that is the
  whole point.
- The **Ports app** now has a *Saved for this server* fold listing what will be
  reopened, with a button to forget each one, and says where the saving happens.

### Your windows come back when you reconnect, not only when you refresh

- What was open, where, minimised or maximised, in which z-order and what each
  window was showing is written to the profile and restored on the next connect
  to that host — per profile, so two hosts connected at once keep their own
  layouts, and a restored window is bound to its own session's `createApi`
  client as every hand-opened window is.
- **Asked once per server**, the first time there is something worth restoring,
  with **Reopen them** as the primary action holding focus (so Enter is yes).
  The answer is stored on the relay, so a second browser inherits it instead of
  asking again. Changeable afterwards from the connection's name dialog
  (`yes` / `no` / `ask`) or the *Don't reopen next time* button on the notice.
- **Terminals are reopened on a reconnect** — the previous rule, that a refresh
  must never resurrect a terminal, still stands and is unchanged. A reopened
  terminal returns to its old working directory and is marked a **new shell** in
  three places: a banner drawn into the terminal before the shell's first prompt
  (naming the directory and saying there is no scrollback, no history and
  nothing still running), `Terminal — new shell` permanently in the title bar,
  and the restore notice. The banner is the top of an empty scrollback, and the
  usual `clear` after `cd` is suppressed so nothing can erase it.
- A freshly connected desktop cannot overwrite its own saved layout with the
  emptiness it has for the second before the restore runs.
### UI polish (QA M1–M6)

- **Red means production, and the auto palette no longer dilutes it** (M1). The
  old eight had `#E95420` a short hop from the `#C01C28` production red and
  handed it to arbitrary hosts. QA measured `#E95420`/`#E66100` at ΔE 11.8 and
  `#9141AC`/`#C061CB` at 14.6; in CIEDE2000 those two orange are **6.55** apart,
  and under simulated deuteranopia **1.66** — not "near-indistinguishable" but
  the same colour. The old palette fails `npm run check:palette` on five counts.
  The new eight (`#DA800D` `#E7D032` `#98D28D` `#00987E` `#37E5E0` `#29ADEF`
  `#5C77F3` `#AC7BAA`) were chosen by search, not by eye: the whole red/pink
  hue band (Lab 330°–42°) is reserved so nothing else can *read* as red, and across all
  36 pairs including the prod red the minimum separation is ΔE2000 **21.5**,
  with **32.3** from any host colour to the red, **13.3 / 11.9 / 11.9** under
  simulated protanopia / deuteranopia / tritanopia, and 4.55–11.4 contrast on
  the rail chrome. Colour is still never the only signal.
  New: **`npm run check:palette`** (`tools/check-palette.mjs`, no dependencies)
  re-derives every one of those numbers from `sessions.js` and fails if they
  drift — including the hue reservation. It fails on the old palette.
- **The per-chip disconnect button is gone on pointer devices** (M4). It was
  26×24px pinned to the chip's bottom-right corner, overlapping the switch
  target by ~21–24% with a **0px** gap, permanently visible wherever the browser
  reports no hover, and behind a single confirm — a destructive action sharing
  edges with the control you press dozens of times an hour. A chip is 60px wide
  and does not have room for two targets. Disconnect now lives only in the chip
  menu, reachable three ways: right-click, `Shift+F10` / the Menu key on a
  focused chip (new), and a non-destructive `⋮` button on touch. What remains
  inline is a *stacked sibling*, never an overlay: 0% overlap, a real 4px gap
  (`--chip-act-gap`) and a ≥24px target, all measured from `getBoundingClientRect`
  and confirmed with `elementFromPoint`.
- **A dropped session keeps its always-visible Reconnect** — it is not
  destructive, and a dropped host is unusable until you act on it.
- **AC19 at 360px: the host survives** (M5). The top-bar label is now two spans
  with a 999:1 `flex-shrink` ratio, so `user@` is eaten to nothing before the
  host loses a character (spec §3.6.3) — it used to ellipsise from the right,
  which is exactly where the host lives. The root cause of the truncation was
  that the `max-width: 620px` block sat *above* the `.topbar__chip` rule it
  meant to override and lost on source order alone; it now sits after it, drops
  the Capture-keys button and the word "Disconnect", and lets the chip take the
  slack. `.sysmon` yields to the identity chip rather than the other way round.
- **The `.win__host` rule is stated and asserted** (M5). The host is named in
  exactly one always-visible place, the top-bar chip. `.win__host` is a second
  copy for tiled windows: shown above 720px with real width, `display: none` at
  or below it — never present-but-zero-width.
- **The narrow rail is sized from the chip stack**, 90px rather than 62px, with
  a thin scrollbar; at 62px the bottom row of every chip — including a `PROD`
  tag — was cropped, which no DOM measurement reported.
- **`Alt+Shift+N` no longer escapes the modal guard** (M6). It used to open the
  connect form over an open dialog, really establish the SSH session, and then
  have `activate()` refuse it — leaving a live session to a second host while
  the top bar, the tab title and the workspace all still showed the old one.
  The shortcut (and the rail's `+`) is now refused while a modal is open, with a
  toast saying why; and a session that has just been created is activated
  unconditionally, because refusing to show it does not undo the connection, it
  only hides it. There is no longer a state in which a connected session is
  invisible.
- **The unsaved-editor close confirm names its host** (M2), like every other
  destructive confirm: "Discard unsaved changes on `prod-db`?" over
  "`~/notes.txt` on prod-db (deploy@10.0.0.4)", accented in the session colour.

### A real icon system
- **Every emoji and character icon is gone.** The file-type map (📁 📄 🖼️ 📕 🗜️ ⚙️ ❓),
  the window controls (`–` `□` `✕`), the taskbar glyphs, the Files toolbar
  (`←` `→` `↑` `⌂` `⟳` `＋` `⬆`), the recents pin/forget (`★` `☆` `✕`), the rail
  `+` / `⋯` / `⟳` / `✕`, the forward badges (`−L` `−R` `−D`), the services
  refresh, the host-key `⚠` and the greeter's `▸` are now icons from
  [Lucide](https://lucide.dev). Emoji rendering varied per platform, was missing
  entirely on servers and in headless browsers, and was announced as gibberish by
  screen readers.
- **One vendored sprite, no CDN.** `public/icons/icons.svg` is 77 symbols in
  14,980 bytes (3,548 gzipped), served by the existing `express.static` and
  referenced with `<use>`; the app still works with no internet. Not inlined as a
  `data:` URI — Chrome removed `data:`-URI `<use>` in 120, Firefox in 122.
  `lucide-static` is not a runtime dependency; `tools/build-sprite.mjs`
  regenerates the sprite by hand from `tools/icon-names.json`.
- **`icon()` / `iconButton()`** in `public/js/icon.js`. Every `<svg>` is
  `aria-hidden="true" focusable="false"` with no way to turn that off, and
  `iconButton()` throws without a label, so an icon-only control cannot ship
  unnamed. An unknown icon name is a console error and a visible
  `circle-alert`, not an invisible gap.
- **The five hand-drawn dock SVGs are replaced** by `folder`, `terminal`,
  `arrow-right-left`, `server` and `file-pen`: solid tinted paths next to stroke
  art read as two different icon sets.
- **Fixed the CSS trap:** `.dock__item svg { fill: var(--orange) }` would have
  rendered stroke-art icons as solid blobs. Icons are now `fill: none;
  stroke: currentColor`, and colour is inherited from any ancestor's `color`.
- **Status is a shape, not only a colour.** The connection dot is
  `circle-dot` / `loader` / `unplug` and a service is
  `circle-check` / `circle-x` / `loader` / `circle-minus`, so red/green
  colour-blindness no longer erases the meaning. The reconnecting container
  carries `role="status"`.
- **Taskbar buttons are distinguishable.** A task button is now an icon, a
  truncated title and an ordinal badge, named
  `"<title> <n> — <session>"` — so two Terminals on `prod-db` are "Terminal 1 —
  prod-db" and "Terminal 2 — prod-db" rather than two identical glyphs with two
  identical names. Names are re-derived for every sibling whenever one opens or
  closes, because a stale ordinal is worse than none.
- **Maximise and Restore are now different** — different icon, different
  accessible name, plus `aria-pressed`.
- **Accessible names added** where only a `title` existed: the seven Files
  toolbar buttons, the Services refresh and daemon-reload buttons, and the
  forward close buttons (which now name the endpoints, not just "Close").
- Attribution and the upstream licence ship with the package: see
  `public/icons/LICENSE.lucide.txt` and the Credits section of the README.
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
