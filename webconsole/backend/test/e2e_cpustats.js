#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test der CPU-Statistik (Anteil Schlaf / Interrupt-Routinen / Normalbetrieb,
 * sim.cpuStats aus TivaSysCtl.GetCpuStats).
 *
 * Firmware: test/firmware/schlaf_takt.c, einmal normal (main schläft per WFI) und einmal mit
 * -DOHNE_WFI (main wartet aktiv). Versuch example2.
 *
 *   node test/e2e_cpustats.js <schlaf_takt.elf> <schlaf_takt_ohne_wfi.elf> [http://localhost:3000]
 *
 * Voraussetzung: Backend läuft (npm start), kein anderer Browser steuert die Simulation.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const [elfWfi, elfBusy] = process.argv.slice(2, 4);
const base = (process.argv[4] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
if (!elfWfi || !elfBusy || !fs.existsSync(elfWfi) || !fs.existsSync(elfBusy)) {
  console.error('Aufruf: node test/e2e_cpustats.js <schlaf_takt.elf> <schlaf_takt_ohne_wfi.elf> [http://localhost:3000]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passed++;
  else failed++;
}
async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  return !!fn();
}
const pct = (a, b) => (100 * a) / b;
const f = (x, d = 3) => x.toFixed(d);

(async () => {
  let sim = null;
  let simCount = 0;
  const errors = [];
  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'error') errors.push(m.message);
    if (m.type === 'sim') {
      sim = m;
      simCount++;
    }
  });
  await new Promise((r) => c.once('open', r));
  const send = (m) => c.send(JSON.stringify(m));

  const u32 = (i) => Buffer.from(sim.memory.data, 'hex').readUInt32LE(4 * i);
  const vars = () => ({ takte: u32(0), zeichen: u32(1), sync: u32(2), wach: u32(3) });
  const vec = (name) => (sim.cpuStats.vectors.find((v) => v.name === name) || { count: 0, instr: 0, ns: 0 });
  // auf eine frische sim-Meldung warten (nach einem Befehl)
  async function fresh(cond = () => true, timeoutMs = 5000) {
    const n = simCount;
    return waitFor(() => simCount > n + 1 && sim.cpuStats && cond(), timeoutMs);
  }
  async function upload(elf) {
    const fd = new FormData();
    fd.append('experiment_id', 'example2');
    fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
    const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
    const body = await res.json();
    check(`POST /upload ${path.basename(elf)} -> 200`, res.status === 200, body.error || '');
    if (res.status !== 200) process.exit(1);
    send({ type: 'watch', sim: true, memory: { addr: 'takte', count: 16 } });
    check('sim mit cpuStats', await waitFor(() => sim && sim.cpuStats && sim.memory && sim.memory.data && sim.time.virtualNs > 300e6, 20000));
  }
  // Angehalten mitten in einer ISR? Dann in Einzelschritten bis die CPU wieder schläft (bzw. bei
  // aktivem Warten: bis keine ISR mehr läuft), damit Zähler der Firmware und Statistik vergleichbar sind
  async function settle(busy) {
    for (let i = 0; i < 100; i++) {
      await fresh();
      if (busy ? sim.cpuStats.isrDepth === 0 : sim.cpu.halted && sim.cpuStats.isrDepth === 0) return true;
      send({ type: 'step', count: 1 });
      await fresh(() => sim.cpu.state === 'Step');
    }
    return false;
  }
  // Pause, Statistik neu, Variablen merken – Weiter – ms Wanduhr – Pause, auswerten
  async function measure(ms, busy = false) {
    send({ type: 'pause' });
    await waitFor(() => sim.cpu.state === 'Paused', 3000);
    await settle(busy);
    send({ type: 'cpuStatsReset' });
    await fresh(() => sim.cpuStats.total.ns < 1e6);
    const v0 = vars();
    const t0 = sim.time.virtualNs;
    check('nach cpuStatsReset: Statistik beginnt bei 0', sim.cpuStats.total.ns === 0 && sim.cpuStats.total.isrCount === 0, JSON.stringify(sim.cpuStats.total));
    send({ type: 'continue' });
    await waitFor(() => sim.cpu.state === 'Running', 3000);
    const recentSeen = await waitFor(() => sim.cpuStats.recent && sim.cpuStats.recent.ns > 0, 4000);
    const recent = sim.cpuStats.recent;
    await sleep(ms);
    send({ type: 'pause' });
    await waitFor(() => sim.cpu.state === 'Paused', 3000);
    check('angehalten außerhalb einer ISR (ggf. nach Einzelschritten)', await settle(busy));
    return { v0, t0, v1: vars(), t1: sim.time.virtualNs, cs: sim.cpuStats, recentSeen, recent };
  }

  // ---- 1. CPU schläft zwischen den Interrupts -------------------------------------------------
  await upload(elfWfi);
  let m = await measure(3000);
  let t = m.cs.total;
  const dTakte = m.v1.takte - m.v0.takte;
  const dSync = m.v1.sync - m.v0.sync;
  const dWach = m.v1.wach - m.v0.wach;
  console.log(`  WFI: Schlaf ${f(pct(t.sleepNs, t.ns))} %, ISR ${f(pct(t.isrNs, t.ns))} %, Normal ${f(pct(t.normalNs, t.ns))} % über ${f(t.ns / 1e9, 2)} s`);
  check('Zeitraum = Simulationszeit seit dem Neubeginn', t.ns === m.t1 - m.t0, `${t.ns} / ${m.t1 - m.t0}`);
  check('Schlaf + ISR + Normal = Zeitraum', Math.abs(t.sleepNs + t.isrNs + t.normalNs - t.ns) < 2);
  check('Timer-ISR: Aufrufe = Zuwachs von takte', vec('INT_TIMER0A').count === dTakte, `${vec('INT_TIMER0A').count} / ${dTakte}`);
  check('Sync-ISR (INT_GPIOL): Aufrufe = Zuwachs von syncFlanken', vec('INT_GPIOL').count === dSync, `${vec('INT_GPIOL').count} / ${dSync}`);
  check('ISR-Aufrufe gesamt = Timer + Sync', t.isrCount === dTakte + dSync, `${t.isrCount}`);
  // WFI bei schon anhängigem Interrupt schläft nicht ein: dann Schleifendurchlauf ohne Aufwachen
  check('Aufwachen ≈ Durchläufe der Hauptschleife (wachPhasen, höchstens 2 ohne Schlaf)', t.wakes <= dWach && dWach - t.wakes <= 2, `${t.wakes} / ${dWach}`);
  check('Timer-ISR: 1 Aufruf je ms Simulationszeit', Math.abs(dTakte - t.ns / 1e6) <= 1, `${dTakte} in ${f(t.ns / 1e6, 1)} ms`);
  const perTimer = vec('INT_TIMER0A').instr / vec('INT_TIMER0A').count;
  check('Timer-ISR: gleich viele Befehle je Aufruf (15 .. 60)', perTimer >= 15 && perTimer <= 60, f(perTimer, 1));
  check('Schlaf > 99 % (1-ms-Takt, ISR nur wenige µs)', pct(t.sleepNs, t.ns) > 99, `${f(pct(t.sleepNs, t.ns))} %`);
  const expIsr = (t.isrCount ? (vec('INT_TIMER0A').instr + vec('INT_GPIOL').instr) : 0) * m.cs.nsPerInstr;
  check('ISR-Zeit = Befehle der Routinen × Befehlszeit', Math.abs(t.isrNs - expIsr) < 1, `${f(t.isrNs / 1e3, 1)} µs`);
  check('ISR-Anteil plausibel: Timer-Befehle je ms × Befehlszeit', Math.abs(pct(t.isrNs, t.ns) - (100 * perTimer * m.cs.nsPerInstr) / 1e6) < 0.1,
    `${f(pct(t.isrNs, t.ns))} % / ${f((100 * perTimer * m.cs.nsPerInstr) / 1e6)} %`);
  check('Normalbetrieb klein, aber > 0 (Hauptschleife nach jedem Aufwachen)', t.normalNs > 0 && pct(t.normalNs, t.ns) < 1, `${f(pct(t.normalNs, t.ns))} %`);
  check('"zuletzt" (Abfrageabstand) vorhanden, Summe = Zeitraum', m.recentSeen && Math.abs(m.recent.sleepNs + m.recent.isrNs + m.recent.normalNs - m.recent.ns) < 2);
  check('"zuletzt" ebenfalls > 99 % Schlaf', m.recentSeen && pct(m.recent.sleepNs, m.recent.ns) > 99, m.recent ? `${f(pct(m.recent.sleepNs, m.recent.ns))} %` : '');

  // In der Pause ändert sich nichts
  const frozen = JSON.stringify(sim.cpuStats.total);
  await sleep(1200);
  await fresh();
  check('Pause: Statistik steht', JSON.stringify(sim.cpuStats.total) === frozen);

  // Einzelschritt: Schritt aus WFI steht vor der ISR (zählt schon als ISR-Aufruf), jeder Befehl
  // darin erhöht die ISR-Befehle um genau 1
  const s0 = sim.cpuStats.total;
  send({ type: 'step', count: 1 });
  await fresh(() => sim.cpu.state === 'Step' && /_Handler/.test(sim.cpu.symbol || ''), 10000);
  const s1 = sim.cpuStats;
  check('Schritt aus WFI: ISR betreten (Tiefe 1, Aufrufe +1)', s1.isrDepth === 1 && s1.total.isrCount === s0.isrCount + 1, `Tiefe ${s1.isrDepth}`);
  check('Schritt aus WFI: Zeit bis zum Interrupt als Schlaf gezählt', s1.total.sleepNs > s0.sleepNs && s1.total.isrNs === s0.isrNs);
  send({ type: 'step', count: 5 });
  await fresh(() => sim.cpu.state === 'Step');
  const s2 = sim.cpuStats;
  check('5 Schritte in der ISR: ISR-Zeit +5 Befehlszeiten, Normal unverändert',
    Math.abs(s2.total.isrNs - s1.total.isrNs - 5 * s2.nsPerInstr) < 1 && Math.abs(s2.total.normalNs - s1.total.normalNs) < 1,
    `ΔISR ${f(s2.total.isrNs - s1.total.isrNs, 1)} ns`);

  // Reset der MCU beginnt die Statistik neu
  send({ type: 'continue' });
  await waitFor(() => sim.cpu.state === 'Running', 3000);
  await sleep(500);
  const resets = sim.resets.count;
  send({ type: 'reset' });
  check('Reset der MCU: Statistik beginnt neu (Zeitraum = Zeit seit dem Reset)',
    await fresh(() => sim.resets.count > resets && Math.abs(sim.cpuStats.total.ns - (sim.time.virtualNs - sim.resets.lastNs)) <= 1e6, 8000),
    `${sim.cpuStats.total.ns} / ${sim.time.virtualNs - sim.resets.lastNs} ns`);

  // ---- 2. Aktives Warten statt WFI ------------------------------------------------------------
  await upload(elfBusy);
  m = await measure(2000, true);
  t = m.cs.total;
  console.log(`  ohne WFI: Schlaf ${f(pct(t.sleepNs, t.ns))} %, ISR ${f(pct(t.isrNs, t.ns))} %, Normal ${f(pct(t.normalNs, t.ns))} % über ${f(t.ns / 1e9, 2)} s`);
  check('ohne WFI: kein Schlaf (< 0,5 %), nie aufgewacht', pct(t.sleepNs, t.ns) < 0.5 && t.wakes === 0, `${f(pct(t.sleepNs, t.ns))} %`);
  check('ohne WFI: Normalbetrieb > 98 %', pct(t.normalNs, t.ns) > 98, `${f(pct(t.normalNs, t.ns))} %`);
  check('ohne WFI: Timer-ISR weiter 1 je ms', vec('INT_TIMER0A').count === m.v1.takte - m.v0.takte && Math.abs(vec('INT_TIMER0A').count - t.ns / 1e6) <= 1);
  const perBusy = vec('INT_TIMER0A').instr / vec('INT_TIMER0A').count;
  check('ohne WFI: ISR-Anteil wie mit WFI (gleiche Routine)', Math.abs(perBusy - perTimer) < 2, `${f(perBusy, 1)} / ${f(perTimer, 1)} Befehle`);
  check('Schlaf + ISR + Normal = Zeitraum', Math.abs(t.sleepNs + t.isrNs + t.normalNs - t.ns) < 2);
  send({ type: 'continue' });

  check('keine Fehlermeldungen vom Backend', errors.length === 0, errors.join('; '));
  send({ type: 'watch', sim: false });
  c.close();
  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
