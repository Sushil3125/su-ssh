/**
 * sysmon.js — the live meters in the top bar.
 *
 * The relay does the arithmetic and pushes a finished sample; this file only
 * paints it. That split matters because CPU and disk-busy are both differences
 * between two counter readings, and the browser is the wrong place to hold the
 * previous reading — a backgrounded tab gets its timers throttled to once a
 * minute and would quietly report averages over the wrong window.
 *
 * Latency is shown as one number because that is what a person feels, with the
 * two legs it is made of in the tooltip.
 */

import { formatBytes } from './ui.js';

const PING_EVERY_MS = 2000;
const RECONNECT_MS = 4000;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Sub-millisecond hops are real — a loopback tunnel or a LAN server — so keep a
 * decimal until the number is big enough that the decimal is noise.
 */
const formatMs = (n) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));

/** Green until it matters, amber when it does, red when it is the problem. */
function level(pct) {
  if (pct == null) return 'idle';
  if (pct >= 90) return 'bad';
  if (pct >= 70) return 'warn';
  return 'ok';
}

const METERS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'MEM' },
  { key: 'disk', label: 'DISK' },
  { key: 'io', label: 'I/O' },
  { key: 'ping', label: 'PING', bar: false },
];

/**
 * `api` is the owning session's client, not "the current one": only the active
 * session streams metrics (the spec pauses background ones), and passing the
 * client in is what guarantees the meters and the top bar are describing the
 * same machine.
 */
export function startSystemMonitor(api) {
  const host = document.getElementById('sysmon');
  host.innerHTML = METERS.map((m) => `
    <div class="sysmon__item sysmon__item--${m.key}" data-meter="${m.key}" title="Waiting for the first sample…">
      <span class="sysmon__label">${m.label}</span>
      ${m.bar === false ? '' : '<span class="sysmon__bar"><i></i></span>'}
      <span class="sysmon__value">—</span>
    </div>`).join('');
  host.classList.remove('is-hidden');

  const meter = (key) => host.querySelector(`[data-meter="${key}"]`);

  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let stopped = false;
  let wsLatency = null;

  function set(key, { value, pct, title, tone }) {
    const el = meter(key);
    if (!el) return;
    el.querySelector('.sysmon__value').textContent = value;
    el.title = title;
    const bar = el.querySelector('.sysmon__bar i');
    if (bar) bar.style.width = `${pct == null ? 0 : pct}%`;
    el.dataset.tone = tone || level(pct);
  }

  function blankAll(reason) {
    for (const m of METERS) set(m.key, { value: '—', pct: null, title: reason, tone: 'idle' });
  }

  function render(sample) {
    if (sample.cpu) {
      const extra = [
        sample.load && `load ${sample.load.one.toFixed(2)} ${sample.load.five.toFixed(2)} ${sample.load.fifteen.toFixed(2)}`,
        sample.cores && `${sample.cores} core${sample.cores === 1 ? '' : 's'}`,
        `iowait ${sample.cpu.iowaitPct}%`,
        sample.cpu.stealPct ? `steal ${sample.cpu.stealPct}%` : null,
      ].filter(Boolean).join(' · ');
      set('cpu', { value: `${Math.round(sample.cpu.usedPct)}%`, pct: sample.cpu.usedPct, title: `CPU ${sample.cpu.usedPct}% — ${extra}` });
    }

    if (sample.memory) {
      const m = sample.memory;
      const swap = m.swapTotal ? ` · swap ${formatBytes(m.swapUsed)} / ${formatBytes(m.swapTotal)}` : '';
      set('mem', {
        value: `${Math.round(m.usedPct)}%`,
        pct: m.usedPct,
        title: `Memory ${formatBytes(m.used)} used of ${formatBytes(m.total)}, ${formatBytes(m.available)} available${swap}`,
      });
    }

    if (sample.disk) {
      const d = sample.disk;
      set('disk', {
        value: `${Math.round(d.usedPct)}%`,
        pct: d.usedPct,
        title: `${d.mount} on ${d.filesystem} — ${formatBytes(d.used)} used of ${formatBytes(d.size)}, ${formatBytes(d.free)} free`,
      });
    }

    if (sample.io) {
      const others = sample.io.devices.map((d) => `${d.name} ${d.busyPct}%`).join(' · ');
      set('io', {
        value: `${Math.round(sample.io.busyPct)}%`,
        pct: sample.io.busyPct,
        title: `Disk active time — ${sample.io.busiest} busy ${sample.io.busyPct}% of the last ${sample.elapsedMs} ms (${others})`,
      });
    }

    renderPing(sample.sshLatencyMs);
  }

  /**
   * Total = browser→relay + relay→server. Either leg can be missing for a tick
   * (a dropped probe), so the display degrades to whichever half it has rather
   * than blinking to a dash.
   */
  function renderPing(sshLatency) {
    const legs = [wsLatency, sshLatency].filter((n) => n != null);
    if (!legs.length) return;

    const total = round1(legs.reduce((a, b) => a + b, 0));
    set('ping', {
      value: `${formatMs(total)} ms`,
      pct: null,
      tone: total >= 400 ? 'bad' : total >= 150 ? 'warn' : 'ok',
      title: `Round trip ${formatMs(total)} ms — browser↔relay ${wsLatency == null ? '?' : formatMs(wsLatency)} ms`
        + ` · relay↔server ${sshLatency == null ? '?' : formatMs(sshLatency)} ms`,
    });
  }

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(api.metricsUrl(2));
    socket = ws;

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'sample') return render(msg);
      if (msg.type === 'pong') { wsLatency = round1(performance.now() - msg.t); return renderPing(null); }
      if (msg.type === 'error') blankAll(msg.message);
    });

    ws.addEventListener('open', () => {
      clearInterval(pingTimer);
      // performance.now() is sub-millisecond and monotonic; Date.now() would
      // round a fast local hop to zero and jump if the system clock is set.
      const ping = () => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping', t: performance.now() })); };
      ping();
      pingTimer = setInterval(ping, PING_EVERY_MS);
    });

    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      if (stopped || socket !== ws) return;
      blankAll('Reconnecting to the system monitor…');
      // The relay may simply have been restarted; keep trying quietly rather
      // than leaving four dashes in the top bar with no explanation.
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  }

  connect();

  return function stop() {
    stopped = true;
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    try { socket?.close(); } catch { /* already closed */ }
    host.classList.add('is-hidden');
    host.innerHTML = '';
  };
}
