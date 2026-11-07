#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test für die UART-Leitung als Flanken (Signalstrom fürs Oszilloskop) mit echter
 * Renode-Instanz und der Firmware aus examples/lab03_webkonsole (115200 8N1 bei 16 MHz).
 *
 * Prüft:
 *  - "signals" beschreibt uart0.tx/uart0.rx mit der eingestellten Baudrate des Senders
 *  - "edges": Zeiten in ns, streng steigend, Pegel wechseln sich ab, Bitabstände passen zur Baudrate
 *  - ein eigener Dekoder (hier im Test) liest aus den Flanken dasselbe wie das Terminal
 *  - Tastatureingabe erscheint als Flanken auf uart0.rx (115200, Einstellung des Terminals)
 *  - Terminal auf 9600 Baud gestellt: Zeichensalat; zurück auf 115200: wieder lesbar
 *  - Simulations-Anzeige ("watch"/"sim"): Firmware, CPU, Zeit, UART-Einstellungen
 *  - Reset-Taster: Firmware startet neu (Startmeldung), Sensorwert (außerhalb des Chips) bleibt
 *
 *   node test/e2e_signals.js <lab03_webkonsole.out> [http://localhost:3000]
 *
 * Voraussetzung: Backend läuft (npm start bzw. Docker-Container).
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const elf = process.argv[2];
const base = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
if (!elf || !fs.existsSync(elf)) {
  console.error('Aufruf: node test/e2e_signals.js <lab03_webkonsole.out> [http://localhost:3000]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * UART-Dekoder nur aus Flanken: Startbit = fallende Flanke, Abtastung in der Bitmitte.
 * edges = [[t_ns, level], ...] (nur Pegelwechsel), Ruhepegel 1. Liefert [{ value, framing }].
 */
function decodeUart(edges, baud, format) {
  const bit = 1e9 / baud;
  const nData = Number(format[0]);
  const parity = format[1] !== 'N' ? 1 : 0;
  let k = 0;
  let level = 1;
  const levelAt = (t) => {
    // edges sind zeitlich sortiert, Abfragen auch: Zeiger nur vorwärts
    while (k < edges.length && edges[k][0] <= t) level = edges[k++][1];
    return level;
  };
  const out = [];
  let i = 0;
  while (i < edges.length) {
    if (edges[i][1] !== 0) {
      i++;
      continue;
    }
    const s = edges[i][0];
    if (k > i) {
      k = i;
      level = i > 0 ? edges[i - 1][1] : 1;
    }
    let value = 0;
    for (let b = 0; b < nData; b++) value |= levelAt(s + (1.5 + b) * bit) << b;
    const stop = s + (1 + nData + parity + 0.5) * bit;
    out.push({ value, framing: levelAt(stop) === 0 });
    while (i < edges.length && edges[i][0] <= stop) i++;
  }
  return out;
}

(async () => {
  const signals = {};
  const edges = { 'uart0.tx': [], 'uart0.rx': [] };
  const problems = [];
  let lastNow = {};
  let uartConfig = null;
  const errors = [];
  let sim = null;
  let resets = 0;

  // Control-WebSocket zuerst: Abo und Terminal-Einstellung gelten auch für den folgenden Start
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') uartConfig = m.uartConfig;
    if (m.type === 'uartconfig') uartConfig = { baud: m.baud, format: m.format };
    if (m.type === 'signals') for (const s of m.signals) signals[s.name] = s;
    if (m.type === 'error') errors.push(m.message);
    if (m.type === 'sim') sim = m;
    if (m.type === 'reset') resets++;
    if (m.type === 'edges' && edges[m.name]) {
      const list = edges[m.name];
      let prev = list.length ? list[list.length - 1] : null;
      for (const e of m.edges) {
        if (prev && !(e[0] > prev[0])) problems.push(`${m.name}: Zeit nicht steigend ${prev[0]} -> ${e[0]}`);
        if (prev && e[1] === prev[1]) problems.push(`${m.name}: kein Pegelwechsel bei ${e[0]}`);
        if (e[0] > m.now) problems.push(`${m.name}: Flanke ${e[0]} nach now ${m.now}`);
        list.push(e);
        prev = e;
      }
      if (lastNow[m.name] !== undefined && m.now < lastNow[m.name]) problems.push(`${m.name}: now rückwärts`);
      lastNow[m.name] = m.now;
      if (prev && m.level !== prev[1]) problems.push(`${m.name}: level ${m.level} passt nicht zur letzten Flanke`);
    }
  });
  await new Promise((r) => c.once('open', r));
  const send = (m) => c.send(JSON.stringify(m));
  send({ type: 'uartconfig', baud: 115200, format: '8N1' });
  send({ type: 'subscribe', signals: ['uart0.tx', 'uart0.rx'] });
  check('uartconfig ohne laufendes Renode angenommen', await waitFor(() => uartConfig && uartConfig.baud === 115200));

  // Upload + Start
  const fd = new FormData();
  fd.append('experiment_id', 'versuch1');
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check('POST /upload -> 200', res.status === 200, body.error || '');
  if (res.status !== 200) process.exit(1);

  let uart = Buffer.alloc(0);
  const u = new WebSocket(`ws://${host}:3333`);
  u.on('message', (d) => (uart = Buffer.concat([uart, Buffer.from(d)])));
  await new Promise((r) => u.once('open', r));
  const text = () => uart.toString('latin1');

  check('UART: Startmeldung im Terminal', await waitFor(() => /Lab 03 Web-Konsole/.test(text()), 10000));
  check('signals: uart0.tx mit Baudrate des Senders',
    await waitFor(() => signals['uart0.tx'] && signals['uart0.tx'].protocol &&
      Math.abs(signals['uart0.tx'].protocol.baud - 16e6 / (16 * (8 + 44 / 64))) < 0.01), JSON.stringify(signals['uart0.tx']));
  check('signals: uart0.rx mit Einstellung des Terminals',
    signals['uart0.rx'] && signals['uart0.rx'].protocol && signals['uart0.rx'].protocol.baud === 115200, JSON.stringify(signals['uart0.rx']));

  send({ type: 'sensor', value: 42 });
  check('Sensor 42 cm -> UART', await waitFor(() => /Abstand:\s+42 cm/.test(text())));
  await sleep(500);

  const tx = edges['uart0.tx'];
  const bit = 1e9 / signals['uart0.tx'].protocol.baud;
  let worst = 0;
  for (let i = 1; i < tx.length; i++) {
    const n = (tx[i][0] - tx[i - 1][0]) / bit;
    if (n < 20) worst = Math.max(worst, Math.abs(n - Math.round(n)) * bit);
  }
  check('Flanken: Zeit steigend, Pegel abwechselnd, nicht nach now', problems.length === 0, problems.slice(0, 3).join('; '));
  check(`Flanken: Abstände sind ganze Bitdauern (${bit.toFixed(2)} ns)`, tx.length > 100 && worst <= 1.5,
    `${tx.length} Flanken, größte Abweichung ${worst.toFixed(2)} ns`);
  const decoded = Buffer.from(decodeUart(tx, signals['uart0.tx'].protocol.baud, '8N1').map((f) => f.value)).toString('latin1');
  check('eigener Dekoder liest aus den Flanken die Startmeldung', /Lab 03 Web-Konsole/.test(decoded));
  check('eigener Dekoder: "Abstand: 42 cm"', /Abstand:\s+42 cm/.test(decoded));

  u.send('x');
  check('Tastendruck -> Flanken auf uart0.rx', await waitFor(() => edges['uart0.rx'].length >= 2));
  await sleep(300);
  const rx = decodeUart(edges['uart0.rx'], 115200, '8N1').map((f) => String.fromCharCode(f.value)).join('');
  check('uart0.rx dekodiert = "x"', rx === 'x', JSON.stringify(rx));
  if (edges['uart0.rx'].length) {
    const first = edges['uart0.rx'][0][0];
    const startBits = edges['uart0.rx'].map((e) => (e[0] - first) / (1e9 / 115200));
    check('uart0.rx: Flanken auf dem 115200-Raster', startBits.every((n) => Math.abs(n - Math.round(n)) < 0.001));
  }

  // Terminal falsch einstellen: Zeichensalat statt Text
  send({ type: 'uartconfig', baud: 9600, format: '8N1' });
  check('uartconfig 9600 an alle gemeldet', await waitFor(() => uartConfig && uartConfig.baud === 9600));
  await sleep(300);
  let mark = uart.length;
  send({ type: 'sensor', value: 123 });
  await sleep(1500);
  const wrong = uart.subarray(mark).toString('latin1');
  check('Terminal 9600, MCU 115200: kein lesbarer Text', !/Abstand/.test(wrong), JSON.stringify(wrong.slice(0, 40)));
  check('signals: uart0.rx zeigt jetzt 9600', await waitFor(() => signals['uart0.rx'].protocol.baud === 9600));

  send({ type: 'uartconfig', baud: 115200, format: '8N1' });
  await sleep(500);
  mark = uart.length;
  send({ type: 'sensor', value: 77 });
  check('Terminal wieder 115200: lesbar', await waitFor(() => /Abstand:\s+77 cm/.test(uart.subarray(mark).toString('latin1'))));

  // Simulations-Anzeige
  send({ type: 'watch', sim: true });
  check('sim: Zustand kommt', await waitFor(() => sim && sim.time && sim.cpu, 3000));
  if (sim && sim.cpu) {
    check('sim: Firmware-Name', sim.firmware && sim.firmware.name === path.basename(elf), JSON.stringify(sim.firmware));
    check('sim: CPU läuft, Systemtakt 16 MHz', sim.cpu.state === 'Running' && sim.cpu.sysclk === 16000000, JSON.stringify(sim.cpu));
    check('sim: UART Firmware 8N1 / Terminal 115200', sim.uart && sim.uart.mcu.format === '8N1' && sim.uart.terminal.baud === 115200,
      JSON.stringify(sim.uart));
    const t0 = sim.time.virtualNs;
    check('sim: Simulationszeit läuft', await waitFor(() => sim.time.virtualNs > t0, 3000));
  }

  // Reset-Taster: Firmware neu, Sensor bleibt
  send({ type: 'sensor', value: 55 });
  check('Sensor 55 cm vor dem Reset', await waitFor(() => /Abstand:\s+55 cm/.test(text())));
  mark = uart.length;
  send({ type: 'reset' });
  check('Reset -> Startmeldung erneut', await waitFor(() => /Lab 03 Web-Konsole/.test(uart.subarray(mark).toString('latin1')), 5000));
  check('Reset an alle gemeldet', resets === 1);
  check('nach dem Reset: Sensor weiterhin 55 cm', await waitFor(() => /Abstand:\s+55 cm/.test(uart.subarray(mark).toString('latin1')), 5000));
  check('sim: Reset gezählt', await waitFor(() => sim.resets && sim.resets.count === 1, 3000), JSON.stringify(sim.resets));

  check('keine Fehlermeldungen vom Backend', errors.length === 0, errors.join('; '));
  u.close();
  c.close();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
