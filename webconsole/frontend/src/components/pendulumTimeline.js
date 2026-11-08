// Wiedergabeuhr des Pendeldisplays (ohne DOM, damit sie sich mit node testen lässt:
// webconsole/backend/test/unit_pendulum_timeline.mjs)

// Pause gedrückt, aber nach dieser Zeit noch keine angehaltene Simulation gemeldet: weiterlaufen
const HOLD_TIMEOUT_US = 2000000;
export const DELAY_US = 300000; // Wiedergabe so weit hinter der Simulation (Daten kommen 10-mal pro Sekunde, Renode stockt mitunter ~100 ms)
// Wiedergabeuhr: Renode treibt die virtuelle Zeit ungleichmäßig voran (pro 100 ms Wanduhr mal 0,3 ms,
// mal 150 ms). Die angezeigte Zeit läuft deshalb mit eigener, stetiger Geschwindigkeit: Grundrate =
// gemessene Rate der Simulation über RATE_WINDOW_US, Abstand zum Soll wird über CATCHUP_US sanft
// ausgeglichen (höchstens ±MAX_CORR). Erst ab SNAP_US Abstand (Neustart, Tab im Hintergrund) springt sie.
const RATE_WINDOW_US = 3e6;
const CATCHUP_US = 1e6;
const MAX_CORR = 0.25;
const SNAP_US = 1e6;
const SPEED_TAU_US = 150000; // Geschwindigkeitsänderungen werden so weich gefiltert
const SOFT_US = 80000; // so knapp vor dem Ende der Daten wird sanft abgebremst statt hart angehalten

/**
 * Zeitlinie der Simulation für die Wiedergabe: Stützstellen (virtuelle Zeit t in us, Phase phi in
 * halben Schwingungen, LED-Zustand, Periode). Zwischen zwei Stützstellen läuft die Phase
 * gleichmäßig mit 2/Periode weiter; der LED-Zustand gilt bis zur nächsten Stützstelle.
 */
export class Timeline {
  constructor() {
    this.s = [];
    this.generation = 0; // zählt Neustarts von Renode
    this.hist = []; // Ankunft der Nachrichten: { wall, t } für die Rate der Simulation
    this.T = null; // angezeigte virtuelle Zeit
    this.wallPrev = null;
    this.speed = 1; // aktuelle Wiedergabegeschwindigkeit (virtuelle je Wanduhrzeit)
    this.frozen = false; // Simulation angehalten (Pause/Einzelschritt)
    this.holdT = null; // angehalten: Anzeige bleibt auf dieser Zeit stehen (bis zum ersten Schritt)
    this.frozenCpuT = null; // Zeit der CPU beim Anhalten
    this.holdSince = null; // Pause gedrückt (Wanduhr), Antwort der Simulation steht noch aus
  }

  /**
   * Pause wurde gedrückt: Anzeige sofort an der Stelle anhalten, an der sie gerade ist (nicht erst,
   * wenn die Simulation steht, und nicht auf die ~0,3 s vorauslaufende CPU-Zeit springen).
   */
  hold(wall = performance.now() * 1000) {
    if (this.frozen || this.T === null) return;
    this.holdT = this.T;
    this.holdSince = wall;
  }

  add(msg, wall = performance.now() * 1000) {
    if (msg.type === 'pausing') {
      this.hold(wall);
      return;
    }
    const [t, phiQ, leds, periodUs] = msg.now;
    const last = this.s[this.s.length - 1];
    if (last && t < last.t) {
      this.s = []; // Renode neu gestartet: Zeit beginnt bei 0
      this.hist = [];
      this.T = null;
      this.generation++;
    }
    // Angehalten: Die Anzeige bleibt, wo sie ist (sie läuft der CPU ~0,3 s hinterher). Ein Schritt
    // (CPU-Zeit ändert sich) zeigt danach genau den Zustand der CPU. Die Rate der Simulation wird
    // nach "Weiter" neu gemessen – die Pause darf sie nicht verfälschen.
    const frozen = !!msg.frozen;
    if (frozen && !this.frozen) {
      if (this.holdT === null) this.holdT = this.T;
      this.frozenCpuT = t;
    } else if (frozen && t !== this.frozenCpuT) {
      this.holdT = null; // Schritt: ab jetzt Zeit der CPU
    }
    if (!frozen) {
      this.frozenCpuT = null;
      // Pause gedrückt, aber die Simulation hält nicht an (z. B. Fehler): nicht ewig festhalten
      if (this.frozen || (this.holdSince !== null && wall - this.holdSince > HOLD_TIMEOUT_US)) {
        this.holdT = null;
        this.holdSince = null;
      }
    } else {
      this.holdSince = null;
    }
    if (frozen || this.frozen) this.hist = [];
    this.frozen = frozen;
    if (!frozen) this.hist.push({ wall, t });
    while (this.hist.length > 2 && wall - this.hist[1].wall > RATE_WINDOW_US) this.hist.shift();
    for (const [et, ep, el, eper] of msg.ev) this.s.push({ t: et, phi: ep / 10000, leds: el, period: eper });
    this.s.push({ t, phi: phiQ / 10000, leds, period: periodUs });
    // Ältere Stützstellen als 3 s (virtuell) verwerfen, eine davor behalten
    const keepFrom = t - 3e6;
    let i = 0;
    while (i < this.s.length - 1 && this.s[i + 1].t < keepFrom) i++;
    if (i) this.s.splice(0, i);
  }

  get lastT() {
    return this.s.length ? this.s[this.s.length - 1].t : 0;
  }

  /** Index der letzten Stützstelle mit Zeit <= t (0, falls t davor liegt) */
  index(t) {
    const s = this.s;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  phiAt(p, t) {
    return p.phi + ((t - p.t) * 2) / p.period;
  }

  /** Lage (phi) und LED-Zustand zur virtuellen Zeit t */
  at(t) {
    const p = this.s[this.index(t)];
    return { phi: this.phiAt(p, Math.max(t, p.t)), leds: p.leds };
  }

  /** Abschnitte mit gleichem LED-Zustand im Zeitraum [t0, t1]: Aufruf fn(a, b, stützstelle) */
  forEachSegment(t0, t1, fn) {
    const s = this.s;
    for (let i = this.index(t0); i < s.length; i++) {
      const a = Math.max(t0, s[i].t);
      const b = Math.min(t1, i + 1 < s.length ? s[i + 1].t : t1);
      if (a >= t1) break;
      if (b > a) fn(a, b, s[i]);
    }
  }

  /**
   * Ausgleichsgerade virtuelle Zeit über Wanduhrzeit für die letzten Sekunden:
   * rate = virtuelle je Wanduhrzeit (1 = Echtzeit), at(wall) = geschätzte Simulationszeit.
   */
  clock() {
    const h = this.hist;
    const last = h[h.length - 1];
    const span = last.wall - h[0].wall;
    if (h.length < 3 || span < 0.5e6) return { rate: 1, lag: DELAY_US, at: (w) => last.t + (w - last.wall) };
    let mw = 0;
    let mt = 0;
    for (const p of h) {
      mw += p.wall;
      mt += p.t;
    }
    mw /= h.length;
    mt /= h.length;
    let cov = 0;
    let vw = 0;
    for (const p of h) {
      cov += (p.wall - mw) * (p.t - mt);
      vw += (p.wall - mw) ** 2;
    }
    const rate = Math.min(5, Math.max(0.02, cov / vw));
    const at = (w) => mt + (w - mw) * rate;
    // Abstand hinter der Geraden: so viel, dass auch Schübe der Simulation (Daten kommen stoßweise)
    // aufgefangen werden, mindestens DELAY_US Wanduhrzeit
    let behind = 0;
    for (const p of h) behind = Math.max(behind, at(p.wall) - p.t);
    const lag = Math.max(rate * DELAY_US, 1.5 * behind + rate * 100000);
    return { rate, lag, at };
  }

  /** Geschwindigkeit der Simulation (1 = Echtzeit), für die Anzeige */
  get simRate() {
    return this.frozen || this.hist.length < 3 ? null : this.clock().rate;
  }

  /**
   * Virtuelle Zeit, die jetzt angezeigt wird: etwa DELAY_US hinter der Simulation, nie über die Daten
   * hinaus. Einmal pro Bild aufrufen – die Uhr läuft stetig weiter (keine Sprünge bei jeder Nachricht).
   * Pause: bleibt stehen, wo sie gerade ist. Einzelschritt: genau die Zeit der CPU, damit Pendel und
   * LEDs zum Zustand der Firmware passen. Nach "Weiter" läuft die Wiedergabe aus dem Stand wieder an.
   */
  displayTime(wall = performance.now() * 1000) {
    if (!this.s.length) return null;
    if (this.frozen || this.holdT !== null) {
      this.T = this.holdT !== null ? Math.min(this.holdT, this.lastT) : this.lastT;
      this.wallPrev = wall;
      this.speed = 0;
      return this.T;
    }
    const clock = this.clock();
    const target = clock.at(wall) - clock.lag;
    if (this.T === null || Math.abs(target - this.T) > SNAP_US) {
      this.T = target;
    } else {
      const dt = Math.max(0, wall - this.wallPrev);
      const corr = Math.max(-MAX_CORR, Math.min(MAX_CORR, (target - this.T) / (CATCHUP_US * clock.rate)));
      const lead = this.lastT - this.T; // Vorrat an Daten
      const brake = Math.max(0, Math.min(1, lead / (SOFT_US * clock.rate)));
      const want = clock.rate * (1 + corr) * brake;
      this.speed += (want - this.speed) * Math.min(1, dt / SPEED_TAU_US);
      this.T += dt * this.speed;
    }
    this.wallPrev = wall;
    this.T = Math.min(this.T, this.lastT);
    return this.T;
  }
}
