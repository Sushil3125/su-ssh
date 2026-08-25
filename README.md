# WebSSH Ubuntu Desktop — v0.1.0 (2026-08-20)

A browser-based Ubuntu-style desktop for a remote server. Every file, folder and
keystroke you see is read live over SSH. Nothing is mirrored, synced or cached
on the machine running this relay.

Single-user prototype. Read **Security** before putting it anywhere public.

---

## Run it

```bash
npm install
npm start
# → http://127.0.0.1:3000
```

Open the URL, enter a host, username and credentials, and connect.

| Variable    | Default     | Purpose |
|-------------|-------------|---------|
| `PORT`      | `3000`      | Relay HTTP port |
| `BIND`      | `127.0.0.1` | Bind address. Localhost by default, on purpose |
| `ROOT_JAIL` | *(unset)*   | Confine all file operations to this path |

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
```

---

## What works

- Desktop icons read from `~/Desktop`, falling back to `$HOME` on a headless box
- File manager: navigate, back/forward/up/home, type a path, right-click menu
- Create folders, rename, recursive delete, download, drag-and-drop upload
- Text editor with `Ctrl-S`, unsaved-changes guard, binary-file detection
- Full interactive terminal with working resize
- Image viewer
- Window manager: drag, resize, focus, minimise, maximise, dock task list
- Session survives a page refresh; `Disconnect` tears everything down
- Responsive below 720px (the dock moves to the bottom)

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

This prototype is honest about its position: it is a shell exposed over HTTP.

**In place**

- Session token required on every API call and on the WebSocket upgrade
- Path jail via `ROOT_JAIL`, with `realpath` resolved *before* the prefix check,
  so `..` traversal and symlink escapes are both closed
- No shell interpolation anywhere in the file layer — SFTP only
- Refuses to delete `/` or the home directory
- Binds to localhost by default
- Passwords and keys are cleared from the DOM once the connection is up

**Not in place — needed before this is exposed**

- **TLS.** Credentials are posted in the clear over plain HTTP. Terminate TLS at
  a reverse proxy before anything leaves the machine.
- **Rate limiting** on `/api/connect`. Right now it is an unthrottled brute-force
  oracle against the target's SSH.
- **Session expiry.** Tokens live until the relay restarts or you disconnect.
- **Host key verification.** `ssh2` does not verify the target's host key unless
  you supply `hostVerifier`. As written, this is trust-on-first-use with no
  pinning, so it is vulnerable to an active MITM on the relay-to-server hop.
- **Audit logging.** Only connections are logged, not file operations.
- **CSRF protection.** The token header helps, but add an explicit origin check.

The token is kept in `sessionStorage` so a refresh does not log you out. That is
a prototype convenience — any script on this origin can read it. Move it to an
`httpOnly; Secure; SameSite=Strict` cookie for anything real.

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

## Next, in order

1. **TLS + rate limiting + host key pinning** — before any exposure
2. **CodeMirror 6** in place of the plain `textarea`, for syntax highlighting
3. **App-level users** with their own login, mapped to real Unix accounts
4. **Per-user containers** — this is what makes GUI apps and true isolation
   possible at the same time. Price out Kasm Workspaces before building it.
