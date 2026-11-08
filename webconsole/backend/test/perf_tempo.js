#!/usr/bin/env node
'use strict';
/**
 * Misst das Tempo der Simulation über das Backend (kein Bestanden/Fehlgeschlagen):
 *   node test/perf_tempo.js <firmware.elf> [mit Anzeige 0|1] [Sekunden] [Versuch] [http://localhost:3000]
 *
 * Tempo = virtuelle Zeit (aus "pdev", Pendel des Versuchs) je Wanduhrzeit. "mit Anzeige" = 1 öffnet
 * wie ein Browser Simulations-Panel (Variablen, TIMER0), Oszilloskop (PL0, PN1) und den Flankenstrom
 * von U0TX. Dazu die Rechenzeit von Renode und vom Backend (Linux /proc). Renode hält höchstens
 * Echtzeit (1,0).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const [elf, show = '0', secs = '15', exp = 'example2', base = 'http://localhost:3000'] = process.argv.slice(2);
if (!elf || !fs.existsSync(elf)) {
  console.error('Aufruf: node test/perf_tempo.js <firmware.elf> [0|1] [Sekunden] [Versuch] [URL]');
  process.exit(2);
}
const host = new URL(base).hostname;
const cpuSeconds = (pattern) => {
  let t = 0;
  for (const pid of execSync(`pgrep -f '${pattern}' || true`).toString().split('\n').filter(Boolean)) {
    try {
      const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      t += (Number(f[11]) + Number(f[12])) / 100;
    } catch {
      /* Prozess weg */
    }
  }
  return t;
};

(async () => {
  const samples = [];
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'pdev') samples.push([Date.now(), m.now[0]]);
  });
  await new Promise((r) => c.once('open', r));
  const fd = new FormData();
  fd.append('experiment_id', exp);
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  if (res.status !== 200) throw new Error(`Upload: ${res.status}`);
  if (show === '1') {
    c.send(JSON.stringify({ type: 'watch', sim: true, memory: { addr: 'main', count: 16 }, periph: 'TIMER0' }));
    c.send(JSON.stringify({ type: 'scope', sources: ['PL0', 'PN1'] }));
    c.send(JSON.stringify({ type: 'subscribe', signals: ['uart0.tx'] }));
  }
  await new Promise((r) => setTimeout(r, 4000));
  const from = samples.length;
  const r0 = cpuSeconds('renode.*--port');
  const n0 = cpuSeconds('node.*server.js');
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  const r1 = cpuSeconds('renode.*--port');
  const n1 = cpuSeconds('node.*server.js');
  const s = samples.slice(from);
  if (s.length < 2) throw new Error('keine Pendel-Daten (Versuch ohne Pendel?)');
  const virt = (s[s.length - 1][1] - s[0][1]) / 1e6;
  const wall = (s[s.length - 1][0] - s[0][0]) / 1000;
  console.log(
    `${path.basename(elf)} Anzeige=${show}: Tempo ${(virt / wall).toFixed(3)} × Echtzeit, ` +
      `Renode ${(((r1 - r0) / wall) * 100).toFixed(0)} % CPU, Backend ${(((n1 - n0) / wall) * 100).toFixed(0)} % CPU`,
  );
  if (show === '1') c.send(JSON.stringify({ type: 'watch', sim: false }));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
