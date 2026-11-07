#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test: Pause und Einzelschritt, auch wenn die CPU schläft (WFI). Angehalten muss
 * ALLES stehen, im Einzelschritt läuft alles genau so weit wie die CPU: Timer, UART (Flanken und
 * Terminal), Pendel, Oszilloskop.
 *
 * Firmware: test/firmware/schlaf_takt.c (Timer0A 1 ms -> takte++, D1 = PN1 umschalten, jede 10. ms
 * ein Zeichen 'a'..'z' auf UART0; PL0 = Sync des Pendels -> syncFlanken++; main schläft nur, liest
 * nach dem Aufwachen 's'/'g' vom UART: Timer aus/an). Versuch example2 (Pendel 10 Hz an PM/PL0).
 *
 *   node test/e2e_step.js <schlaf_takt.elf> [http://localhost:3000]
 *
 * Voraussetzung: Backend läuft (npm start), kein anderer Browser steuert die Simulation.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const elf = process.argv[2];
const base = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
if (!elf || !fs.existsSync(elf)) {
  console.error('Aufruf: node test/e2e_step.js <schlaf_takt.elf> [http://localhost:3000]');
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

const MS = 1e6; // ns
const TAILR = 16000 - 1; // 1 ms bei 16 MHz
const HALF_US = 50000; // Pendel 10 Hz: halbe Schwingung 50 ms

(async () => {
  // ---- Empfang ---------------------------------------------------------------------------
  let sim = null;
  let simCount = 0;
  let pdev = null;
  let pd = null;
  const scopeEv = []; // [pin, t ns, level]
  let scope = null;
  const edges = { 'uart0.tx': [], 'uart0.rx': [] };
  const edgesNow = {};
  const errors = [];
  let uart = '';

  const c = new WebSocket(`ws://${host}:3334`);
  c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'error') errors.push(m.message);
    if (m.type === 'sim') {
      sim = m;
      simCount++;
    }
    if (m.type === 'pdev') pdev = m;
    if (m.type === 'pd') pd = m;
    if (m.type === 'renode' && m.state === 'stopped') {
      scopeEv.length = 0;
      edges['uart0.tx'] = [];
      edges['uart0.rx'] = [];
    }
    if (m.type === 'scope') {
      scope = m;
      // ev = [i, dt, Pegel, …]: dt ab 0 (erstes Ereignis = absolute Zeit), danach seit dem vorigen
      let t = 0;
      for (let k = 0; k + 2 < m.ev.length; k += 3) {
        t += m.ev[k + 1];
        scopeEv.push([m.pins[m.ev[k]], t, m.ev[k + 2]]);
      }
    }
    if (m.type === 'edges' && edges[m.name]) {
      edgesNow[m.name] = m.now;
      for (const e of m.edges) edges[m.name].push(e);
    }
  });
  await new Promise((r) => c.once('open', r));
  const send = (m) => c.send(JSON.stringify(m));

  send({ type: 'uartconfig', baud: 115200, format: '8N1' });
  send({ type: 'subscribe', signals: ['uart0.tx', 'uart0.rx'] });

  const fd = new FormData();
  fd.append('experiment_id', 'example2');
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check('POST /upload (example2) -> 200', res.status === 200, body.error || '');
  if (res.status !== 200) process.exit(1);

  const u = new WebSocket(`ws://${host}:3333`);
  u.on('message', (d) => (uart += Buffer.from(d).toString('latin1')));
  await new Promise((r) => u.once('open', r));
  const lower = () => (uart.match(/[a-z]/g) || []).length;

  send({ type: 'pendulum', frequency: 10 });
  send({ type: 'scope', sources: ['PL0', 'PN1', 'PA1'] });
  send({ type: 'watch', sim: true, memory: { addr: 'takte', count: 16 }, periph: 'TIMER0' });

  // ---- Auswertung der Anzeige-Daten ------------------------------------------------------
  const u32 = (hex, i) => (hex ? Buffer.from(hex, 'hex').readUInt32LE(4 * i) : NaN);
  const vars = () => {
    const d = sim && sim.memory && sim.memory.data;
    return { takte: u32(d, 0), zeichen: u32(d, 1), sync: u32(d, 2), wach: u32(d, 3) };
  };
  const reg = (name) => {
    const r = sim && sim.periph && sim.periph.regs.find((x) => x.name === name);
    return r ? r.value : null;
  };
  const now = () => sim.time.virtualNs;
  const snap = () => ({ ns: now(), pc: sim.cpu.pc, sym: sim.cpu.symbol || '', state: sim.cpu.state, halted: sim.cpu.halted, ...vars(), tav: reg('TIMER0_TAV_R'), disasm: sim.disasm });
  const pdevNs = () => pdev.now[0] * 1000;
  const scopeLevel = (pin) => scope.levels[scope.pins.indexOf(pin)]; // Pegel bei scope.now
  const scopeEdges = (pin, a, b) => scopeEv.filter(([p, t]) => p === pin && t > a && t <= b).length;

  // Einen Schritt senden und auf den ZUSTAND DANACH warten (neue sim-Nachricht mit Änderung und
  // danach eine weitere ohne Änderung)
  async function step(count, timeoutMs = 20000) {
    const before = snap();
    const n0 = simCount;
    send({ type: 'step', count });
    const changed = await waitFor(
      () => simCount > n0 && sim.stopped && (sim.cpu.pc !== before.pc || now() !== before.ns || sim.cpu.state === 'Wake'),
      timeoutMs,
    );
    if (!changed) return { ok: false, before, after: snap() };
    // stabil: zwei aufeinanderfolgende Meldungen gleich und Zeit steht
    for (;;) {
      const s = snap();
      const k = simCount;
      if (!(await waitFor(() => simCount > k, 2000))) break;
      if (sim.cpu.state === 'Step' && now() === s.ns && sim.cpu.pc === s.pc) break;
      if (sim.cpu.state === 'Wake') {
        if (!(await waitFor(() => sim.cpu.state !== 'Wake', timeoutMs))) break;
      }
    }
    // pdev/scope/edges kommen mit dem nächsten Poll (100 ms)
    await waitFor(() => pdev && Math.abs(pdevNs() - now()) < 1000, 2000);
    await sleep(250);
    return { ok: true, before, after: snap() };
  }
  async function stepUntilAsleep(max = 80) {
    for (let i = 0; i < max; i++) {
      if (sim.cpu.halted) return true;
      await step(1);
    }
    return sim.cpu.halted;
  }

  // ---- 1. Läuft --------------------------------------------------------------------------
  check('läuft: UART-Zeichen der Timer-ISR kommen an', await waitFor(() => lower() >= 3, 15000), JSON.stringify(uart.slice(-20)));
  check('läuft: sim mit Variablen und TIMER0', await waitFor(() => sim && sim.memory && sim.memory.data && reg('TIMER0_TAILR_R') === TAILR, 5000));
  check('läuft: Pendel 10 Hz', await waitFor(() => pd && pd.periodUs === 100000, 3000));

  // ---- 2. Pause: alles steht --------------------------------------------------------------
  send({ type: 'pause' });
  check('Pause -> angehalten', await waitFor(() => sim.cpu.state === 'Paused', 3000), sim.cpu.state);
  await waitFor(() => pdev && pdev.frozen, 2000);
  await sleep(400);
  const p0 = snap();
  const pdev0 = pdev.now[0];
  const uart0 = uart.length;
  const scopeN0 = scopeEv.length;
  const tx0 = edges['uart0.tx'].length;
  u.send('x'); // Tastendruck im Terminal während der Pause
  await sleep(1500);
  const p1 = snap();
  check('Pause: CPU schläft (WFI)', p0.halted === true);
  check('Pause: takte = Simulationszeit in ms (Timer seit Start synchron)', Math.abs(p0.takte - p0.ns / MS) < 2, `${p0.takte} / ${(p0.ns / MS).toFixed(2)} ms`);
  check('Pause: Simulationszeit steht (1,5 s)', p1.ns === p0.ns, `${p0.ns} -> ${p1.ns}`);
  check('Pause: Variablen der Firmware stehen', p1.takte === p0.takte && p1.zeichen === p0.zeichen && p1.sync === p0.sync);
  check('Pause: Timerzähler TAV steht', p1.tav === p0.tav && p0.tav !== null, `${p0.tav}`);
  check('Pause: Pendel steht (pdev-Zeit, frozen)', pdev.now[0] === pdev0 && pdev.frozen === true);
  check('Pause: Pendelzeit = Simulationszeit', Math.abs(pdevNs() - p0.ns) < 1000, `${pdevNs()} / ${p0.ns}`);
  check('Pause: Oszilloskop ohne neue Pegelwechsel, now = Simulationszeit', scopeEv.length === scopeN0 && Math.abs(scope.now - p0.ns) < 1000, `${scope.now}`);
  check('Pause: keine neuen Flanken auf U0TX, now = Simulationszeit', edges['uart0.tx'].length === tx0 && Math.abs(edgesNow['uart0.tx'] - p0.ns) < 1000);
  check('Pause: Tastendruck erzeugt (noch) keine Flanken auf U0RX nach dem Haltezeitpunkt',
    edges['uart0.rx'].every(([t]) => t <= p0.ns));
  check('Pause: Terminal empfängt nichts', uart.length === uart0);

  // ---- 3. Schritt bei schlafender CPU: läuft bis zum Interrupt -----------------------------
  let r = await step(1);
  let s = r.after;
  const irqA = s.ns;
  check('Schritt aus WFI: hält an', r.ok && s.state === 'Step', s.state);
  check('Schritt aus WFI: steht am Anfang einer Interrupt-Routine', /^(TIMER0A|GPIOL)_Handler/.test(s.sym), `${s.sym} ${s.pc}`);
  check('Schritt aus WFI: Zeit bis zum nächsten Interrupt (0 < dt <= 1 ms)', s.ns > p0.ns && s.ns - p0.ns <= MS, `${(s.ns - p0.ns) / 1000} us`);
  check('Schritt aus WFI: ISR noch nicht ausgeführt (takte gleich)', s.takte === p0.takte);
  if (/^GPIOL/.test(s.sym)) {
    // seltener Fall: Pendel-Sync kam zuerst – bis zum nächsten WFI und noch einmal
    await stepUntilAsleep();
    r = await step(1);
    s = r.after;
  }
  const irq1 = s.ns;
  check('Schritt aus WFI: Timer-ISR', /^TIMER0A_Handler/.test(s.sym), s.sym);
  check('Timer synchron zur CPU: beim Einsprung frisch nachgeladen (TAV nahe TAILR)', s.tav !== null && TAILR - s.tav <= 32, `TAV=${s.tav}`);
  check('Pendel synchron: pdev-Zeit = CPU-Zeit, frozen', Math.abs(pdevNs() - s.ns) < 1000 && pdev.frozen === true, `${pdevNs()} / ${s.ns}`);
  check('Oszilloskop synchron: now = CPU-Zeit', Math.abs(scope.now - s.ns) < 1000, `${scope.now} / ${s.ns}`);
  check('UART-Flanken synchron: now = CPU-Zeit', Math.abs(edgesNow['uart0.tx'] - s.ns) < 1000, `${edgesNow['uart0.tx']} / ${s.ns}`);
  void irqA;

  // ---- 4. Schritte in der ISR: genau n Befehle --------------------------------------------
  const dis = s.disasm || [];
  r = await step(3);
  check('Schritt 3: PC = 4. Befehl der Disassembly', dis.length > 3 && parseInt(r.after.pc, 16) === dis[3].addr,
    `${r.after.pc} / ${dis[3] && dis[3].addr.toString(16)}`);
  check('Schritt 3: Zeit nur um Befehlszeiten weiter (< 2 us)', r.after.ns - s.ns < 2000, `${r.after.ns - s.ns} ns`);
  const before = r.after;
  const ok = await stepUntilAsleep();
  s = snap();
  check('Einzelschritte bis zum WFI: ISR vollständig, takte +1', ok && s.takte === before.takte + 1, `${before.takte} -> ${s.takte}`);
  check('Einzelschritte: D1 (PN1) genau einmal umgeschaltet, im Schritt-Zeitraum',
    scopeEdges('PN1', irq1 - 1, s.ns) === 1, `${scopeEdges('PN1', irq1 - 1, s.ns)}`);
  check('Einzelschritte: Zeit lief nur wenige us (CPU-Befehle)', s.ns - irq1 < 20000, `${(s.ns - irq1) / 1000} us`);

  // ---- 5. Nächster Schritt aus WFI: Interrupt genau 1 ms nach dem vorigen ------------------
  r = await step(1);
  const irq2 = r.after.ns;
  if (/^GPIOL/.test(r.after.sym)) {
    await stepUntilAsleep();
    r = await step(1);
  }
  check('Timer-Interrupts im Schrittbetrieb genau 1 ms auseinander', /^TIMER0A/.test(r.after.sym) && (r.after.ns - irq1) % MS <= 2000 && r.after.ns > irq1,
    `${(r.after.ns - irq1) / 1000} us (${r.after.sym})`);
  void irq2;

  // ---- 6. Viele Schritte (~100 ms): Timer, UART, Pendel, Oszilloskop zählen mit ------------
  const a = snap();
  const phiA = pdev.now[1] / 10000;
  const lowA = lower();
  const txA = edges['uart0.tx'].length;
  for (let i = 0; i < 12 && now() - a.ns < 110 * MS; i++) {
    r = await step(1000, 30000);
    if (!r.ok) break;
  }
  await stepUntilAsleep();
  await sleep(400);
  const b = snap();
  const phiB = pdev.now[1] / 10000;
  const dtMs = (b.ns - a.ns) / MS;
  check('Viele Schritte: mehr als 100 ms Simulationszeit geschafft', dtMs > 100, `${dtMs.toFixed(2)} ms`);
  check('Viele Schritte: Timer-ISR je ms (Δtakte = Δt)', Math.abs(b.takte - a.takte - dtMs) <= 1, `Δtakte=${b.takte - a.takte}, Δt=${dtMs.toFixed(2)} ms`);
  const crossings = Math.floor(phiB) - Math.floor(phiA);
  check('Viele Schritte: Pendel bewegt sich mit der CPU-Zeit (Δphi = Δt / 50 ms)', Math.abs((phiB - phiA) - (b.ns - a.ns) / 1000 / HALF_US) < 0.001,
    `Δphi=${(phiB - phiA).toFixed(4)}`);
  check('Viele Schritte: Sync-Interrupt je Mittendurchgang des Pendels', b.sync - a.sync === crossings, `Δsync=${b.sync - a.sync}, Durchgänge=${crossings}`);
  check('Viele Schritte: Oszilloskop zeigt dieselben Sync-Flanken (PL0)', scopeEdges('PL0', a.ns, b.ns) === crossings, `${scopeEdges('PL0', a.ns, b.ns)}`);
  check('Viele Schritte: PL0-Pegel passt zur Pendelphase (HIGH = rechts)', scopeLevel('PL0') === (Math.floor(phiB) % 2 === 0 ? 1 : 0),
    `Pegel ${scopeLevel('PL0')}, phi ${phiB.toFixed(3)}`);
  check('Viele Schritte: D1 (PN1) je Timer-ISR umgeschaltet', scopeEdges('PN1', a.ns, b.ns) === b.takte - a.takte, `${scopeEdges('PN1', a.ns, b.ns)}`);
  check('Viele Schritte: UART-Zeichen jede 10. ms gesendet', Math.abs(b.zeichen - a.zeichen - (b.takte - a.takte) / 10) <= 1, `Δzeichen=${b.zeichen - a.zeichen}`);
  check('Viele Schritte: Terminal hat genau die gesendeten Zeichen (höchstens eins unterwegs)',
    lower() - lowA === b.zeichen - a.zeichen || lower() - lowA === b.zeichen - a.zeichen - 1, `Terminal +${lower() - lowA}, Firmware +${b.zeichen - a.zeichen}`);
  check('Viele Schritte: U0TX-Flanken nur im Schritt-Zeitraum, 10 Bit je Zeichen',
    edges['uart0.tx'].slice(txA).every(([t]) => t > a.ns && t <= b.ns) && edges['uart0.tx'].length > txA);
  check('Viele Schritte: Pendel/Oszilloskop/Flanken auf CPU-Zeit',
    Math.abs(pdevNs() - b.ns) < 1000 && Math.abs(scope.now - b.ns) < 1000 && Math.abs(edgesNow['uart0.tx'] - b.ns) < 1000,
    `${pdevNs()} ${scope.now} ${edgesNow['uart0.tx']} / ${b.ns}`);
  // TAV passt zur Zeit seit dem letzten Timer-Interrupt (Raster 1 ms ab irq1)
  const since = (b.ns - irq1) % MS;
  check('Viele Schritte: Timerzähler passt zur CPU-Zeit (TAV = TAILR - 16·t)', Math.abs(b.tav - (TAILR - (since * 16) / 1000)) <= 32,
    `TAV=${b.tav}, erwartet ${(TAILR - (since * 16) / 1000).toFixed(0)}`);
  check('Viele Schritte: Zeit steht zwischen den Schritten', await (async () => { const t = now(); await sleep(800); return now() === t; })());

  // ---- 7. Weiter ------------------------------------------------------------------------------
  const rxBefore = edges['uart0.rx'].length;
  send({ type: 'continue' });
  check('Weiter -> läuft', await waitFor(() => !sim.stopped && sim.cpu.state === 'Running', 3000), sim.cpu.state);
  check('Weiter: Pendel läuft wieder (frozen=false, Zeit steigt)', await waitFor(() => pdev && !pdev.frozen && pdevNs() > b.ns + 50 * MS, 5000));
  check('Weiter: Terminal empfängt wieder', await waitFor(() => lower() > lowA + 2 + (b.zeichen - a.zeichen), 5000));
  check('Tastendruck aus der Pause: U0RX-Flanken erst ab dem Haltezeitpunkt (kamen mit den Schritten)',
    edges['uart0.rx'].length >= 2 && edges['uart0.rx'].every(([t]) => t >= p0.ns && t <= b.ns), `${edges['uart0.rx'].length} Flanken`);
  void rxBefore;
  await sleep(1000);
  await sleep(1000);
  send({ type: 'pause' });
  await waitFor(() => sim.cpu.state === 'Paused', 3000);
  await sleep(700);
  const r1 = snap();
  check('Weiter + Pause: Timer lief synchron weiter (Δtakte = Δt)', r1.ns > b.ns && Math.abs(r1.takte - b.takte - (r1.ns - b.ns) / MS) <= 1,
    `Δtakte=${r1.takte - b.takte}, Δt=${((r1.ns - b.ns) / MS).toFixed(2)} ms`);
  send({ type: 'continue' });
  await waitFor(() => sim.cpu.state === 'Running', 3000);

  // ---- 8. Lange Schlafphase: Schritt wartet sichtbar ("Wake"), alles läuft mit ---------------
  const sMark = uart.length;
  u.send('s');
  check('Timer aus (Antwort S)', await waitFor(() => uart.slice(sMark).includes('S'), 5000));
  send({ type: 'pendulum', frequency: 0.1 }); // Sync-Flanke nur alle 5 s
  check('Pendel 0,1 Hz', await waitFor(() => pd && pd.periodUs === 10000000, 10000), pd && pd.periodUs);
  await sleep(300);
  send({ type: 'pause' });
  await waitFor(() => sim.cpu.state === 'Paused', 3000);
  await sleep(300);
  // Bis direkt hinter einen Mittendurchgang gehen: dann sind es 5 s bis zum nächsten Interrupt
  let phi = pdev.now[1] / 10000;
  if ((Math.ceil(phi) - phi) * 5e6 < 3e6) {
    await step(1, 30000);
    await stepUntilAsleep();
  }
  const w0 = snap();
  phi = pdev.now[1] / 10000;
  const restUs = (Math.ceil(phi) - phi) * 5e6;
  const takteW = w0.takte;
  const n0 = simCount;
  send({ type: 'step', count: 1 });
  check('Schritt bei langem Schlaf: Zustand "Wake" (Simulation läuft bis zum Interrupt)', await waitFor(() => simCount > n0 && sim.cpu.state === 'Wake', 5000), sim.cpu.state);
  check('Wake: Pendel läuft mit (frozen=false, Zeit steigt)', await waitFor(() => pdev && !pdev.frozen && pdevNs() > w0.ns + 100 * MS, 5000));
  check('Wake: hält am Sync-Interrupt an', await waitFor(() => sim.cpu.state === 'Step', 30000) && /^GPIOL_Handler/.test(sim.cpu.symbol || ''), `${sim.cpu.state} ${sim.cpu.symbol}`);
  await sleep(600);
  s = snap();
  // phi kommt in 1/10000 halber Schwingung (hier 500 us) – genau ist die Sync-Flanke am Oszilloskop
  const syncEdge = scopeEv.filter(([p, t]) => p === 'PL0' && t > w0.ns && t <= s.ns).pop();
  check('Wake: angehalten beim Mittendurchgang des Pendels (Phase)', Math.abs((s.ns - w0.ns) / 1000 - restUs) < 300, `${((s.ns - w0.ns) / 1000).toFixed(0)} us, erwartet ${restUs.toFixed(0)} us`);
  check('Wake: angehalten direkt nach der Sync-Flanke PL0 (< 20 us)', syncEdge && s.ns - syncEdge[1] >= 0 && s.ns - syncEdge[1] < 20000,
    syncEdge ? `${(s.ns - syncEdge[1]) / 1000} us` : 'keine Flanke');
  check('Wake: Pendel danach wieder angehalten (frozen)', await waitFor(() => pdev.frozen && Math.abs(pdevNs() - s.ns) < 1000, 2000));
  check('Wake: Timer stand still (takte unverändert)', s.takte === takteW);

  // Pause während "Wake", dann Weiter: darf beim nächsten Interrupt NICHT anhalten
  await stepUntilAsleep();
  const n1 = simCount;
  send({ type: 'step', count: 1 });
  await waitFor(() => simCount > n1 && sim.cpu.state === 'Wake', 5000);
  send({ type: 'pause' });
  check('Pause während Wake -> angehalten', await waitFor(() => sim.cpu.state === 'Paused', 3000), sim.cpu.state);
  const syncP = snap().sync;
  send({ type: 'continue' });
  check('Weiter nach Wake-Pause -> läuft', await waitFor(() => sim.cpu.state === 'Running', 3000), sim.cpu.state);
  check('Weiter: läuft über den nächsten Interrupt hinweg (kein Rest-Halt)', await waitFor(() => vars().sync > syncP, 15000) && sim.cpu.state === 'Running',
    `${sim.cpu.state} sync ${syncP} -> ${vars().sync}`);

  // Aufräumen: Timer wieder an, Pendel 10 Hz
  u.send('g');
  send({ type: 'pendulum', frequency: 10 });
  check('Timer wieder an (Antwort G)', await waitFor(() => uart.includes('G'), 15000));

  check('keine Fehlermeldungen vom Backend', errors.length === 0, errors.join('; '));
  check('keine Warnungen von Renode', !sim.warnings || sim.warnings.length === 0, JSON.stringify(sim.warnings));
  send({ type: 'scope', sources: [] });
  send({ type: 'watch', sim: false });
  u.close();
  c.close();
  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
