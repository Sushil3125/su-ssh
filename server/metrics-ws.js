/**
 * metrics-ws.js — live CPU / memory / disk / latency for the top bar.
 *
 * Shape of this, and why:
 *
 * · One long-lived remote sampler loop on a single SSH channel, not an exec
 *   per tick. Opening a channel every two seconds for the life of a session is
 *   a lot of handshakes for four numbers.
 * · Everything is read from /proc and `df`. No top, no vmstat, no iostat —
 *   those are display formats that differ between distros and versions, and
 *   sysstat is not installed on a default Ubuntu server anyway.
 * · Deltas are computed here, from the *remote* clock. CPU percent and disk
 *   busy percent are both "counter delta ÷ time delta", and using the relay's
 *   clock for the divisor would fold network jitter into the reading.
 *
 * Latency is reported as two legs that add up to what the user actually feels:
 * the browser↔relay round trip, measured on this socket, and the relay↔server
 * round trip, measured by bouncing a byte off a remote `cat`.
 */

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 10;
const ECHO_TIMEOUT_MS = 8000;

/**
 * The remote sampler. Written as one shell loop so it costs a single channel.
 *
 * diskstats is filtered remotely: a machine with 40 snap loop devices would
 * otherwise send 40 useless lines every tick. Field 3 is the device name and
 * field 13 is io_ticks — milliseconds during which I/O was in flight, which is
 * exactly what iostat turns into %util.
 */
function samplerScript(interval) {
  return [
    'while :; do',
    '  echo "::t::$(date +%s%3N 2>/dev/null || date +%s000)";',
    '  echo "::cpu::"; head -1 /proc/stat 2>/dev/null;',
    '  echo "::load::"; cat /proc/loadavg 2>/dev/null;',
    '  echo "::cores::"; nproc 2>/dev/null || echo 1;',
    '  echo "::mem::"; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null;',
    '  echo "::df::"; df -PBK / 2>/dev/null | tail -1;',
    '  echo "::io::"; awk \'$3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|mmcblk[0-9]+|hd[a-z]+)$/ {print $3, $13}\' /proc/diskstats 2>/dev/null;',
    '  echo "::end::";',
    `  sleep ${interval};`,
    'done',
  ].join(' ');
}

export function metricsRoute(ws, session, url) {
  const interval = Math.min(Math.max(Number(url.searchParams.get('interval')) || 2, MIN_INTERVAL), MAX_INTERVAL);

  let sampler = null;
  let echo = null;
  let closed = false;
  let previous = null;

  /* ------------------------------------------------------- ssh round trip */

  const pending = new Map();
  let echoSeq = 0;
  let echoBuffer = '';
  let sshLatency = null;

  function measureSsh() {
    if (!echo || closed) return;
    const id = ++echoSeq;
    // hrtime, not Date.now: on a LAN or a loopback tunnel this round trip is
    // routinely under a millisecond, and a millisecond-resolution clock would
    // report every one of them as zero.
    pending.set(id, process.hrtime.bigint());
    // Anything older than a sample or two is a lost probe, not a slow one.
    for (const [key, sent] of pending) {
      if (Number(process.hrtime.bigint() - sent) / 1e6 > ECHO_TIMEOUT_MS) pending.delete(key);
    }
    try { echo.write(`${id}\n`); } catch { /* channel gone; the close handler cleans up */ }
  }

  function onEchoData(chunk) {
    echoBuffer += chunk.toString('utf8');
    const parts = echoBuffer.split('\n');
    echoBuffer = parts.pop();
    for (const part of parts) {
      const id = Number(part.trim());
      const sent = pending.get(id);
      if (!sent) continue;
      pending.delete(id);
      sshLatency = Math.round(Number(process.hrtime.bigint() - sent) / 1e5) / 10;
    }
  }

  /* --------------------------------------------------------- the sampler */

  let buffer = '';

  function onSample(chunk) {
    buffer += chunk.toString('utf8').replace(/\r/g, '');
    let at;
    while ((at = buffer.indexOf('::end::')) !== -1) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + '::end::'.length);
      emit(parseBlock(block));
    }
    // A runaway remote (wrong shell, no /proc) must not grow this forever.
    if (buffer.length > 65536) buffer = buffer.slice(-4096);
  }

  function emit(sample) {
    if (!sample || closed || ws.readyState !== ws.OPEN) return;

    const payload = {
      type: 'sample',
      at: Date.now(),
      interval,
      cores: sample.cores,
      load: sample.load,
      memory: sample.memory,
      disk: sample.disk,
      cpu: null,
      io: null,
      sshLatencyMs: sshLatency,
    };

    if (previous && sample.time > previous.time) {
      const elapsedMs = sample.time - previous.time;
      payload.cpu = cpuUsage(previous.cpu, sample.cpu);
      payload.io = ioUsage(previous.io, sample.io, elapsedMs);
      payload.elapsedMs = elapsedMs;
    }

    previous = sample;
    ws.send(JSON.stringify(payload));
    measureSsh();
  }

  /* ---------------------------------------------------------- lifecycle */

  (async () => {
    try {
      // PTY on the sampler so closing the channel hangs it up: OpenSSH ignores
      // signal requests, and a `while :; do` loop would otherwise outlive the
      // browser tab that asked for it.
      sampler = await session.execStream(samplerScript(interval), { pty: true });
      sampler.on('data', onSample);
      sampler.on('close', () => { if (!closed) ws.close(); });

      // `cat` echoes whatever it is given, so a byte written here comes back
      // one full SSH round trip later. No PTY: a PTY would echo it locally on
      // the remote side and report a latency of roughly zero.
      echo = await session.execStream('cat', { pty: false });
      echo.on('data', onEchoData);

      ws.send(JSON.stringify({ type: 'ready', interval }));
      measureSsh();
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: `Could not start the system monitor: ${err.message}` }));
      ws.close();
    }
  })();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    // Echoed straight back so the browser can time the leg it owns; the relay
    // never needs to know what the timestamp means.
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
  });

  ws.on('close', () => {
    closed = true;
    for (const stream of [sampler, echo]) {
      try { stream?.close?.() ?? stream?.end?.(); } catch { /* already gone */ }
    }
  });
}

/* ------------------------------------------------------------- parsing */

function parseBlock(block) {
  const sections = {};
  let key = null;
  for (const line of block.split('\n')) {
    const marker = line.match(/^::(\w+)::(.*)$/);
    if (marker) {
      key = marker[1];
      sections[key] = marker[2].trim() ? [marker[2].trim()] : [];
      continue;
    }
    if (key && line.trim()) sections[key].push(line.trim());
  }

  const time = Number(sections.t?.[0]);
  if (!Number.isFinite(time)) return null;

  return {
    time,
    cores: Number(sections.cores?.[0]) || null,
    load: parseLoad(sections.load?.[0]),
    cpu: parseCpu(sections.cpu?.[0]),
    memory: parseMemory(sections.mem || []),
    disk: parseDf(sections.df?.[0]),
    io: parseIo(sections.io || []),
  };
}

function parseLoad(line) {
  if (!line) return null;
  const [one, five, fifteen] = line.split(/\s+/).map(Number);
  return Number.isFinite(one) ? { one, five, fifteen } : null;
}

/** cpu  user nice system idle iowait irq softirq steal guest guest_nice */
function parseCpu(line) {
  if (!line || !line.startsWith('cpu')) return null;
  const fields = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (fields.length < 5) return null;
  return {
    total: fields.reduce((a, b) => a + b, 0),
    idle: fields[3],
    iowait: fields[4],
    steal: fields[7] || 0,
  };
}

function cpuUsage(before, after) {
  if (!before || !after) return null;
  const total = after.total - before.total;
  if (total <= 0) return null;

  // idle + iowait is the conventional "not doing work" pair; iowait is also
  // reported on its own, because a box at 3% CPU and 40% iowait is not idle in
  // any sense the person watching cares about.
  const idle = (after.idle - before.idle) + (after.iowait - before.iowait);
  return {
    usedPct: clampPct(((total - idle) / total) * 100),
    iowaitPct: clampPct(((after.iowait - before.iowait) / total) * 100),
    stealPct: clampPct(((after.steal - before.steal) / total) * 100),
  };
}

function parseMemory(lines) {
  const values = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) values[m[1]] = Number(m[2]) * 1024;   // /proc/meminfo is in kB
  }
  if (!values.MemTotal) return null;

  // MemAvailable is the kernel's own estimate and is far better than
  // free+buffers+cached, which counts reclaimable slab as used. It exists on
  // every kernel since 3.14, but fall back rather than show nothing.
  const available = values.MemAvailable ?? (values.MemFree + (values.Buffers || 0) + (values.Cached || 0));
  const used = values.MemTotal - available;

  return {
    total: values.MemTotal,
    available,
    used,
    usedPct: clampPct((used / values.MemTotal) * 100),
    swapTotal: values.SwapTotal || 0,
    swapUsed: (values.SwapTotal || 0) - (values.SwapFree || 0),
  };
}

/** `df -PBK /` → Filesystem 1K-blocks Used Available Capacity Mounted-on */
function parseDf(line) {
  if (!line) return null;
  const cols = line.split(/\s+/);
  if (cols.length < 6) return null;
  const size = Number(String(cols[1]).replace(/K$/, '')) * 1024;
  const used = Number(String(cols[2]).replace(/K$/, '')) * 1024;
  const free = Number(String(cols[3]).replace(/K$/, '')) * 1024;
  if (!Number.isFinite(size) || size <= 0) return null;

  // df's own Capacity column, not used/size. They differ: ext4 reserves 5% of
  // the filesystem for root, and df excludes those blocks from the denominator.
  // Reporting 15% where `df -h` on the same box says 17% is the kind of small
  // discrepancy that costs someone an afternoon.
  const capacity = Number(String(cols[4]).replace('%', ''));
  const usedPct = Number.isFinite(capacity) ? capacity : (used / (used + free)) * 100;

  return {
    filesystem: cols[0],
    mount: cols[cols.length - 1],
    size, used, free,
    usedPct: clampPct(usedPct),
  };
}

function parseIo(lines) {
  const devices = {};
  for (const line of lines) {
    const [name, ticks] = line.split(/\s+/);
    const value = Number(ticks);
    if (name && Number.isFinite(value)) devices[name] = value;
  }
  return Object.keys(devices).length ? devices : null;
}

/**
 * Disk busy time, the number `iostat -x` calls %util: the share of the interval
 * during which at least one request was in flight. Not throughput — a disk can
 * sit at 100% busy while moving very little, which is precisely the state worth
 * seeing in a top bar.
 */
function ioUsage(before, after, elapsedMs) {
  if (!before || !after || elapsedMs <= 0) return null;

  let busiest = null;
  const devices = [];
  for (const [name, ticks] of Object.entries(after)) {
    if (!(name in before)) continue;
    const busyPct = clampPct(((ticks - before[name]) / elapsedMs) * 100);
    devices.push({ name, busyPct });
    if (!busiest || busyPct > busiest.busyPct) busiest = { name, busyPct };
  }
  if (!busiest) return null;
  return { busiest: busiest.name, busyPct: busiest.busyPct, devices };
}

const clampPct = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : null);
