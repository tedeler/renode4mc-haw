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
 * Die Lage des Stabs kommt als Phase mit jedem Frame (10/s) und wird dazwischen fortgeschrieben.
 */
export default function PendulumDisplay({ label, frequency = 10, minFrequency = frequency, maxFrequency = frequency }) {
  const { subscribePendulum, send, status } = useControlSocket();
  const canvasRef = useRef(null);
  const latest = useRef(null);
  const motion = useRef(null); // { phase (halbe Schwingungen), t0 (ms), periodUs, leds }
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
        if (pd.periodUs) {
          setModelHz(1e6 / pd.periodUs);
          motion.current = { phase: pd.phase / 10000, t0: performance.now(), periodUs: pd.periodUs, leds: pd.leds };
        }
      }),
    [subscribePendulum],
  );

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

      const m = motion.current;
      let theta = 0;
      let leds = 0;
      if (m) {
        // Phase fortschreiben: eine halbe Schwingung dauert periodUs / 2
        const phase = m.phase + ((performance.now() - m.t0) * 2000) / m.periodUs;
        theta = THETA_MAX * Math.sin(Math.PI * phase);
        leds = m.leds;
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
