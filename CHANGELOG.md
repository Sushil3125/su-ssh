# Changelog — WebSSH Ubuntu Desktop

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
