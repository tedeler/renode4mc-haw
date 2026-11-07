#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test für Example 2 (Pendeldisplay) mit echter Renode-Instanz und der Firmware
 * aus examples/example04_pendeldisplay. Prüft Upload, UART, Sensor und das Bild auf dem Pendel:
 * Für jede der 40 Bildspalten muss in BEIDEN Schwungrichtungen an der richtigen Stelle des
 * Schwenkbereichs das richtige Muster aus dem Zeichensatz leuchten.
 *
 *   node test/e2e_example2.js <example04_pendeldisplay.out> [http://localhost:3000]
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
  console.error('Aufruf: node test/e2e_example2.js <example04_pendeldisplay.out> [http://localhost:3000]');
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

// Zeichensatz und Bildaufbau wie in examples/example04_pendeldisplay/main.c
const FONT = {
  0: [0x3e, 0x51, 0x49, 0x45, 0x3e], 1: [0x00, 0x42, 0x7f, 0x40, 0x00], 2: [0x42, 0x61, 0x51, 0x49, 0x46],
  3: [0x21, 0x41, 0x45, 0x4b, 0x31], 4: [0x18, 0x14, 0x12, 0x7f, 0x10], 5: [0x27, 0x45, 0x45, 0x45, 0x39],
  6: [0x3c, 0x4a, 0x49, 0x49, 0x30], 7: [0x01, 0x71, 0x09, 0x05, 0x03], 8: [0x36, 0x49, 0x49, 0x49, 0x36],
  9: [0x06, 0x49, 0x49, 0x29, 0x1e], C: [0x3e, 0x41, 0x41, 0x41, 0x22], M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
};
const SPALTEN = 40;
const XMAX = 0.9;

function expectedColumns(text) {
  const cols = new Array(SPALTEN).fill(0);
  let x = Math.floor((SPALTEN - (text.length * 6 - 1)) / 2);
  for (const ch of text) {
    for (const b of FONT[ch]) cols[x++] = b;
    x++;
  }
  return cols;
}

/** Vergleicht je Bildspalte die Mitte ihres Bereichs mit dem Pendelbild (beide Richtungen). */
function compare(pd, text) {
  const exp = expectedColumns(text);
  const n = pd.columns;
  let ok = 0;
  const bad = [];
  for (let k = 0; k < SPALTEN; k++) {
    const xMid = -XMAX + (2 * XMAX * (k + 0.5)) / SPALTEN;
    const bin = Math.floor(((xMid + 1) / 2) * n);
    const good = pd.lr[bin] === exp[k] && pd.rl[bin] === exp[k];
    if (good) ok++;
    else bad.push(`${k}: soll ${exp[k].toString(16)} ist ${pd.lr[bin].toString(16)}/${pd.rl[bin].toString(16)}`);
  }
  return { ok, bad };
}

(async () => {
  // 1. Upload
  const fd = new FormData();
  fd.append('experiment_id', 'example2');
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const t0 = Date.now();
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check('POST /upload -> 200', res.status === 200, `${Date.now() - t0} ms ${body.error || ''}`);
  if (res.status !== 200) process.exit(1);
  check('Versuch hat ein Pendeldisplay', !!(body.experiment && body.experiment.pendulum));

  // 2. WebSockets
  let uart = '';
  let pd = null;
  const phases = [];
  const events = []; // [t, phi, leds, periodUs] aus "pdev", in Empfangsreihenfolge
  const errors = [];
  const u = new WebSocket(`ws://${host}:3333`);
  u.on('message', (d) => (uart += d.toString()));
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const p = m.type === 'pd' ? m : m.type === 'hello' ? m.pd : null;
    if (p) {
      const bin = Buffer.from(p.data, 'base64');
      pd = {
        columns: p.columns, periodUs: p.periodUs, phase: p.phase, leds: p.leds,
        lr: bin.subarray(0, p.columns), rl: bin.subarray(p.columns),
      };
      phases.push(p.phase);
    }
    if (m.type === 'pdev') events.push(...m.ev, m.now);
    if (m.type === 'error') errors.push(m.message);
  });
  await Promise.all([u, c].map((ws) => new Promise((r) => ws.once('open', r))));
  const send = (m) => c.send(JSON.stringify(m));

  check('UART: Startmeldung', await waitFor(() => /Example 04 Pendeldisplay/.test(uart)));
  check('UART: Pendelperiode 100,0 ms gemessen', await waitFor(() => /Pendelperiode: 100,0 ms/.test(uart)));

  async function checkImage(text, what) {
    let r = { ok: 0, bad: [] };
    await waitFor(() => {
      if (pd) r = compare(pd, text);
      return r.ok === SPALTEN;
    }, 4000);
    check(`Pendel zeigt "${text}" in beiden Schwungrichtungen${what}`, r.ok >= SPALTEN - 1,
      `${r.ok}/${SPALTEN} Spalten${r.bad.length ? `; ${r.bad.slice(0, 3).join(', ')}` : ''}`);
  }

  for (const cm of [42, 123, 7]) {
    send({ type: 'sensor', value: cm });
    check(`Sensor ${cm} cm -> UART`, await waitFor(() => new RegExp(`Abstand: ${cm} cm`).test(uart)));
    await checkImage(`${cm}CM`, '');
  }

  // Pendelfrequenz verstellen: Modell übernimmt sie, Firmware misst sie nach, Bild bleibt richtig
  check('Frame enthält Phase (0..19999) und LED-Zustand', await waitFor(() => phases.length > 5, 3000) &&
    phases.every((x) => Number.isInteger(x) && x >= 0 && x < 20000) && new Set(phases).size > 3 &&
    Number.isInteger(pd.leds), `${phases.length} Frames`);

  // gemeldete Periode in ms (Komma), Toleranz 0,1 ms (Messung über eine halbe Schwingung)
  const reported = (text) => (text.match(/Pendelperiode: ([\d,]+) ms/g) || [])
    .map((m) => Number(m.replace(/[^\d,]/g, '').replace(',', '.')));
  // Ereignisse für die Wiedergabe: Zeit steigt, Phase passt zur Zeit, LED-Wechsel kommen an
  events.length = 0;
  await sleep(1500);
  {
    let mono = true;
    let maxErr = 0;
    for (let i = 1; i < events.length; i++) {
      const [t0, p0, , per0] = events[i - 1];
      const [t1, p1, , per1] = events[i];
      if (t1 < t0) mono = false;
      if (per0 === per1) maxErr = Math.max(maxErr, Math.abs((p1 - p0) / 10000 - (2 * (t1 - t0)) / per0));
    }
    const changes = new Set(events.map((e) => e[2])).size;
    check('Pendel-Ereignisse: Zeit monoton, Phase passt zur Zeit, LED-Wechsel vorhanden',
      events.length > 50 && mono && maxErr < 0.001 && changes > 5,
      `${events.length} Ereignisse, max. Phasenfehler ${maxErr.toFixed(5)}`);
  }

  for (const [hz, ms] of [[15, '66,7'], [1, '1000,0'], [20, '50,0'], [10, '100,0']]) {
    const mark = uart.length;
    send({ type: 'pendulum', frequency: hz });
    check(`Frequenz ${hz} Hz -> Modell`, await waitFor(() => pd && Math.abs(1e6 / pd.periodUs - hz) < 0.01, 3000),
      pd ? `${(1e6 / pd.periodUs).toFixed(2)} Hz` : '');
    check(`Frequenz ${hz} Hz -> Firmware misst ${ms} ms`,
      await waitFor(() => reported(uart.slice(mark)).some((v) => Math.abs(v - Number(ms.replace(',', '.'))) <= 0.1001), 5000),
      (uart.slice(mark).match(/Pendelperiode: [\d,]+ ms/g) || []).join(' | '));
    await sleep(Math.max(1000, 2500 / hz)); // Bild ein paar Schwünge lang mit der neuen Periode zeichnen lassen
    await checkImage('7CM', ` bei ${hz} Hz`);
  }

  check('keine Fehlermeldungen vom Backend', errors.length === 0, errors.join('; '));

  u.close();
  c.close();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
