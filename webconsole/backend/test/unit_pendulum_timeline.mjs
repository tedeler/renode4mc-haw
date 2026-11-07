#!/usr/bin/env node
// Unit-Test der Wiedergabeuhr des Pendeldisplays (frontend/src/components/pendulumTimeline.js)
// ohne Browser und ohne Renode:
//   node test/unit_pendulum_timeline.mjs
//
// Prüft, dass die Anzeige bei angehaltener Simulation (Pause, Einzelschritt) genau den Zeitpunkt
// der CPU zeigt und nach "Weiter" ohne Zeitlupe und ohne Sprung wieder anläuft.
import { Timeline, DELAY_US } from '../../frontend/src/components/pendulumTimeline.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}

const P = 100000; // Periode 100 ms (10 Hz)
const POLL = 100000; // Backend sendet alle 100 ms (Wanduhr) ein pdev
const FRAME = 16667; // 60 Bilder/s
const phiQ = (t) => Math.round((((2 * t) / P) % 2) * 10000);
const ledsAt = (t) => Math.floor(t / 1000) & 0xff; // LED-Zustand wechselt jede ms

function scenario() {
  const tl = new Timeline();
  const st = { tl, wall: 0, t: 0, T: null, lastLed: 0 };
  // Eine Poll-Runde: Daten (mit LED-Wechseln seit der letzten Runde) + 6 Bilder
  st.round = (dt, frozen, onFrame) => {
    const ev = [];
    if (dt > 0) {
      for (let x = Math.floor(st.t / 1000) * 1000 + 1000; x <= st.t + dt; x += 1000) ev.push([x, phiQ(x), ledsAt(x), P]);
    }
    st.t += dt;
    st.wall += POLL;
    tl.add({ now: [st.t, phiQ(st.t), ledsAt(st.t), P], ev, frozen }, st.wall);
    for (let f = 0; f < 6; f++) {
      const T = tl.displayTime(st.wall + f * FRAME);
      if (onFrame) onFrame(T, st.wall + f * FRAME);
      st.T = T;
    }
  };
  return st;
}

// --- 1. Laufende Simulation in Echtzeit: Anzeige stetig, etwa DELAY_US hinter der Simulation ---
{
  const st = scenario();
  for (let i = 0; i < 100; i++) st.round(POLL, false);
  const lag = st.t - st.T;
  check('Laufend: Anzeige hinter der Simulation (0,1 .. 0,4 s)', lag > 100000 && lag < DELAY_US + 100000, `${(lag / 1000).toFixed(0)} ms`);
  check('Laufend: Rate der Simulation ≈ 1', Math.abs(st.tl.simRate - 1) < 0.05, st.tl.simRate.toFixed(3));
  check('Laufend: nicht angehalten', st.tl.frozen === false);
}

// --- 2. Pause: sofort genau der Zeitpunkt der CPU, bleibt stehen ---
const st = scenario();
for (let i = 0; i < 100; i++) st.round(POLL, false);
const tPause = st.t;
{
  let firstT = null;
  st.round(0, true, (T) => {
    if (firstT === null) firstT = T;
  });
  check('Pause: erstes Bild zeigt den Haltezeitpunkt der CPU', firstT === tPause, `T=${firstT} CPU=${tPause}`);
  let moved = false;
  for (let i = 0; i < 50; i++) st.round(0, true, (T) => (moved = moved || T !== tPause));
  check('Pause: 5 s Wanduhr – Anzeige bewegt sich nicht', !moved && st.T === tPause);
  const a = st.tl.at(st.T);
  check('Pause: LED-Zustand der Anzeige = LED-Zustand der CPU', a.leds === ledsAt(tPause), `${a.leds} / ${ledsAt(tPause)}`);
  check('Pause: Phase der Anzeige = Phase der CPU', Math.abs(a.phi - phiQ(tPause) / 10000) < 1e-6, `${a.phi} / ${phiQ(tPause) / 10000}`);
  check('Pause: keine Echtzeit-Rate (Anzeige "angehalten")', st.tl.simRate === null && st.tl.frozen === true);
}

// --- 3. Einzelschritte: Anzeige folgt jedem Schritt exakt ---
{
  let ok = true;
  let detail = '';
  for (const d of [1, 1, 3, 17, 91, 1000, 2500, 50000]) {
    st.round(d, true);
    // ein paar Runden ohne Änderung (Benutzer schaut)
    for (let i = 0; i < 3; i++) st.round(0, true);
    if (st.T !== st.t || st.tl.at(st.T).leds !== ledsAt(st.t)) {
      ok = false;
      detail = `nach +${d} us: T=${st.T} CPU=${st.t}`;
    }
  }
  check('Einzelschritt: Anzeige = Zeit und LEDs der CPU nach jedem Schritt (1 us .. 50 ms)', ok, detail);
}

// --- 4. Weiter: stetig anlaufen, keine Zeitlupe, kein Sprung, Rate neu gemessen ---
{
  let prev = st.T;
  let backwards = false;
  let maxJump = 0;
  const speeds = [];
  for (let i = 1; i <= 80; i++) {
    const before = st.T;
    st.round(POLL, false, (T) => {
      if (T < prev) backwards = true;
      maxJump = Math.max(maxJump, T - prev);
      prev = T;
    });
    speeds.push((st.T - before) / POLL);
    if (i === 15) check('Weiter: Rate nach 1,5 s neu gemessen (≈ 1, nicht von der Pause verfälscht)', Math.abs(st.tl.simRate - 1) < 0.1, st.tl.simRate.toFixed(3));
  }
  check('Weiter: Anzeige läuft nie rückwärts', !backwards);
  check('Weiter: kein Sprung (höchstens 2 Bilder Echtzeit je Bild)', maxJump <= 2 * FRAME, `${maxJump.toFixed(0)} us`);
  const later = speeds.slice(5);
  const minSp = Math.min(...later);
  const maxSp = Math.max(...later);
  check('Weiter: ab 0,5 s Geschwindigkeit 0,8 .. 1,3 (keine Zeitlupe, kein Aufholsprint)', minSp > 0.8 && maxSp < 1.3, `${minSp.toFixed(2)} .. ${maxSp.toFixed(2)}`);
  const lag = st.t - st.T;
  check('Weiter: danach wieder normal hinter der Simulation', lag > 100000 && lag < DELAY_US + 100000, `${(lag / 1000).toFixed(0)} ms`);
  check('Weiter: nicht mehr angehalten', st.tl.frozen === false);
}

// --- 5. Pause während die Anzeige noch hinterherläuft: Sprung genau auf die CPU-Zeit ---
{
  const s2 = scenario();
  for (let i = 0; i < 30; i++) s2.round(POLL, false);
  const behind = s2.t - s2.T;
  s2.round(0, true);
  check('Pause aus dem Lauf: Anzeige springt auf die CPU-Zeit (statt 0,3 s nachzulaufen)', s2.T === s2.t && behind > 50000, `vorher ${(behind / 1000).toFixed(0)} ms dahinter`);
}

// --- 6. Neustart von Renode (Zeit beginnt wieder bei 0) im angehaltenen Zustand ---
{
  const s3 = scenario();
  for (let i = 0; i < 20; i++) s3.round(POLL, false);
  s3.round(0, true);
  const gen = s3.tl.generation;
  s3.t = 0;
  s3.round(5000, false);
  check('Neustart: Zeitlinie neu (generation+1), Anzeige im neuen Zeitraum', s3.tl.generation === gen + 1 && s3.T <= 5000, `T=${s3.T}`);
}

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
