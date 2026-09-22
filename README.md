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

The first time, open it in a browser **on the same machine** and choose a
passphrase (8+ characters, anything goes). Every later visit, from any browser,
asks for it; restarts and reboots do not. Forgot it? `npx su-ssh --reset-passphrase`.

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
  -f, --foreground      Run attached instead of in the background
      --no-auth         Do not ask for a passphrase (authenticating proxy only)
      --reset-passphrase
                        Forget the passphrase and sign out every browser, then exit
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
| `NO_ACCESS_KEY` | *(unset)* | `1` disables the passphrase (`--no-auth`) |
| `SU_SSH_AUTH_FILE` | `~/.config/su-ssh/auth.json` | Passphrase hash and cookie-signing key |
| `KNOWN_HOSTS_FILE` | `~/.config/su-ssh/known_hosts.json` | Where host keys are pinned |
| `SSH_KNOWN_HOSTS` | `~/.ssh/known_hosts` | Existing known_hosts consulted for already-trusted servers |

Reaching it from another machine — do this rather than setting `BIND=0.0.0.0`:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

---

## Running in the background and at startup

`su-ssh` starts the relay **in the background** and gives you the prompt back
once it is listening (it prints the URL, the PID, where the log is, and — on
first run — where to choose your passphrase). Use `su-ssh --foreground` (`-f`)
to run attached as before.

```bash
su-ssh --port 8080     # start detached (same as: su-ssh start --port 8080)
su-ssh status          # running? PID, URL, uptime, log; exit 0 running, 3 not
su-ssh logs -f         # follow the log (-n 200 for more history)
su-ssh restart         # reuses the flags it was started with, unless you give new ones
su-ssh stop            # SIGTERM, SIGKILL after 5 s
```

One managed instance per user: running `su-ssh` while one is up shows its
status instead of starting a second. State lives in
`$XDG_STATE_HOME/su-ssh/` (default `~/.local/state/su-ssh/`, mode 0700):
`su-ssh.pid` (PID, port, flags) and `su-ssh.log` (rotated at 5 MB when the relay
starts, one old copy as `su-ssh.log.1`). A pidfile whose process has died, or
whose PID now belongs to something else, is noticed and removed.

**Start automatically:**

```bash
npm install -g su-ssh          # enable refuses to run from npx's cache (see below)
su-ssh enable --port 8080      # flags are baked into the service
su-ssh disable                 # stop and remove it
```

- **Linux / WSL with systemd:** writes a user unit
  `~/.config/systemd/user/su-ssh.service` (`Restart=on-failure`) and runs
  `systemctl --user enable --now su-ssh`. A detached relay is stopped first so
  the port is free. A user service starts when you log in; to start it **at
  boot, before anyone logs in**, run once `sudo loginctl enable-linger $USER`
  (su-ssh prints this and never runs sudo itself). Logs go to the journal:
  `su-ssh logs -f` runs `journalctl --user -u su-ssh -f`. While the service is
  installed, `start`/`stop`/`restart` act through `systemctl --user`.
- **WSL without systemd:** `enable` explains how to turn it on
  (`[boot]` / `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`).
- **macOS:** installs a LaunchAgent (`~/Library/LaunchAgents/`, `RunAtLoad` +
  `KeepAlive`, log in `~/Library/Logs/su-ssh.log`) via `launchctl bootstrap`.
  **Untested** — reports welcome.
- **Native Windows / no service manager:** refused with the manual alternative
  (run `su-ssh --foreground` from your own init system or Task Scheduler).
- **npx:** `npx su-ssh enable` is refused, because npx's cache directory can be
  wiped or replaced at any time and the service would stop working at the next
  boot. Install globally first.

Environment the relay reads (`SU_SSH_AUTH_FILE`, `BIND`, …) is copied into the
service when you run `enable`; relative `--jail`/`--tls-*` paths are made
absolute. Tests can redirect state with `SU_SSH_STATE_DIR` and the unit name
with `SU_SSH_SERVICE_NAME`.

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
  routes-fs.js     SFTP operations + path jail; download (Range), peek, archive listing
  inline-policy.js What may be served inline, and how a Range header is read
  terminal-ws.js   PTY ⇄ WebSocket bridge
public/
  index.html       Greeter and desktop shell
  css/desktop.css  Yaru-derived visual system
  css/viewers.css  The Viewer's own styles
  js/api.js        Relay client
  js/wm.js         Window manager (drag, resize, focus, minimise, maximise)
  js/apps.js       Files, Editor, Terminal
  js/viewers.js    Viewer: image, PDF, video, audio, Markdown, JSON, CSV, archive, hex
  js/ui.js         Toasts, context menu, formatters
  js/main.js       Greeter flow, session lifecycle, desktop icons, dock
  js/icon.js       icon() / iconButton() — the one icon system
  icons/icons.svg  Vendored Lucide subset, referenced with <use>
tools/
  build-sprite.mjs Regenerates icons/icons.svg from a lucide-static checkout
```

**Icons are a vendored SVG sprite, not a CDN and not a font.** `public/icons/icons.svg`
holds 87 symbols in one 17 kB file (3.9 kB gzipped), served by the same
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
- Viewer — double-click a file (in Files or on the desktop) and it opens in the
  right one; right-click offers **Open with → Viewer / Editor**; every viewer has
  **Download**. See **Viewing files** below for what each one does.
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
  `Alt+Shift+N` adds a connection; none of them reach the terminal, and none of
  them work while a dialog is open — the host you are looking at is the host the
  dialog is about
- Per-host identity: an auto-assigned colour from an eight-colour palette, an
  editable label and an optional `dev`/`staging`/`prod` tag, shown in the rail
  chip, the top bar, a colour line across the desktop, every window title and
  the browser tab title. **Red means production and nothing else**: the palette
  reserves the whole red/pink band, and its eight colours are a minimum
  CIEDE2000 of 21.5 apart from each other and 32 from the production red, under
  normal vision and under simulated protanopia, deuteranopia and tritanopia
- Disconnecting a host is in the chip's menu — right-click, `Shift+F10` or the
  Menu key on a focused chip, or the `⋮` button on touch — never a button beside
  the control that switches to it
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
- The passphrase screen comes up when the page loads, so a browser without a
  valid cookie is asked for it before the connect form, never after
- Responsive: below 900px each window becomes a full-bleed card with the dock's
  task strip as the switcher, and window geometry is clamped into the viewport
  as it changes; below 720px the dock moves to the bottom with the rail above it.
  The host name is the last thing any layout gives up: the top-bar chip truncates
  `user@` before it touches the host, and keeps the whole host name at 360px. The
  per-window host label is a second copy for tiled windows and is dropped
  entirely below 721px, where the chip is the one always-visible host name

### Viewing files

| Files | Viewer |
|---|---|
| `png jpg jpeg gif webp avif bmp ico svg` | Zoom (fit, 100 %, wheel around the cursor, buttons, `+`/`-`/`0`/`1`), drag to pan, rotate (`R`, `Shift+R`), previous/next image in the same folder (`←`/`→`), checkerboard behind transparency; dimensions, size and zoom in the status bar |
| `pdf` | The browser's own PDF viewer. Where the browser has none (`navigator.pdfViewerEnabled === false`) it says so and offers Download |
| `mp4 m4v webm ogv mov mkv` | Native `<video>`, with seeking — the relay answers HTTP `Range` requests. Whether a given codec plays is the browser's call; if it cannot, the window says so instead of showing a dead player |
| `mp3 wav ogg oga opus flac m4a aac weba` | Native `<audio>`, seekable the same way |
| `md markdown` | Rendered (headings, emphasis, code, lists, quotes, simple tables, `http(s)`/`mailto` links); **View raw** and **Edit** |
| `json` | Collapsible, pretty-printed tree; **Expand/Collapse all**, **View raw**, **Edit** |
| `csv tsv` | A table with a sticky header, capped at 1,000 rows (and says so); **View raw**, **Edit** |
| `zip jar tar tar.gz tgz tar.bz2 tbz2 tar.xz txz` | The table of contents, listed **on the server** with `unzip -l` / `tar -tv` (so it needs those installed there). Listing only — nothing is extracted |
| other text | The Editor, as before; a text file too big for it (over 2 MB) opens as a read-only preview of its first 2 MB |
| anything else | Sniffed: text goes to the Editor, binary to a hex + ASCII view of its first 64 KB |

Previews never pull a whole file into the browser: text, Markdown, JSON, CSV and
hex read at most 2 MB through `GET /api/fs/peek` and say when they stopped;
images, PDF and media stream from the download route and seek by range.

### What the relay remembers about your servers

The list of servers you connect to, what you call them, the tunnels you opened
and the windows you had open live in a file on the **relay host**, not in one
browser:

```
~/.config/su-ssh/profiles.json        (or $XDG_CONFIG_HOME/su-ssh/profiles.json)
```

Directory `0700`, file `0600`, written with the same write-then-rename as the
host-key pin file so a crash cannot leave half a JSON document. The path is
printed in the start-up banner. The relay process is the one thing two browsers
share, so this is what makes "I set it up in Chrome and Firefox had never heard
of it" stop happening — and being a file, it also survives a relay restart and a
reboot.

One profile per `user@host:port`:

| Stored | Not stored |
|---|---|
| host, port, username, auth **method** | password, private key, key passphrase |
| label, colour, environment tag, pinned | sudo password, session token |
| connection count, last connected | anything typed into a terminal or editor |
| saved port forwards (the spec, not traffic) | file contents, scrollback, command output |
| saved window layout, restore preference | |

The "not stored" column is enforced, not merely intended: every write goes
through an allowlist sanitiser in `server/profiles.js` that builds the stored
object field by field and copies nothing else, so a client that posts a password
has it dropped rather than written. See **Security** below.

The API is `GET /api/profiles` plus `POST /api/profiles/{update,forget,migrate}`
and `POST /api/profiles/forwards/forget`, all behind the same access cookie and
Host/Origin guard as everything else under `/api`. Whatever an older build left
in `localStorage` is imported once, on first load, and then removed from the
browser.

**Port forwards.** Opening a forward saves it against that server; the next
connect reopens it automatically and reports each one separately, so a tunnel
whose port has since been taken is named without costing you the session.
Closing a forward by hand un-saves it, and the Ports app lists what is saved
with a button to forget each one. Disconnecting does not un-save anything —
that is the whole point.

**Windows.** What was open, where, minimised or maximised, in which z-order, and
what each window was showing, per server. The first time there is something
worth restoring you are asked once, with **Reopen them** as the default action;
the answer is remembered per server and is changeable from the connection's name
dialog (`yes` / `no` / `ask`) or from the "Don't reopen next time" button on the
restore notice.

### Terminals: a refresh does not bring them back, a reconnect does

A terminal is a view onto a PTY on the far side, and that PTY dies with the
WebSocket, which a page reload guarantees. Re-opening the window would start a
*different* shell — new PID, no history, no `cd`, no half-typed command, none of
what was on the screen. For an audience whose expensive mistake is "my command
went somewhere", a terminal that silently is not the terminal you left is worse
than no terminal. So **a refresh** still says how many terminals ended and offers
a fresh one in the directory the old one was opened at.

**A reconnect is different**: the whole SSH session is new, and you asked for the
screen you left. So terminals are reopened in their old working directory — and
marked as new shells in three places at once, because none of the reasoning above
stops applying:

- a yellow banner drawn into the terminal *before* the shell's first prompt,
  saying in as many words that this is a new shell with no scrollback, no
  history and nothing still running, and naming the directory it reopened in;
- `Terminal — new shell` in the window's title bar, permanently;
- the restore notice on the desktop.

The banner is the top of an empty scrollback, so it cannot be scrolled past, and
the usual `clear` after `cd` is suppressed so nothing can erase it.

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

- **Passphrase.** The first visit chooses one; every browser after that has to
  enter it. **Setup is accepted only from the relay machine itself**: the
  socket's peer address must be loopback (headers are never trusted to grant
  it, and a request carrying `X-Forwarded-For`/`Forwarded`/`X-Real-IP` is
  refused), so whoever reaches an unconfigured relay over the network cannot
  pick it. Minimum 8 characters, no other rules.
  - *What is stored:* `~/.config/su-ssh/auth.json` (`$XDG_CONFIG_HOME` honoured,
    `SU_SSH_AUTH_FILE` overrides), directory 0700, file 0600, written
    atomically. It holds a salted **scrypt** hash (N=2^17, r=8, p=1, 16-byte
    salt; parameters recorded in the file, so they can be raised and old hashes
    are upgraded on the next unlock) and a random 256-bit cookie-signing key.
    Never the passphrase, nothing reversible to it. A corrupt file is an error,
    never "no passphrase".
  - *The cookie:* `v1.<expiry>.<HMAC-SHA256>`, `httpOnly; SameSite=Strict`,
    `Secure` under TLS. Because the key is on disk it survives restarts and
    reboots. "Remember this browser" (default) lasts 30 days; unticked, it is a
    browser-session cookie the relay also refuses after 12 hours. The expiry is
    inside the signature.
  - *Guessing:* unlock attempts are rate limited per address (3 free failures,
    then 5 s, 10 s, 20 s … up to 15 min), shown as a countdown.
  - *Change:* "Change passphrase" under the connect form needs the current one
    and rotates the signing key: every other browser is signed out and open
    terminal/log sockets are closed.
  - *Forgot it:* on the relay machine run `su-ssh --reset-passphrase` (deletes
    `auth.json`, signing everyone out). The next visit from that machine shows
    setup again. Recovery needs a shell there, deliberately never a button.
  - `--no-auth` / `NO_ACCESS_KEY=1` turns this off for setups where a reverse
    proxy authenticates users instead. A reverse proxy on the same host makes
    every visitor look local, so choose the passphrase before exposing it.
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
- **Connection profiles hold nothing secret.** `~/.config/su-ssh/profiles.json`
  (0600, in a 0700 directory) remembers where you connect, as whom, by which
  auth *method*, what you named it, which tunnels to reopen and which windows
  were open. It never holds a password, a private key, a key passphrase, a sudo
  password or a session token, and that is enforced rather than assumed: every
  write is rebuilt field by field from an allowlist in `server/profiles.js`, so
  a client that posts a credential has it dropped instead of stored. The
  profile routes need the access cookie and an allowed Host/Origin like the
  rest of `/api`; ids and forward specs coming from the browser are re-parsed
  and re-derived before they are used as keys or opened as listeners. A corrupt
  file is a loud error naming the path, never a silent "you have no servers"
  that would quietly discard what you configured.

**Not in place — know these before you expose it**

- **Plain HTTP unless you configure TLS.** Credentials are posted in the clear
  without `--tls-cert`/`--tls-key` or a TLS-terminating proxy in front.
- **Audit logging.** Connections, forwards, systemd actions and refusals are
  logged; individual file operations are not.
- **Multi-user separation.** Anyone who knows the passphrase has the whole relay:
  there are no accounts, roles or per-session ownership.
- **Rate limiting is per address and in memory.** Behind a reverse proxy every
  request appears to come from the proxy, so the limiter becomes global; counters
  reset when the relay restarts.

The session token is kept in `sessionStorage` so a refresh does not log you out.
That is a prototype convenience — any script on this origin can read it. The
access cookie above is `httpOnly`, so the page cannot read *that*.

Window layout is kept alongside it in `sessionStorage`, keyed by session token,
for the refresh path only: which app, its rectangle, and the path, unit or tab it
was showing. No file contents, no scrollback and no buffers — the same origin
caveat applies, so nothing worth stealing is written there.

The *durable* copy of that layout, and everything else about a server, is on the
relay in `~/.config/su-ssh/profiles.json` — see **What the relay remembers about
your servers** above. Browser storage now holds only the per-tab session tokens,
the forwards queued on the login screen before a session exists, and two
one-shot "you have seen this hint" flags.

### Viewing files safely

Viewer content is served from the app's own origin, so a remote `.html` — or an
`.svg`, which is a document that can carry `<script>` — rendered as a page would
run *as su-ssh*: it could call `/api/*` with your cookie and drive every
connected server. The download route (`server/inline-policy.js`) is built so
that cannot happen:

- **Every** response from `/api/fs/download`, inline or not, carries
  `Content-Security-Policy: sandbox` (no `allow-scripts`, no `allow-same-origin`
  — an opaque, script-less origin) and `X-Content-Type-Options: nosniff`.
- The `Content-Type` comes from an **allowlist** (images, PDF, audio/video, and
  plain text as `text/plain`). Anything not on it — HTML, XHTML, XML, unknown
  types — is sent as `application/octet-stream` with `Content-Disposition:
  attachment`, which a browser saves and never renders. A plain Download is
  always `octet-stream` + `attachment`.
- **SVG is shown only through `<img>`**, which never executes script. The relay
  serves `image/svg+xml` only when the browser says it is loading an image
  (`Sec-Fetch-Dest: image`); requested as a document, iframe, object or embed it
  is an attachment. (A browser that sends no `Sec-Fetch-Dest` simply sees SVG as
  a download.)
- **PDF and the sandbox.** Chromium will not start its PDF viewer inside an
  iframe that has a `sandbox` *attribute* — any token set, even
  `allow-same-origin`, gives a broken-page glyph. It does render a PDF whose
  *response* carries `Content-Security-Policy: sandbox`. So the sandbox is
  applied by the relay on the response, the PDF iframe has no attribute, and the
  only URL it ever loads is the inline route, which answers `application/pdf`
  for a `.pdf` and nothing renderable for anything else. An HTML file renamed
  `.pdf` is served as `application/pdf` + `nosniff`, and the PDF viewer just
  reports that it failed to load.
- **Rendered Markdown, JSON, CSV, archive listings and hex are built with DOM
  APIs** — text nodes and `textContent`, never `innerHTML` of file content.
  Raw HTML in Markdown is shown as the characters it is; links are kept only for
  `http(s)` and `mailto`; images referenced from Markdown are not fetched.
- Archive listing runs `unzip -l` / `tar -tv` on the server with the resolved
  path single-quoted (`q()`, as `services.js` does), a fixed command chosen by
  file suffix, output capped at 5,000 entries and a 30-second `timeout` where
  the host has one.

This is tested, not assumed: an HTML file and an SVG with `<script>` and
`onload=`, each of which sets a flag on `top` and calls `/api/session`, are
opened every way the UI allows (double-click, Open with Viewer, desktop icon,
the image viewer) and loaded directly by URL as a top-level page, an iframe, an
`<object>` and an `<embed>`, and neither signal ever appears — while the same
file injected the unsafe way (a same-origin `srcdoc` iframe) trips both, so the
detector is known to work.

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
