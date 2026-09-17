# su-ssh

A browser desktop for any Linux server, over nothing but SSH.

Files, a real terminal, an editor, systemd service control with live logs, port
forwarding, and live CPU/memory/disk/latency meters — all read and driven over a
single SSH connection. Nothing is mirrored, synced or cached on the machine
running the relay.

```bash
npx su-ssh
# → http://127.0.0.1:3000
```

Open the URL, enter a host, username and credentials, and connect. There is no
agent to install on the target server: if you can `ssh` into it, this works.

Open the link it prints: it carries a one-time access key for that launch.

> **Read [Security](#security) before putting this anywhere public.** Without
> `--tls-cert` it accepts SSH credentials over plain HTTP. Bind it to localhost
> (the default) and tunnel in, or terminate TLS.

---

## What it does

- **Files** — SFTP-backed manager: browse, rename, delete, download, drag-and-drop upload
- **Terminal** — a real PTY, so `vim`, `htop`, colours, Ctrl-C and tab-completion all work
- **Editor** — open, edit and save any text file on the server
- **Services** — search systemd units, stream `journalctl -f`, edit unit files or
  drop-in overrides, and start/stop/restart/enable/disable/mask
- **Ports** — local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`) tunnels, opened
  and closed live without reconnecting
- **Monitor** — CPU, memory, disk space, disk active time and round-trip latency
  in the top bar, updating every two seconds
- **Several servers at once** — a host rail beside the dock holds up to eight live
  connections in one tab, each with its own windows, colour and label; switching
  closes no socket and loses no unsaved buffer

---

## Install

```bash
npx su-ssh                    # run without installing
npm install -g su-ssh         # or install the command
su-ssh --port 8080
```

```
Options
  -p, --port <port>     Port to listen on            (default 3000)
  -H, --host <addr>     Address to bind              (default 127.0.0.1)
      --jail <path>     Confine file operations below this path
      --allow-public-forwards
                        Permit port forwards to bind non-loopback addresses
      --allowed-host <name[:port]>
                        Also answer to this Host header (repeatable)
      --idle-timeout <mins>
                        Close sessions with no open window after this many
                        idle minutes                 (default 15, 0 = never)
      --tls-cert <file> / --tls-key <file>
                        Serve HTTPS instead of HTTP
      --no-auth         Do not require the per-launch access link
      --forget-host <host[:port]>
                        Remove a pinned host key, then exit
```

Requires **Node 20+** on the machine running the relay. The remote server needs
only `sshd`; systemd features additionally need `systemd` and `journalctl`.

| Variable    | Default     | Purpose |
|-------------|-------------|---------|
| `PORT`      | `3000`      | Relay HTTP port |
| `BIND`      | `127.0.0.1` | Bind address. Localhost by default, on purpose |
| `ROOT_JAIL` | *(unset)*   | Confine all file operations to this path |
| `ALLOW_PUBLIC_FORWARDS` | *(unset)* | Allow forwards to bind non-loopback addresses |
| `ALLOWED_HOSTS` | *(unset)* | Extra `Host` header values to accept, comma separated |
| `SESSION_IDLE_MINUTES` | `15` | Close sessions with no open window after this long; `0` never |
| `MAX_SESSIONS` | `16` | Most SSH sessions the relay will hold at once; further connects get 429 |
| `TLS_CERT` / `TLS_KEY` | *(unset)* | Serve HTTPS with this certificate and key |
| `NO_ACCESS_KEY` | *(unset)* | `1` disables the per-launch access link |
| `KNOWN_HOSTS_FILE` | `~/.config/su-ssh/known_hosts.json` | Where host keys are pinned |
| `SSH_KNOWN_HOSTS` | `~/.ssh/known_hosts` | Existing known_hosts consulted for already-trusted servers |

Reaching it from another machine — do this rather than setting `BIND=0.0.0.0`:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

---

## Authentication

Four methods, selectable in the greeter:

| Method | What you supply | Where the secret goes |
|---|---|---|
| **Password** | Password | Relay memory for the life of the connection |
| **Private key** | Key text pasted or dropped in | Read in the browser, sent once, never written to disk |
| **Key file** | A path on the relay host | Read by the relay process; nothing crosses the network |
| **Agent** | Nothing | Delegated to `ssh-agent` via `SSH_AUTH_SOCK` |

`keyboard-interactive` is enabled alongside password auth. Many `sshd`
configurations answer password logins through that method instead of the
`password` method, and without the fallback a correct password fails with a
misleading "all authentication methods failed".

---

## Architecture

```
Browser  ──HTTP + WebSocket──▶  Relay (Node)  ──SSH / SFTP──▶  Remote Ubuntu
```

The relay is not optional. SSH is a raw TCP protocol and no browser can open a
raw TCP socket, so something has to translate. The relay holds one long-lived
SSH connection and exposes it as an API.

**Files come from SFTP, not from `ls`.** `ls` output is a display format: it
breaks on filenames with spaces or newlines, changes shape with locale and
terminal width, and injects colour escapes when it thinks it is on a tty. The
SFTP subsystem returns `name`, `size`, `mode` and `mtime` as typed fields over
the same connection and the same authentication — and because no shell is
involved, a filename can never be interpreted as a command.

The terminal is a genuine PTY channel on that same connection, which is why
`vim`, `htop`, colours, `Ctrl-C` and tab-completion all work.

```
server/
  index.js         HTTP server, static hosting, system info, error handling
  ssh-session.js   Connection lifecycle and every auth variation
  routes-fs.js     SFTP operations + path jail
  terminal-ws.js   PTY ⇄ WebSocket bridge
public/
  index.html       Greeter and desktop shell
  css/desktop.css  Yaru-derived visual system
  js/api.js        Relay client
  js/wm.js         Window manager (drag, resize, focus, minimise, maximise)
  js/apps.js       Files, Editor, Terminal, Viewer
  js/ui.js         Toasts, context menu, formatters
  js/main.js       Greeter flow, session lifecycle, desktop icons, dock
  js/icon.js       icon() / iconButton() — the one icon system
  icons/icons.svg  Vendored Lucide subset, referenced with <use>
tools/
  build-sprite.mjs Regenerates icons/icons.svg from a lucide-static checkout
```

**Icons are a vendored SVG sprite, not a CDN and not a font.** `public/icons/icons.svg`
holds 77 symbols in one 15 kB file (3.5 kB gzipped), served by the same
`express.static` as everything else, and each call site is a ~60-byte
`<use href="/icons/icons.svg#i-name">`. That keeps the app working with no
internet, themes every icon through `currentColor`, and keeps screen readers
away from private-use codepoints. The sprite is generated by hand with
`node tools/build-sprite.mjs <lucide-static checkout>`; there is no build step in
`npm start` and `lucide-static` is not a dependency.

---

## What works

- Desktop icons read from `~/Desktop`, falling back to `$HOME` on a headless box
- File manager: navigate, back/forward/up/home, type a path, right-click menu
- Create folders, rename, recursive delete, download, drag-and-drop upload
- Text editor with `Ctrl-S`, unsaved-changes guard, binary-file detection
- Full interactive terminal with working resize
- Image viewer
- Services: search systemd units, edit the unit file or a drop-in override, and
  start/stop/restart/enable/disable/mask
- Journal viewer: lines coloured by the journal's own `PRIORITY` (not by
  grepping the text), a time window of 15 min / 1 hour / today / this boot / all
  boots applied server-side as `--since`, a priority floor, a text filter,
  pause-on-scroll-up with a "jump to latest" count, and Copy / Download of
  exactly what is on screen
- Port forwarding: local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`),
  queued on the greeter or added and closed live from the Ports app; a running
  forward shows the address it answers on, with Copy and — for a local forward —
  Open in browser
- Window manager: drag, resize, focus, minimise, maximise, dock task list
- Live top-bar meters: CPU, memory, disk space, disk active time, and the
  browser→relay→server round trip
- Recent connections on the greeter, with relative times and pinning; a saved
  entry that needs no secret (agent auth) connects in one click
- Multi-session: up to eight connections per tab on a host rail, each with its
  own windows, dock tasks, desktop icons and meters. Switching hides one
  workspace and shows another — no socket closes, no long-running command dies,
  no editor buffer is lost. `Alt+Shift+1…8` jumps, `Alt+Shift+[` / `]` cycles,
  `Alt+Shift+N` adds a connection; none of them reach the terminal
- Per-host identity: an auto-assigned colour from an eight-colour palette, an
  editable label and an optional `dev`/`staging`/`prod` tag, shown in the rail
  chip, the top bar, a colour line across the desktop, every window title and
  the browser tab title
- Real connection status: the top-bar dot is live / reconnecting / dropped per
  session, a dropped host keeps its windows frozen with Reconnect / Close, and a
  terminal or journal stream that dies offers Reconnect where it died
- Editing a root-owned file in the Editor offers a confirmed `sudo` retry
- A per-session overview card on the empty desktop: failed units, uptime, disk
  pressure and open forwards, each clicking through into the relevant app
- Sessions *and their windows* survive a page refresh — app, geometry,
  minimise/maximise, z-order and what each window was showing come back on the
  session they were opened on, and you are told what came back. Terminals are
  the exception: see below. `Disconnect` acts on the active session, and the
  rail menu can disconnect all of them
- The access gate is detected when the page loads, so a browser without this
  launch's cookie is told to open the printed link instead of finding out after
  filling in the connect form
- Responsive: below 900px each window becomes a full-bleed card with the dock's
  task strip as the switcher, and window geometry is clamped into the viewport
  as it changes; below 720px the dock moves to the bottom with the rail above it

### Why a refresh does not bring your terminals back

Everything else is a view over a request that can simply be made again — a
directory listing, a file, a unit's status. A terminal is not: it is a view onto
a PTY on the far side, and that PTY dies with the WebSocket, which a page reload
guarantees. Re-opening the window would start a *different* shell — new PID, no
history, no `cd`, no half-typed command, none of what was on the screen — while
looking exactly like the one that was there before.

For an audience whose expensive mistake is "my command went somewhere", a
terminal that silently is not the terminal you left is worse than no terminal.
So a restored session says how many terminals ended and offers to open a fresh
one, in the directory the old one was opened at.

## Keyboard

The complaint this section exists for: *"in nano I can press Ctrl+W to search,
but in the browser that closes the tab."* Here is exactly what su-ssh can and
cannot do about it, with no hand-waving.

Every browser keeps a short list of **reserved** shortcuts that its own UI
handles *before* the page is told a key was pressed. For those, there is no
`keydown` event and therefore nothing any web page can intercept. Everything
*not* on that list is delivered to the page first, and su-ssh now takes it.

**What that fixes, with no setting to turn on:** nano's `Ctrl+K`, `Ctrl+O`,
`Ctrl+R`, `Ctrl+U`, `Ctrl+G`, `Ctrl+E`, and every vi and readline chord —
`Ctrl+A/B/D/F/L/P/S/X/Y` — now reach the shell instead of opening Find,
Downloads, the address bar or a bookmark dialog. Alt+B and Alt+F still work.

### What the browser keeps, and on which browser

Normal tab, page focused. These are read from Chromium's
`BrowserCommandController::IsReservedCommandOrKey` and Firefox's
`browser-sets.inc` `reserved="true"` keys, not from experiment.

| Shortcut | Chrome / Edge | Firefox | How to get it back |
|---|---|---|---|
| `Ctrl+W` (close tab) | **browser's** | **browser's** | Capture keys, or install as an app |
| `Ctrl+T`, `Ctrl+N` | **browser's** | **browser's** | Capture keys, or install as an app |
| `Ctrl+Shift+W` | **browser's** | **browser's** | Capture keys |
| `Ctrl+Shift+T` | **browser's** | yours | — |
| `Ctrl+Shift+N` / `Ctrl+Shift+P` | **browser's** | **browser's** | Capture keys |
| `Ctrl+Q` | **browser's** | **browser's** | Capture keys |
| `Ctrl+Tab`, `Ctrl+PgUp/PgDn` | **browser's** | probably the browser's | Capture keys |
| `Alt+Tab`, `Super`, `Ctrl+Alt+Del`, `Alt+F4` | the OS | the OS | Nothing. Ever. |
| everything else | **yours** | **yours** | already done |

`Ctrl+Shift+C` and `Ctrl+Shift+I` are *not* on either reserved list, so su-ssh
binds `Ctrl+Shift+C` to copy — but it is deliberately redundant with `Ctrl+C`,
because devtools chords are registered outside those lists and we will not
promise what we cannot read from a source tree.

**On macOS none of this bites.** The browser's commands live on Command and a
terminal's live on Control, so the whole `Ctrl+W` / `Ctrl+K` set is free in
every browser.

### Capture keys (Chrome and Edge only)

The `Capture keys` chip in the top bar, or `Alt+Shift+K`, puts the page into
fullscreen and calls Chromium's Keyboard Lock API. That is the only mechanism
that recovers `Ctrl+W`. While it is on:

- `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+Q` and the tab-switching chords all go to
  the terminal.
- A **tap** of `Esc` still reaches the terminal, so vi and nano are unaffected.
  **Holding** `Esc` for about two seconds leaves fullscreen and the lock. So does
  clicking the chip, or `Alt+Shift+K` again.
- `Alt+Tab` and `Super` still belong to the operating system. The API cannot
  take a platform secure-attention sequence and would be a security bug if it
  could.

The chip's state is driven entirely by the `fullscreenchange` event, never by
its own click, so it cannot claim a capture that failed to register.

Firefox and Safari have never implemented `navigator.keyboard`, in seven years,
and the button says so rather than pretending. If you need `Ctrl+W` in a
terminal, use Chrome or Edge, or install su-ssh as an app.

### Installing as an app

A web app manifest ships, so Chrome and Edge offer **Install su-ssh…** in the
three-dot menu. In a Chromium app window *nothing* is reserved — that is
explicit in the browser's own source — so `Ctrl+W` is delivered to the page like
any other key. Treat this as a second mechanism, not the primary one: Chromium's
delivery in app windows is reported to vary with what has focus.

### There is deliberately no service worker — please do not add one

A manifest alone is enough to install since Chrome 112; a service worker buys
nothing here and costs a great deal.

- The app is never offline *from its own server*. The page only exists while
  `npx su-ssh` is running, and it is served over loopback.
- The failure mode is severe and asymmetric. A stale `main.js` cached against a
  freshly upgraded relay gives you a client and a server that disagree about the
  WebSocket protocol and the session-token format — in a tool whose job is
  holding live root shells. The user's instinctive recovery, a hard reload, is
  precisely what a service worker is designed to survive.
- If a future version genuinely needs cached assets, the answer is HTTP cache
  headers on `express.static`, not a service worker.

### Copy and paste

| Gesture | What happens | Can it prompt? |
|---|---|---|
| `Ctrl+C` **with a selection** | Copies the selection. No SIGINT. | no |
| `Ctrl+C` **with nothing selected** | SIGINT, as always. | no |
| `Ctrl+Shift+C` | Always copies the selection. | no |
| `Ctrl+V`, `Shift+Insert`, middle-click | Paste, with bracketed paste. | **no** |
| `Ctrl+Shift+V` | Paste. | yes |
| Right-click → Copy / Paste / Select all / Clear | | Paste: yes |

The two paths that can raise the browser's clipboard-read prompt are both
duplicates of paths that cannot. Deny the permission and you lose nothing:
`Ctrl+V` and `Shift+Insert` still paste.

### Other keys

| Chord | Action |
|---|---|
| `Alt+Shift+1` … `8` | Switch to that connection |
| `Alt+Shift+[` / `]` | Previous / next connection |
| `Alt+Shift+N` | New connection |
| `Alt+Shift+K` | Toggle Capture keys |
| `Alt+Shift+H`, or `F1` outside a terminal | The keyboard panel, with all of the above |
| `Ctrl+S` | Save — in the Editor only. Never claimed in a terminal. |

`F1` is deliberately *not* bound while a terminal has focus, because nano uses
it for help.

Closing the tab or reloading asks for confirmation, but only while a connected
session actually has a terminal window open — so a mistyped `Ctrl+W` costs a
dialog instead of a root shell, and the greeter never nags.

## What does not work, by design

**Running graphical Linux applications.** There is no X server and no pixels to
send. This desktop is a metaphor drawn in HTML over a data API. Double-clicking
LibreOffice does nothing.

For real GUI apps you need a different architecture — pixel streaming via
Apache Guacamole, KasmVNC, xpra or noVNC. That layer can sit alongside this one:
keep this UI for files and terminals, and open a streamed window when someone
actually needs a GUI app.

---

## Security

This is a shell exposed over HTTP on your own machine, and it is built to be
honest about what that means.

**In place**

- **Access link.** Every launch prints `http://127.0.0.1:3000/#k=<key>`. The key
  lives in the URL fragment, which browsers never send to a server, so it cannot
  land in a log or a `Referer`. The page trades it once for an `httpOnly;
  SameSite=Strict` cookie and strips it from the address bar. Nothing is written
  to disk; restarting the relay revokes every browser. `--no-auth` turns this off
  for setups where a reverse proxy authenticates users instead.
- **DNS-rebinding and cross-site protection.** Every HTTP request and WebSocket
  upgrade must carry a `Host` header on an allowlist (`localhost`, `127.0.0.1`,
  `[::1]` and the bind address, each on the listening port, plus anything in
  `ALLOWED_HOSTS` / `--allowed-host`). State-changing requests and all WebSocket
  upgrades must also carry an allowed `Origin`, which is the only cross-site
  barrier a WebSocket has — browsers do not apply CORS to them.
- **Elevated file writes are explicit, and grant nothing new.** The Editor can
  save a file the SSH user cannot write: the content goes up over SFTP to a
  private temp file in that user's own home and is moved into place with
  `install` under `sudo`, so the password only ever reaches sudo's stdin and the
  content never reaches a command line. Unlike the unit-file editor, there is no
  path whitelist — this is a general text editor, and refusing
  `/etc/nginx/nginx.conf` while allowing `/etc/systemd/system/x.service` would
  only push people back to a terminal. What keeps that safe is that it is not a
  privilege escalation: reaching it needs the access cookie, an allowed Host and
  Origin and a live session token, `sudo` still authenticates as the SSH account
  and still obeys the target's sudoers, `ROOT_JAIL` applies as it does to every
  other file call, and the elevated attempt only happens after the user confirms
  a dialog naming the host (and, for a host tagged `prod`, types its host name).
  An existing file keeps its owner and mode.
- **Host key verification**, trust on first use with pinning. An unknown server
  is refused with its SHA256 fingerprint and key type; the greeter shows them and
  connects only after you confirm, then pins that exact key in
  `~/.config/su-ssh/known_hosts.json` (0600). Entries in your own
  `~/.ssh/known_hosts`, plain or hashed, are honoured, and an `@revoked` entry is
  refused. A **changed** key is a hard stop with no override in the browser: clear
  the pin on the relay host with `su-ssh --forget-host host[:port]`.
- **Rate limiting** on `/api/connect`, per client address: a sliding window of 10
  attempts a minute, plus a lockout that doubles with each authentication failure
  (5s, 10s, 20s … capped at 15 minutes) and resets on a successful sign-in. The
  greeter shows the wait as a countdown.
- **Idle session reaping.** A closed tab used to leave the SSH connection, its
  port forwards and its sampler loops running until the relay restarted. Sessions
  with no open WebSocket and no HTTP activity for `--idle-timeout` minutes
  (default 15) are destroyed. An open desktop holds the metrics socket, so it is
  never reaped while you are looking at it.
- **Optional TLS** with `--tls-cert` / `--tls-key`; the WebSocket URLs follow the
  page's protocol, and the access cookie is then marked `Secure`.
- The ssh-agent socket is taken from the relay's own `SSH_AUTH_SOCK` only — a
  request cannot name a socket for the relay to talk to — and an unreadable key
  file gives one generic message, so the field cannot be used to probe the relay
  host's filesystem.
- Session token required on every API call and on the WebSocket upgrade
- Path jail via `ROOT_JAIL`, with `realpath` resolved *before* the prefix check,
  so `..` traversal and symlink escapes are both closed
- No shell interpolation anywhere in the file layer — SFTP only
- Refuses to delete `/` or the home directory
- Binds to localhost by default
- systemd actions run under `sudo -S` with the password on stdin, so it never
  appears in the remote process list; nothing caches it, and unit-file writes
  are confined to the systemd unit directories
- Port forwards refuse a non-loopback bind unless `ALLOW_PUBLIC_FORWARDS=1`, and
  every forward dies with the session that created it
- Passwords and keys are cleared from the DOM once the connection is up
- The recent-connections list stores only host, port, username and auth method
  — never a credential

**Not in place — know these before you expose it**

- **Plain HTTP unless you configure TLS.** Credentials are posted in the clear
  without `--tls-cert`/`--tls-key` or a TLS-terminating proxy in front.
- **Audit logging.** Connections, forwards, systemd actions and refusals are
  logged; individual file operations are not.
- **Multi-user separation.** Anyone holding the access link has the whole relay:
  there are no accounts, roles or per-session ownership.
- **Rate limiting is per address and in memory.** Behind a reverse proxy every
  request appears to come from the proxy, so the limiter becomes global; counters
  reset when the relay restarts.

The session token is kept in `sessionStorage` so a refresh does not log you out.
That is a prototype convenience — any script on this origin can read it. The
access cookie above is `httpOnly`, so the page cannot read *that*.

Window layout is kept alongside it in `sessionStorage`, keyed by session token:
which app, its rectangle, and the path, unit or tab it was showing. No file
contents, no scrollback and no buffers — the same origin caveat applies, so
nothing worth stealing is written there.

---

## Verified against a live server

Tested end-to-end against a real `sshd` on Ubuntu 24.04, not mocked:

- Password, pasted-key, and key-file authentication all connect
- Wrong password produces a specific, actionable error
- Filenames containing spaces survive listing, rename and delete
- A file named `weird  name -rw- 4096 Jan 1.txt` parses correctly — the case
  that breaks every `ls`-parsing implementation
- Symlinks to directories are followed and shown as enterable
- Binary vs text detection correct for a random-bytes file
- 400 B download and 2 KB upload round-trip with matching MD5
- `ROOT_JAIL` blocks both `~/../../etc` and an absolute `/etc`
- PTY reports the right user and propagates terminal width (`tput cols` → 100)
- WebSocket upgrade with a bogus token is rejected with 401
- No console errors in the browser

---

## Credits

Icons from [Lucide](https://lucide.dev) — ISC licence, © Lucide Icons and
Contributors. Some icons are derived from [Feather](https://feathericons.com) —
MIT licence, © 2013–present Cole Bemis. The full notice, including the list of
icons the MIT terms cover, ships verbatim as `public/icons/LICENSE.lucide.txt`.

Terminal rendering by [xterm.js](https://xtermjs.org) — MIT licence.

---

## Next, in order

Known gaps, roughly in the order they are worth closing:

1. **Services actions are not conditioned on state** — Mask, Unmask, Enable and
   Disable are all offered whatever the unit is doing, and the failed/running
   counts are not clickable filters. Cheap, and it is the main reason the
   Services detail is cramped on a narrow screen.
2. **Right-click menus are pointer-only**, so Download, Rename and "Open
   terminal here" cannot be reached from the keyboard at all.
3. **CodeMirror 6** in place of the plain `textarea`: line numbers, go-to-line,
   and a diff before saving a config file — the last one matters most now that
   the editor can write as root.
4. **TLS in front of it** — needed before this is exposed beyond localhost,
   though `--tls-cert` now exists for the simple case.
5. **App-level users** with their own login, mapped to real Unix accounts.
6. **Per-user containers** — what makes GUI apps and true isolation possible at
   the same time. Price out Kasm Workspaces before building it.
