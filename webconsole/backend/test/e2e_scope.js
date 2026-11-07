#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test des Oszilloskops (sim/models/Oscilloscope.cs, Backend-Nachricht "scope") mit echter
 * Renode-Instanz und den Musterlösungen:
 *   Lab 2 (lab02_led_pendel): PL0 Periode 120 ms, HC-SR04-Trigger PD0 >= 10 us, Echo PD1 450 us nach
 *         der fallenden Trigger-Flanke, Länge 58,3 us/cm; offener Pin PB0 = 2
 *   Lab 4 (lab04_uart_leds): SW1 loslassen -> UART-Rahmen auf PA1, 9600 Bit/s 7N1, Zeichen '#'
 *   Quellen zweier Browser werden vereinigt; ohne Quellen kommen keine Daten.
 *
 *   node test/e2e_scope.js <Verzeichnis mit lab02_led_pendel.elf und lab04_uart_leds.elf> [http://localhost:3000]
 *   (z. B. sim/solutions nach tools/build-solutions.sh)
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const dir = process.argv[2];
const base = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
if (!dir || !fs.existsSync(dir)) {
  console.error('Aufruf: node test/e2e_scope.js <Verzeichnis mit lab02_led_pendel.elf, lab04_uart_leds.elf> [URL]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

async function start(experiment, elf) {
  const fd = new FormData();
  fd.append('experiment_id', experiment);
  fd.append('file', new Blob([fs.readFileSync(path.join(dir, elf))]), elf);
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check(`${experiment}: Start mit ${elf}`, res.status === 200, body.error || '');
  if (res.status !== 200) throw new Error(body.error);
}

/** Control-WebSocket, sammelt die Pegelwechsel je Pin: edges[pin] = [[t ns, Pegel], ...] */
async function client() {
  const c = { edges: {}, levels: {}, msgs: 0, errors: [] };
  c.ws = new WebSocket(`ws://${host}:3334`);
  c.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'error') c.errors.push(m.message);
    if (m.type !== 'scope') return;
    c.msgs++;
    let t = 0;
    for (let k = 0; k + 2 < m.ev.length; k += 3) {
      t += m.ev[k + 1];
      const pin = m.pins[m.ev[k]];
      (c.edges[pin] = c.edges[pin] || []).push([t, m.ev[k + 2]]);
    }
    m.pins.forEach((p, i) => (c.levels[p] = m.levels[i]));
  });
  await new Promise((r) => c.ws.once('open', r));
  c.sources = (s) => c.ws.send(JSON.stringify({ type: 'scope', sources: s }));
  return c;
}

/** Pulse (HIGH-Phasen) eines Pins: [[Beginn, Dauer], ...] in us */
function pulses(edges) {
  const out = [];
  for (let i = 0; i + 1 < (edges || []).length; i++) {
    if (edges[i][1] === 1 && edges[i + 1][1] === 0) out.push([edges[i][0] / 1000, (edges[i + 1][0] - edges[i][0]) / 1000]);
  }
  return out;
}

async function lab2() {
  console.log('\n== Lab 2: Pendel und HC-SR04 ==');
  await start('lab2_pendel', 'lab02_led_pendel.elf');
  const a = await client();
  const b = await client();
  await sleep(1500);
  a.sources(['PL0', 'PD0', 'PD1']);
  b.sources(['PB0']);
  const ok = async () => {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      if ((a.edges.PL0 || []).length >= 6 && pulses(a.edges.PD1).length >= 2) return true;
      await sleep(200);
    }
    return false;
  };
  check('Pegelwechsel an PL0/PD0/PD1 kommen an', await ok(), `${a.msgs} Nachrichten`);
  const rises = (a.edges.PL0 || []).filter((e) => e[1] === 1).map((e) => e[0]);
  const periods = rises.slice(1).map((t, i) => (t - rises[i]) / 1e6);
  check('PL0: Periode 120 ms', periods.length > 0 && periods.every((p) => Math.abs(p - 120) < 0.05), periods.map((p) => p.toFixed(3)).join(', '));
  const trig = pulses(a.edges.PD0);
  check('PD0: Trigger-Puls >= 10 us', trig.length > 0 && trig.every(([, w]) => w >= 10 && w < 100), trig.map(([, w]) => w).join(', '));
  const echo = pulses(a.edges.PD1);
  check('PD1: Echo 65 cm = 3790 us', echo.length > 0 && echo.every(([, w]) => Math.abs(w - 3790) <= 2), echo.map(([, w]) => w).join(', '));
  const falls = (a.edges.PD0 || []).filter((e) => e[1] === 0).map((e) => e[0] / 1000);
  const delays = echo.map(([t]) => t - Math.max(...falls.filter((f) => f <= t)));
  check('PD1: Echo 450 us nach fallender Trigger-Flanke', delays.every((d) => Math.abs(d - 450) <= 12), delays.join(', '));
  check('Browser A bekommt auch PB0 (Vereinigung), Pegel offen = 2', a.levels.PB0 === 2 && b.levels.PB0 === 2, `A ${a.levels.PB0}, B ${b.levels.PB0}`);
  a.sources([]);
  b.sources([]);
  await sleep(500);
  const n = a.msgs + b.msgs;
  await sleep(1000);
  check('ohne Quellen keine Oszilloskop-Daten mehr', a.msgs + b.msgs === n);
  check('keine Fehlermeldungen', !a.errors.length && !b.errors.length, [...a.errors, ...b.errors].join('; '));
  a.ws.close();
  b.ws.close();
}

async function lab4() {
  console.log('\n== Lab 4: UART 9600 7N1 ==');
  await start('lab4_uart', 'lab04_uart_leds.elf');
  const c = await client();
  await sleep(1500);
  c.sources(['PA1', 'PJ0']);
  await sleep(2000);
  check('PA1 (U0TX) Ruhepegel HIGH', c.levels.PA1 === 1, `Pegel ${c.levels.PA1}`);
  c.ws.send(JSON.stringify({ type: 'button', id: 'SW1', pressed: true }));
  await sleep(800);
  c.ws.send(JSON.stringify({ type: 'button', id: 'SW1', pressed: false }));
  const end = Date.now() + 30000;
  while (Date.now() < end && (c.edges.PA1 || []).length < 6) await sleep(200);
  const e = c.edges.PA1 || [];
  const release = ((c.edges.PJ0 || []).filter((x) => x[1] === 1).pop() || [0])[0];
  check('Rahmen beginnt nach dem Loslassen von SW1 (Auflösung 1 us)', e.length > 0 && e[0][0] >= release, `${((e[0]?.[0] - release) / 1000).toFixed(1)} us danach`);
  // erstes Zeichen dekodieren: Bitmitte abtasten
  const bit = 1e9 / 9600;
  const t0 = e.length ? e[0][0] : 0;
  const levelAt = (t) => {
    let l = 1;
    for (const [te, le] of e) if (te <= t) l = le;
    return l;
  };
  const bits = Array.from({ length: 9 }, (_, i) => levelAt(t0 + (i + 0.5) * bit));
  const ch = bits.slice(1, 8).reduce((v, b, i) => v | (b << i), 0);
  check("Startbit, 7 Datenbits = '#', Stoppbit", bits[0] === 0 && ch === 0x23 && bits[8] === 1, `Bits ${bits.join('')}, Zeichen 0x${ch.toString(16)}`);
  c.ws.close();
}

(async () => {
  try {
    await lab2();
    await lab4();
  } catch (e) {
    check('Ablauf', false, e.message);
  }
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})();
