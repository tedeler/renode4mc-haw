#!/usr/bin/env node
'use strict';
/*
 * Ende-zu-Ende-Test des Versuchs example3 (Timer: Compare-Action-PWM, Puls, Edge-Time-Capture) mit
 * echter Renode-Instanz und der Demo examples/example05_timer_ccp (sim/solutions/example05_timer_ccp.elf,
 * tools/build-solutions.sh). Prüft über dieselben Schnittstellen wie das Frontend:
 *   - Start der Demo per POST /api/solution, UART-Startmeldung
 *   - Oszilloskop: LED1 (PL4) 30 Hz mit 25/50 % HIGH, LED2 (PL6) 100 ms HIGH alle 1 s, 0 %/100 % ohne Flanken
 *   - LED-Helligkeit (levels) bei PWM, harte Wechsel beim Puls
 *   - Taster 0..3 -> Stufe (UART), Tastendauer von Taste 0 per Capture = Dauer am Oszilloskop
 *   - keine Diagnose-Warnungen
 *
 *   node test/e2e_timer.js [http://localhost:3000]
 */
const WebSocket = require('ws');

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
async function waitFor(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/** HIGH-/LOW-Phasen eines Pins ab t0 (ns): [[Pegel, Dauer ms], ...] */
function phases(edges, t0 = 0) {
  const e = (edges || []).filter(([t]) => t >= t0);
  const out = [];
  for (let i = 0; i + 1 < e.length; i++) out.push([e[i][1], (e[i + 1][0] - e[i][0]) / 1e6]);
  return out;
}

async function main() {
  const list = await (await fetch(`${base}/api/experiments`)).json();
  const info = list.find((x) => x.id === 'example3');
  check('example3 in der Versuchsliste, Demo gebaut', !!(info && info.solution && info.solution.available), JSON.stringify(info && info.solution));

  const res = await fetch(`${base}/api/solution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experiment_id: 'example3' }),
  });
  const body = await res.json();
  check('POST /api/solution example3 -> 200', res.status === 200, body.error || '');
  if (res.status !== 200) process.exit(1);

  const s = { uart: '', leds: {}, levels: {}, levelLog: [], edges: {}, nowNs: 0, diag: [], errors: [] };
  s.u = new WebSocket(`ws://${host}:3333`);
  s.u.on('message', (d) => (s.uart += Buffer.from(d).toString('latin1')));
  s.c = new WebSocket(`ws://${host}:3334`);
  s.c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') s.diag = m.diagnostics || [];
    if (m.type === 'leds') {
      Object.assign(s.leds, m.states);
      s.levels = m.levels || {};
      s.levelLog.push({ ...s.levels });
    }
    if (m.type === 'diag') s.diag.push(m);
    if (m.type === 'diagReset') s.diag = [];
    if (m.type === 'error') s.errors.push(m.message);
    if (m.type === 'scope') {
      let t = 0;                                   // erster dt je Nachricht = Zeit seit Start
      for (let k = 0; k + 2 < m.ev.length; k += 3) {
        t += m.ev[k + 1];
        const pin = m.pins[m.ev[k]];
        (s.edges[pin] = s.edges[pin] || []).push([t, m.ev[k + 2]]);
      }
      if (m.now) s.nowNs = m.now;
    }
  });
  await Promise.all([s.u, s.c].map((ws) => new Promise((r) => ws.once('open', r))));
  const send = (m) => s.c.send(JSON.stringify(m));
  const lastEdge = (pin) => ((s.edges[pin] || []).slice(-1)[0] || [0])[0];
  const press = async (id, ms) => {
    send({ type: 'button', id, pressed: true });
    await sleep(ms);
    send({ type: 'button', id, pressed: false });
  };

  check('UART: Startmeldung', await waitFor(() => /Example 05 Timer-CCP/.test(s.uart), 15000), JSON.stringify(s.uart.slice(0, 60)));
  check('UART: Start mit 25 %', await waitFor(() => /PWM: 25 %/.test(s.uart)));
  send({ type: 'scope', sources: ['PL4', 'PL6', 'PM0'] });
  check('Oszilloskop: Flanken an PL4/PL6', await waitFor(() => (s.edges.PL4 || []).length > 40 && (s.edges.PL6 || []).length >= 4, 20000),
    `PL4 ${(s.edges.PL4 || []).length}, PL6 ${(s.edges.PL6 || []).length}`);

  // 25 %: 8,333 ms HIGH, 25,000 ms LOW
  let ph = phases(s.edges.PL4).slice(2);
  check('LED1 (PL4) 25 %: HIGH 8,333 ms / LOW 25,000 ms',
    ph.length > 10 && ph.every(([l, d]) => Math.abs(d - (l ? 8.333 : 25.0)) < 0.002), ph.slice(0, 4).map(([l, d]) => `${l ? 'H' : 'L'}${d}`).join(' '));
  const pl6 = phases(s.edges.PL6);
  check('LED2 (PL6): 100 ms HIGH / 900 ms LOW', pl6.length >= 3 && pl6.every(([l, d]) => Math.abs(d - (l ? 100 : 900)) < 0.002),
    pl6.map(([l, d]) => `${l ? 'H' : 'L'}${d}`).join(' '));
  const lv = s.levelLog.map((l) => l.LED1).filter((x) => typeof x === 'number');
  const avg = lv.reduce((a, b) => a + b, 0) / (lv.length || 1);
  check('LED1: Helligkeit gemittelt ca. 25 %', lv.length > 10 && avg > 0.15 && avg < 0.35, `${lv.length} Werte, Mittel ${avg.toFixed(3)}`);
  check('LED2: keine Helligkeitswerte (harter Puls)', s.levelLog.every((l) => l.LED2 === undefined));
  check('LED3 an, LED4 aus (Stufe 1 = 01)', s.leds.LED3 === true && s.leds.LED4 === false, JSON.stringify(s.leds));

  // Taste 2: 50 %
  await press('T2', 150);
  check('UART: Taste 2 -> 50 %', await waitFor(() => /PWM: 50 %/.test(s.uart)));
  let t0 = lastEdge('PL4');
  await sleep(1500);
  ph = phases(s.edges.PL4, t0).slice(3);
  check('LED1 50 %: HIGH 16,666 ms / LOW 16,667 ms', ph.length > 10 && ph.every(([l, d]) => Math.abs(d - (l ? 16.666 : 16.667)) < 0.002),
    ph.slice(0, 4).map(([l, d]) => `${l ? 'H' : 'L'}${d}`).join(' '));

  // Taste 3: 100 % -> keine Flanken mehr, LED an, Helligkeit fällt weg
  await press('T3', 150);
  check('UART: Taste 3 -> 100 %', await waitFor(() => /PWM: 100 %/.test(s.uart)));
  await sleep(600);
  const n100 = (s.edges.PL4 || []).length;
  await sleep(1000);
  check('LED1 100 %: dauernd HIGH, keine Flanken', (s.edges.PL4 || []).length === n100 && s.leds.LED1 === true, `${(s.edges.PL4 || []).length - n100} Flanken`);
  check('LED1 100 %: keine Helligkeit mehr (an/aus)', s.levels.LED1 === undefined, JSON.stringify(s.levels));
  check('LED3 + LED4 an (Stufe 3 = 11)', s.leds.LED3 === true && s.leds.LED4 === true, JSON.stringify(s.leds));

  // Taste 0 lang (> 1,05 s: Überlauf des 24-Bit-Zählers): 0 % und Dauer per Capture
  const before = (s.uart.match(/Taste 0 gedrueckt/g) || []).length;
  const pm0Before = (s.edges.PM0 || []).length;
  await press('T0', 1800);
  check('UART: Taste 0 -> 0 %', await waitFor(() => /PWM: 0 %/.test(s.uart)));
  check('UART: Dauer von Taste 0 gemeldet', await waitFor(() => (s.uart.match(/Taste 0 gedrueckt/g) || []).length > before));
  await waitFor(() => (s.edges.PM0 || []).length >= pm0Before + 2, 4000);
  const e = (s.edges.PM0 || []).slice(pm0Before);
  const scopeMs = e.length >= 2 ? (e[1][0] - e[0][0]) / 1e6 : NaN;
  const m = /Taste 0 gedrueckt: (\d+),(\d{3}) ms\r\n(?![\s\S]*Taste 0 gedrueckt)/.exec(s.uart);
  const uartMs = m ? +m[1] + +m[2] / 1000 : NaN;
  check('Capture: Dauer = Oszilloskop (± 20 us), > 1,05 s', Math.abs(uartMs - scopeMs) < 0.02 && uartMs > 1100,
    `UART ${uartMs} ms, Oszilloskop ${scopeMs} ms`);
  await sleep(600);
  const n0 = (s.edges.PL4 || []).length;
  await sleep(1000);
  check('LED1 0 %: dauernd LOW, keine Flanken', (s.edges.PL4 || []).length === n0 && s.leds.LED1 === false);
  check('LED3 + LED4 aus (Stufe 0 = 00)', s.leds.LED3 === false && s.leds.LED4 === false, JSON.stringify(s.leds));

  // kurzer Druck (ohne Überlauf)
  const pm0b = (s.edges.PM0 || []).length;
  await press('T0', 300);
  await waitFor(() => (s.edges.PM0 || []).length >= pm0b + 2, 4000);
  await sleep(300);
  const e2 = (s.edges.PM0 || []).slice(pm0b);
  const scope2 = e2.length >= 2 ? (e2[1][0] - e2[0][0]) / 1e6 : NaN;
  const m2 = /Taste 0 gedrueckt: (\d+),(\d{3}) ms\r\n(?![\s\S]*Taste 0 gedrueckt)/.exec(s.uart);
  const uart2 = m2 ? +m2[1] + +m2[2] / 1000 : NaN;
  check('Capture: kurzer Druck = Oszilloskop (± 20 us)', Math.abs(uart2 - scope2) < 0.02, `UART ${uart2} ms, Oszilloskop ${scope2} ms`);

  await press('T1', 150);
  check('UART: Taste 1 -> 25 %', await waitFor(() => (s.uart.match(/PWM: 25 %/g) || []).length >= 2));

  check('keine Diagnose-Warnungen', s.diag.length === 0, s.diag.map((d) => d.message).join(' | '));
  check('keine Fehlermeldungen vom Backend', s.errors.length === 0, s.errors.join('; '));
  send({ type: 'scope', sources: [] });
  s.u.close();
  s.c.close();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
