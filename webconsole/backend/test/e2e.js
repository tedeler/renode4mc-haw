#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test der Web-Konsole mit echter Renode-Instanz und der Firmware aus
 * examples/example03_webkonsole. Prüft Upload, UART, LEDs, Taster, Keypad, Sensor und OLED über
 * dieselben Schnittstellen, die auch das Frontend benutzt (HTTP + beide WebSockets).
 *
 *   node test/e2e.js <example03_webkonsole.out> [http://localhost:3000]
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
  console.error('Aufruf: node test/e2e.js <example03_webkonsole.out> [http://localhost:3000]');
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

(async () => {
  // 1. Upload
  const fd = new FormData();
  fd.append('experiment_id', 'example1');
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const t0 = Date.now();
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check('POST /upload -> 200', res.status === 200, `${Date.now() - t0} ms ${body.error || ''}`);
  if (res.status !== 200) process.exit(1);

  // 2. WebSockets
  let uart = '';
  const leds = {};
  let frame = null;
  const errors = [];
  const u = new WebSocket(`ws://${host}:3333`);
  u.on('message', (d) => (uart += d.toString()));
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello' || m.type === 'leds') Object.assign(leds, m.leds || m.states || {});
    if (m.type === 'fb') frame = m;
    if (m.type === 'error') errors.push(m.message);
  });
  await Promise.all([u, c].map((ws) => new Promise((r) => ws.once('open', r))));
  const send = (m) => c.send(JSON.stringify(m));

  check('UART: Startmeldung', await waitFor(() => /Example 03 Web-Konsole/.test(uart)));

  send({ type: 'sensor', value: 42 });
  check('Sensor 42 cm -> UART', await waitFor(() => /Abstand:\s+42 cm/.test(uart)));
  check('Sensor < 50 cm -> LED D1 an', await waitFor(() => leds.D1 === true));
  send({ type: 'sensor', value: 250 });
  check('Sensor 250 cm -> LED D1 aus', await waitFor(() => leds.D1 === false));

  send({ type: 'keypad', row: 1, col: 1, pressed: true });
  check('Keypad Zeile 1/Spalte 1 -> Taste 5', await waitFor(() => /Taste: 5/.test(uart)));
  send({ type: 'keypad', row: 1, col: 1, pressed: false });
  check('Keypad loslassen', await waitFor(() => /Taste losgelassen/.test(uart)));

  const d3 = leds.D3;
  send({ type: 'button', id: 'SW1', pressed: true });
  await sleep(150);
  send({ type: 'button', id: 'SW1', pressed: false });
  check('USR_SW1 -> UART', await waitFor(() => /USR_SW1 gedrueckt/.test(uart)));
  check('USR_SW1 -> LED D3 umgeschaltet', await waitFor(() => leds.D3 === !d3));

  u.send('x');
  check('UART-Echo', await waitFor(() => /x/.test(uart.split('USR_SW1').pop())));

  check('OLED: Frame empfangen, Display an', await waitFor(() => frame && frame.on, 3000));
  check('keine Fehlermeldungen vom Backend', errors.length === 0, errors.join('; '));

  u.close();
  c.close();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
