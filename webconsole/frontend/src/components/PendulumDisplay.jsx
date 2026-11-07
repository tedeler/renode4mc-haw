import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';
import ScaleBox from '../layout/ScaleBox.jsx';
import { Timeline } from './pendulumTimeline.js';

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
const MAX_ARC_STEP = 0.03; // Leuchtspur in Stücken von höchstens so viel Winkel (rad) zeichnen

// Nachleuchtdauer: Regler logarithmisch von 1 ms bis 1 s
const AFTERGLOW_MIN_MS = 1;
const AFTERGLOW_MAX_MS = 1000;
// Standard: lange Nachleuchtdauer, damit sofort ein stehendes Bild zu sehen ist (wie für das Auge
// beim echten Pendel). Je Versuch einstellbar über "afterglowMs" in der Versuchs-JSON.
const AFTERGLOW_DEFAULT_MS = 1000;
const sliderToMs = (v) => AFTERGLOW_MIN_MS * (AFTERGLOW_MAX_MS / AFTERGLOW_MIN_MS) ** (v / 1000);
const msToSlider = (ms) => (1000 * Math.log(ms / AFTERGLOW_MIN_MS)) / Math.log(AFTERGLOW_MAX_MS / AFTERGLOW_MIN_MS);

const VIEWS = [
  { id: 'both', label: 'Leuchtspur, beide Schwünge' },
  { id: 'lr', label: 'Leuchtspur, nur links → rechts' },
  { id: 'rl', label: 'Leuchtspur, nur rechts → links' },
  { id: 'still', label: 'Standbild (letzter Schwung je Richtung)' },
];

const ledRadius = (led) => R_TIP - led * ROW_STEP;
// Winkel theta (0 = senkrecht nach oben, positiv = nach rechts) -> Canvas-Winkel
const canvasAngle = (theta) => theta - Math.PI / 2;
const thetaOf = (phi) => THETA_MAX * Math.sin(Math.PI * phi);

const fmt = (v, digits = 1) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPeriod = (hz) => (hz < 1 ? `${fmt(1 / hz, 1)} s` : `${fmt(1000 / hz, 1)} ms`);
const fmtMs = (ms) => (ms < 10 ? `${fmt(ms, 1)} ms` : `${fmt(ms, 0)} ms`);

/** Hintergrund: Schwenkbereich und dunkle LED-Bahnen */
function drawBackground(ctx) {
  const cx = W / 2;
  const a0 = canvasAngle(-THETA_MAX);
  const a1 = canvasAngle(THETA_MAX);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
  ctx.beginPath();
  ctx.arc(cx, PIVOT_Y, R_TIP + 9, a0, a1);
  ctx.arc(cx, PIVOT_Y, ledRadius(7) - 9, a1, a0, true);
  ctx.closePath();
  ctx.fill();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(255, 84, 64, 0.05)';
  ctx.lineWidth = ROW_STEP * 0.7;
  for (let led = 0; led < 8; led++) {
    ctx.beginPath();
    ctx.arc(cx, PIVOT_Y, ledRadius(led), a0, a1);
    ctx.stroke();
  }
}

/**
 * Standbild aus dem Modell: je Schwungrichtung, welche LEDs beim letzten Überstreichen eines
 * Winkelstücks an waren (wie eine Langzeitbelichtung, ohne Abklingen).
 */
function drawStill(ctx, pd) {
  ctx.clearRect(0, 0, W, H);
  if (!pd) return;
  const cx = W / 2;
  const n = pd.columns;
  const half = THETA_MAX / n; // halbe Winkelbreite einer Spalte
  ctx.lineCap = 'butt';
  ctx.lineWidth = ROW_STEP * 0.7;
  for (let led = 0; led < 8; led++) {
    const r = ledRadius(led);
    const bit = 1 << led;
    for (let c = 0; c < n; c++) {
      const level = ((pd.lr[c] & bit ? 1 : 0) + (pd.rl[c] & bit ? 1 : 0)) / 2;
      if (!level) continue;
      const mid = canvasAngle(-THETA_MAX + (2 * THETA_MAX * (c + 0.5)) / n);
      ctx.strokeStyle = `rgba(${LED_RGB}, ${level})`;
      ctx.beginPath();
      ctx.arc(cx, PIVOT_Y, r, mid - half * 1.05, mid + half * 1.05);
      ctx.stroke();
    }
  }
}

/**
 * Leuchtspur: Die Ebene behält, was die LEDs gezeichnet haben, und klingt mit jedem Bild
 * exponentiell ab (nach der eingestellten Nachleuchtdauer auf unter 5 %). Neu hinzu kommt nur
 * der Zeitraum seit dem letzten Bild: Für jeden Abschnitt mit gleichem LED-Zustand werden die
 * Bögen gezeichnet, die die leuchtenden LEDs überstrichen haben, mit der Helligkeit, die zu
 * ihrem Alter passt.
 */
class Afterglow {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.lastT = null;
    this.generation = -1;
  }

  clear() {
    this.ctx.clearRect(0, 0, W, H);
    this.lastT = null;
  }

  update(timeline, T, afterglowUs, view) {
    const ctx = this.ctx;
    const tau = afterglowUs / 3; // nach der Nachleuchtdauer: e^-3 = 5 %
    if (this.generation !== timeline.generation) {
      this.generation = timeline.generation;
      this.clear();
    }
    let from = this.lastT;
    if (from === null || T < from || T - from > 3 * afterglowUs) {
      // Anfang, Sprung oder lange Pause: nur das sichtbare Zeitfenster neu zeichnen
      ctx.clearRect(0, 0, W, H);
      from = T - 3 * afterglowUs;
    } else if (T > from) {
      // Vorhandenes abklingen lassen
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-(T - from) / tau)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    this.lastT = T;
    if (T <= from) return;

    const cx = W / 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = ROW_STEP * 0.62;
    timeline.forEachSegment(from, T, (a, b, p) => {
      if (!p.leds) return;
      // Stücklänge: höchstens MAX_ARC_STEP Winkel und höchstens tau/4 Zeit
      const omegaMax = (THETA_MAX * Math.PI * 2) / p.period; // rad pro us
      const step = Math.max(1, Math.min(MAX_ARC_STEP / omegaMax, tau / 4));
      for (let t0 = a; t0 < b; t0 += step) {
        const t1 = Math.min(b, t0 + step);
        const th0 = thetaOf(timeline.phiAt(p, t0));
        const th1 = thetaOf(timeline.phiAt(p, t1));
        const toRight = th1 >= th0;
        if ((view === 'lr' && !toRight) || (view === 'rl' && toRight)) continue;
        const alpha = Math.exp(-(T - (t0 + t1) / 2) / tau);
        if (alpha < 0.02) continue;
        ctx.strokeStyle = `rgba(${LED_RGB}, ${alpha})`;
        const lo = canvasAngle(Math.min(th0, th1));
        const hi = canvasAngle(Math.max(th0, th1));
        for (let led = 0; led < 8; led++) {
          if (!((p.leds >> led) & 1)) continue;
          ctx.beginPath();
          ctx.arc(cx, PIVOT_Y, ledRadius(led), lo, hi);
          ctx.stroke();
        }
      }
    });
  }
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
 * Pendeldisplay (POV): schwingender Stab mit LEDs und deren Leuchtspur, die nach der eingestellten
 * Nachleuchtdauer verschwindet; dazu die Einstellung der Pendelfrequenz.
 * Stab, LEDs und Leuchtspur werden aus den LED-Wechseln der Simulation (mit virtueller Zeit und
 * Phase, 10-mal pro Sekunde gesammelt) 200 ms verzögert, aber zeitlich exakt wiedergegeben.
 * Frequenz-Regler -> {type:"pendulum", frequency} -> Backend -> Monitor "<pendel> PeriodUs <us>"
 * (gedrosselt wie beim Distanzsensor; nach (Re-)Connect wird der Wert erneut gesetzt).
 */
export default function PendulumDisplay({
  label,
  frequency = 10,
  minFrequency = frequency,
  maxFrequency = frequency,
  afterglowMs: initialAfterglowMs = AFTERGLOW_DEFAULT_MS,
}) {
  const startAfterglow = Math.min(AFTERGLOW_MAX_MS, Math.max(AFTERGLOW_MIN_MS, initialAfterglowMs));
  const { subscribePendulum, subscribePendulumEvents, send, status } = useControlSocket();
  const canvasRef = useRef(null);
  const latest = useRef(null);
  const stillDirty = useRef(true);
  const timeline = useRef(new Timeline());
  const viewRef = useRef('both');
  const afterglowRef = useRef(startAfterglow);
  const [view, setView] = useState('both');
  const [afterglowMs, setAfterglowMs] = useState(startAfterglow);
  const [hz, setHz] = useState(frequency);
  const [modelHz, setModelHz] = useState(null);
  const [simRate, setSimRate] = useState(null);
  const [frozen, setFrozen] = useState(false);

  // Geschwindigkeit der Simulation anzeigen: läuft sie langsamer als Echtzeit, schwingt das Pendel
  // auf dem Bildschirm entsprechend langsamer (die virtuelle Zeit stimmt trotzdem)
  useEffect(() => {
    const iv = setInterval(() => {
      setSimRate(timeline.current.simRate);
      setFrozen(timeline.current.frozen);
    }, 250);
    return () => clearInterval(iv);
  }, []);
  const pending = useRef(null);
  const timer = useRef(null);

  useEffect(
    () =>
      subscribePendulum((pd) => {
        latest.current = pd;
        stillDirty.current = true;
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
    stillDirty.current = true;
  }, [view]);

  useEffect(() => {
    afterglowRef.current = afterglowMs;
  }, [afterglowMs]);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    drawBackground(bg.getContext('2d'));
    const still = document.createElement('canvas');
    still.width = W;
    still.height = H;
    const stillCtx = still.getContext('2d');
    const glow = new Afterglow();
    let lastView = null;
    let raf;

    const loop = () => {
      const tl = timeline.current;
      const T = tl.displayTime();
      const v = viewRef.current;
      if (v !== lastView) {
        glow.clear(); // andere Richtungsauswahl: Spur neu aufbauen
        lastView = v;
      }
      ctx.drawImage(bg, 0, 0);

      if (v === 'still') {
        if (stillDirty.current) {
          stillDirty.current = false;
          drawStill(stillCtx, latest.current);
        }
        ctx.drawImage(still, 0, 0);
      } else if (T !== null) {
        glow.update(tl, T, afterglowRef.current * 1000, v);
        ctx.drawImage(glow.canvas, 0, 0);
      }

      let theta = 0;
      let leds = 0;
      if (T !== null) {
        const now = tl.at(T);
        theta = thetaOf(now.phi);
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
      <ScaleBox maxScale={1.8} minH={160} flowMaxH={420}>
        <div className="pendulum-stage">
          <canvas ref={canvasRef} width={W} height={H} className="pendulum-canvas" />
        </div>
      </ScaleBox>
      <div className="pendulum-controls">
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
        <label className="pendulum-freq">
          <span>
            Nachleuchten <b>{fmtMs(afterglowMs)}</b>{' '}
            <span className="meta" title="So lange bleibt ein Leuchtpunkt sichtbar; das Auge: ca. 50–100 ms">
              (Auge: ca. 50–100 ms)
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(msToSlider(afterglowMs))}
            onChange={(e) => setAfterglowMs(sliderToMs(Number(e.target.value)))}
            className="sensor-range"
            aria-label="Nachleuchtdauer"
            disabled={view === 'still'}
          />
        </label>
      </div>
      <div className="pendulum-foot">
        <span className="meta">
          Modell: {modelHz ? `${fmt(modelHz, 2)} Hz` : '–'} ·{' '}
          {frozen ? 'Simulation angehalten: Anzeige zeigt den Zeitpunkt der CPU' : 'Anzeige 0,3 s hinter der Simulation'}
          {simRate !== null && Math.abs(simRate - 1) > 0.1 && (
            <span
              className="pendulum-slow"
              title="Renode rechnet nicht in Echtzeit – das Pendel schwingt auf dem Bildschirm entsprechend langsamer bzw. schneller, die Zeiten in der Firmware stimmen trotzdem."
            >
              {' '}
              · Simulation: {fmt(simRate * 100, 0)} % Echtzeit
            </span>
          )}
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
