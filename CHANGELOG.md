# Changelog — WebSSH Ubuntu Desktop

## Unreleased
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
