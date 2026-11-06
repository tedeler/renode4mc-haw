import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

// Stehendes Pendel (wie ein Metronom): Drehpunkt UNTEN, die LEDs sitzen oben am Stab.
// LED 0 ist die oberste (an der Spitze), LED 7 die unterste.
const W = 520;
const H = 400;
const PIVOT_Y = H - 18; // Drehpunkt
const R_TIP = 352; // Abstand Drehpunkt -> LED 0 (Spitze)
const ROW_STEP = 13; // Abstand der LEDs auf dem Stab
const THETA_MAX = (30 * Math.PI) / 180; // größte Auslenkung (Winkel)
const LED_RGB = '255, 84, 64';
const ROD_COLOR = '#4b5058'; // dunkelgrau vor schwarzem Grund
const DELAY_US = 200000; // Wiedergabe so weit hinter der Simulation (Daten kommen 10-mal pro Sekunde)
const FADE_US = 10000; // Leuchtpunkte der Stab-LEDs verblassen in 10 ms
const TRAIL_STEP_US = 100; // Abtastschritt der Leuchtspur

/**
 * Zeitlinie der Simulation für die Wiedergabe: Stützstellen (virtuelle Zeit t in us, Phase phi in
 * halben Schwingungen, LED-Zustand, Periode). Zwischen zwei Stützstellen läuft die Phase
 * gleichmäßig mit 2/Periode weiter; der LED-Zustand gilt bis zur nächsten Stützstelle.
 */
class Timeline {
  constructor() {
    this.s = [];
    this.offset = null; // Wanduhr (us) - virtuelle Zeit (us)
  }

  add(msg) {
    const wall = performance.now() * 1000;
    const [t, phiQ, leds, periodUs] = msg.now;
    const last = this.s[this.s.length - 1];
    if (last && t < last.t) this.s = []; // Renode neu gestartet: Zeit beginnt bei 0
    const measured = wall - t;
    if (this.offset === null || !this.s.length || Math.abs(measured - this.offset) > 1e6) this.offset = measured;
    else this.offset += 0.05 * (measured - this.offset); // Schwankungen der Übertragung glätten
    for (const [et, ep, el, eper] of msg.ev) this.s.push({ t: et, phi: ep / 10000, leds: el, period: eper });
    this.s.push({ t, phi: phiQ / 10000, leds, period: periodUs });
    // Ältere Stützstellen als 2 s (virtuell) verwerfen, eine davor behalten
    const keepFrom = t - 2e6;
    let i = 0;
    while (i < this.s.length - 1 && this.s[i + 1].t < keepFrom) i++;
    if (i) this.s.splice(0, i);
  }

  get lastT() {
    return this.s.length ? this.s[this.s.length - 1].t : 0;
  }

  /** Lage (phi) und LED-Zustand zur virtuellen Zeit t */
  at(t) {
    const s = this.s;
    let lo = 0;
    let hi = s.length - 1;
    if (t <= s[0].t) return { phi: s[0].phi, leds: s[0].leds };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const p = s[lo];
    return { phi: p.phi + ((t - p.t) * 2) / p.period, leds: p.leds };
  }

  /** virtuelle Zeit, die jetzt angezeigt wird (verzögert, nie über die Daten hinaus) */
  displayTime() {
    if (!this.s.length) return null;
    return Math.min(this.lastT, performance.now() * 1000 - this.offset - DELAY_US);
  }
}

const VIEWS = [
  { id: 'both', label: 'Auge (beide Schwünge)' },
  { id: 'lr', label: 'nur links → rechts' },
  { id: 'rl', label: 'nur rechts → links' },
];

const ledRadius = (led) => R_TIP - led * ROW_STEP;
// Winkel theta (0 = senkrecht nach oben, positiv = nach rechts) -> Canvas-Winkel
const canvasAngle = (theta) => theta - Math.PI / 2;

const fmt = (v, digits = 1) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPeriod = (hz) => (hz < 1 ? `${fmt(1 / hz, 1)} s` : `${fmt(1000 / hz, 1)} ms`);

/**
 * Nachleuchtbild (ändert sich nur mit neuen Daten) auf ein eigenes Canvas zeichnen.
 * Spalte = Winkel, LED n = Radius. Helligkeit = Anteil der Schwünge, in denen die LED an dieser
 * Stelle an war (zeichnet die Firmware nur in einer Richtung: halbe Helligkeit).
 */
function drawPersistence(ctx, pd, view) {
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2;
  const a0 = canvasAngle(-THETA_MAX);
  const a1 = canvasAngle(THETA_MAX);

  // Schwenkbereich der LEDs
  ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
  ctx.beginPath();
  ctx.arc(cx, PIVOT_Y, R_TIP + 9, a0, a1);
  ctx.arc(cx, PIVOT_Y, ledRadius(7) - 9, a1, a0, true);
  ctx.closePath();
  ctx.fill();

  ctx.lineCap = 'butt';
  for (let led = 0; led < 8; led++) {
    const r = ledRadius(led);
    ctx.strokeStyle = 'rgba(255, 84, 64, 0.05)';
    ctx.lineWidth = ROW_STEP * 0.7;
    ctx.beginPath();
    ctx.arc(cx, PIVOT_Y, r, a0, a1);
    ctx.stroke();
    if (!pd) continue;

    const n = pd.columns;
    const half = THETA_MAX / n; // halbe Winkelbreite einer Spalte
    const bit = 1 << led;
    for (let c = 0; c < n; c++) {
      const a = pd.lr[c] & bit ? 1 : 0;
      const b = pd.rl[c] & bit ? 1 : 0;
      const level = view === 'lr' ? a : view === 'rl' ? b : (a + b) / 2;
      if (!level) continue;
      const mid = canvasAngle(-THETA_MAX + (2 * THETA_MAX * (c + 0.5)) / n);
      ctx.strokeStyle = `rgba(${LED_RGB}, ${level})`;
      ctx.shadowColor = `rgba(${LED_RGB}, ${0.8 * level})`;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(cx, PIVOT_Y, r, mid - half * 1.05, mid + half * 1.05);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }
}

/**
 * Leuchtspur: Jede LED, die in den letzten 10 ms an war, hinterlässt dort, wo der Stab in dem
 * Moment war, einen Punkt, der mit dem Alter verblasst.
 */
function drawTrail(ctx, timeline, T) {
  const cx = W / 2;
  ctx.save();
  for (let age = FADE_US; age >= 0; age -= TRAIL_STEP_US) {
    const { phi, leds } = timeline.at(T - age);
    if (!leds) continue;
    const theta = THETA_MAX * Math.sin(Math.PI * phi);
    const sx = Math.sin(theta);
    const sy = -Math.cos(theta);
    const alpha = 0.3 * (1 - age / FADE_US); // ältester Punkt fast unsichtbar, jüngster am hellsten
    ctx.fillStyle = `rgba(${LED_RGB}, ${alpha})`;
    for (let led = 0; led < 8; led++) {
      if (!((leds >> led) & 1)) continue;
      const r = ledRadius(led);
      ctx.beginPath();
      ctx.arc(cx + r * sx, PIVOT_Y + r * sy, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Pendelstab in seiner aktuellen Lage, mit dem aktuellen Zustand der LEDs. */
function drawRod(ctx, theta, leds) {
  const cx = W / 2;
  const sx = Math.sin(theta);
  const sy = -Math.cos(theta);
  const at = (r) => [cx + r * sx, PIVOT_Y + r * sy];

  ctx.strokeStyle = ROD_COLOR;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, PIVOT_Y);
  ctx.lineTo(...at(R_TIP + 10));
  ctx.stroke();

  for (let led = 0; led < 8; led++) {
    const [x, y] = at(ledRadius(led));
    const on = (leds >> led) & 1;
    ctx.fillStyle = on ? `rgb(${LED_RGB})` : '#1c1e22';
    if (on) {
      ctx.shadowColor = `rgba(${LED_RGB}, 0.9)`;
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Drehpunkt
  ctx.fillStyle = '#6b7280';
  ctx.beginPath();
  ctx.arc(cx, PIVOT_Y, 7, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(cx, PIVOT_Y, 2.5, 0, 2 * Math.PI);
  ctx.fill();
}

/**
 * Pendeldisplay (POV): zeigt das Nachleuchtbild (was das Auge sieht) und den schwingenden Stab,
 * und stellt die Pendelfrequenz ein.
 * Schieberegler -> {type:"pendulum", frequency} -> Backend -> Monitor "<pendel> PeriodUs <us>"
 * (gedrosselt wie beim Distanzsensor; nach (Re-)Connect wird der Wert erneut gesetzt).
 * Stab, LEDs und Leuchtspur werden aus den LED-Wechseln der Simulation (mit virtueller Zeit und
 * Phase, 10-mal pro Sekunde gesammelt) 200 ms verzögert, aber zeitlich exakt wiedergegeben.
 */
export default function PendulumDisplay({ label, frequency = 10, minFrequency = frequency, maxFrequency = frequency }) {
  const { subscribePendulum, subscribePendulumEvents, send, status } = useControlSocket();
  const canvasRef = useRef(null);
  const latest = useRef(null);
  const timeline = useRef(new Timeline());
  const dirty = useRef(true);
  const viewRef = useRef('both');
  const [view, setView] = useState('both');
  const [frames, setFrames] = useState(0);
  const [hz, setHz] = useState(frequency);
  const [modelHz, setModelHz] = useState(null);
  const pending = useRef(null);
  const timer = useRef(null);

  useEffect(
    () =>
      subscribePendulum((pd) => {
        latest.current = pd;
        dirty.current = true;
        if (pd.periodUs) setModelHz(1e6 / pd.periodUs);
      }),
    [subscribePendulum],
  );

  useEffect(() => subscribePendulumEvents((msg) => timeline.current.add(msg)), [subscribePendulumEvents]);

  const flush = () => {
    timer.current = null;
    if (pending.current !== null) {
      send({ type: 'pendulum', frequency: pending.current });
      pending.current = null;
    }
  };

  const onFrequency = (e) => {
    const v = Number(e.target.value);
    setHz(v);
    pending.current = v;
    if (!timer.current) timer.current = setTimeout(flush, 100);
  };

  // Nach (Re-)Connect, z. B. nach einem Neustart von Renode, die eingestellte Frequenz erneut setzen
  useEffect(() => {
    if (status === 'open') send({ type: 'pendulum', frequency: hz });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const adjustable = maxFrequency > minFrequency;

  useEffect(() => {
    viewRef.current = view;
    dirty.current = true;
  }, [view]);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const layerCtx = layer.getContext('2d');
    let raf;
    let count = 0;
    const loop = () => {
      if (dirty.current) {
        dirty.current = false;
        drawPersistence(layerCtx, latest.current, viewRef.current);
        if (latest.current) setFrames(++count);
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(layer, 0, 0);

      // Stab, LEDs und Leuchtspur zeitgenau aus der Zeitlinie (200 ms hinter der Simulation)
      const tl = timeline.current;
      const T = tl.displayTime();
      let theta = 0;
      let leds = 0;
      if (T !== null) {
        drawTrail(ctx, tl, T);
        const now = tl.at(T);
        theta = THETA_MAX * Math.sin(Math.PI * now.phi);
        leds = now.leds;
      }
      drawRod(ctx, theta, leds);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Widget title="Pendeldisplay" subtitle={label} className="pendulum">
      <div className="pendulum-stage">
        <canvas ref={canvasRef} width={W} height={H} className="pendulum-canvas" />
      </div>
      {adjustable && (
        <label className="pendulum-freq">
          <span>
            Pendelfrequenz <b>{fmt(hz)} Hz</b> <span className="meta">(Periode {fmtPeriod(hz)})</span>
          </span>
          <input
            type="range"
            min={minFrequency}
            max={maxFrequency}
            step={0.1}
            value={hz}
            onChange={onFrequency}
            className="sensor-range"
            aria-label="Pendelfrequenz"
          />
        </label>
      )}
      <div className="pendulum-foot">
        <span className="meta">
          Modell: {modelHz ? `${fmt(modelHz, 2)} Hz` : '–'} · {latest.current?.columns ?? '–'} Winkelschritte ·{' '}
          {frames} Bilder
        </span>
        <select className="pendulum-view" value={view} onChange={(e) => setView(e.target.value)}>
          {VIEWS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
    </Widget>
  );
}
