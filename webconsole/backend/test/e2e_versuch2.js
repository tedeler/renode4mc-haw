#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test für Versuch 2 (Pendeldisplay) mit echter Renode-Instanz und der Firmware
 * aus examples/lab04_pendeldisplay. Prüft Upload, UART, Sensor und das Bild auf dem Pendel:
 * Für jede der 40 Bildspalten muss in BEIDEN Schwungrichtungen an der richtigen Stelle des
 * Schwenkbereichs das richtige Muster aus dem Zeichensatz leuchten.
 *
 *   node test/e2e_versuch2.js <lab04_pendeldisplay.out> [http://localhost:3000]
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
  console.error('Aufruf: node test/e2e_versuch2.js <lab04_pendeldisplay.out> [http://localhost:3000]');
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

// Zeichensatz und Bildaufbau wie in examples/lab04_pendeldisplay/main.c
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
  fd.append('experiment_id', 'versuch2');
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
  const errors = [];
  const u = new WebSocket(`ws://${host}:3333`);
  u.on('message', (d) => (uart += d.toString()));
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const p = m.type === 'pd' ? m : m.type === 'hello' ? m.pd : null;
    if (p) {
      const bin = Buffer.from(p.data, 'base64');
      pd = { columns: p.columns, lr: bin.subarray(0, p.columns), rl: bin.subarray(p.columns) };
    }
    if (m.type === 'error') errors.push(m.message);
  });
  await Promise.all([u, c].map((ws) => new Promise((r) => ws.once('open', r))));
  const send = (m) => c.send(JSON.stringify(m));

  check('UART: Startmeldung', await waitFor(() => /Lab 04 Pendeldisplay/.test(uart)));
  check('UART: Pendelperiode 100,0 ms gemessen', await waitFor(() => /Pendelperiode: 100,0 ms/.test(uart)));

  for (const cm of [42, 123, 7]) {
    send({ type: 'sensor', value: cm });
    check(`Sensor ${cm} cm -> UART`, await waitFor(() => new RegExp(`Abstand: ${cm} cm`).test(uart)));
    const text = `${cm}CM`;
    let r = { ok: 0, bad: [] };
    await waitFor(() => {
      if (pd) r = compare(pd, text);
      return r.ok === SPALTEN;
    }, 4000);
    check(`Pendel zeigt "${text}" in beiden Schwungrichtungen`, r.ok >= SPALTEN - 1,
      `${r.ok}/${SPALTEN} Spalten${r.bad.length ? `; ${r.bad.slice(0, 3).join(', ')}` : ''}`);
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
