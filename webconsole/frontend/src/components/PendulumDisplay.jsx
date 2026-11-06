import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

// Langes Pendel, die LEDs sitzen am unteren Ende; der Drehpunkt liegt oberhalb des Bildes.
const W = 520;
const H = 230;
const R_TIP = 540; // Radius der LED an der Pendelspitze (LED 7)
const PIVOT_Y = H - 34 - R_TIP; // negativ: Drehpunkt außerhalb des Bildes
const THETA_MAX = (26 * Math.PI) / 180; // halber Schwenkwinkel
const ROW_STEP = 14; // Abstand der LEDs auf dem Pendel
const LED_RGB = '255, 84, 64';

const VIEWS = [
  { id: 'both', label: 'Auge (beide Schwünge)' },
  { id: 'lr', label: 'nur links → rechts' },
  { id: 'rl', label: 'nur rechts → links' },
];

/**
 * Zeichnet das Nachleuchtbild als Kreisbogen-Fächer: Spalte = Winkel, LED n = Radius
 * (LED 0 am Drehpunkt, LED 7 an der Spitze). Helligkeit = Anteil der Schwünge, in denen die
 * LED an dieser Stelle an war (zeichnet die Firmware nur in einer Richtung: halbe Helligkeit).
 */
function draw(ctx, pd, view) {
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2;

  // Schwenkbereich und Pendelstange (Ruhelage)
  ctx.fillStyle = 'rgba(56, 189, 248, 0.05)';
  ctx.beginPath();
  ctx.arc(cx, PIVOT_Y, R_TIP + 14, Math.PI / 2 + THETA_MAX, Math.PI / 2 - THETA_MAX, true);
  ctx.arc(cx, PIVOT_Y, R_TIP - 8 * ROW_STEP, Math.PI / 2 - THETA_MAX, Math.PI / 2 + THETA_MAX);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(139, 152, 180, 0.2)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, PIVOT_Y + R_TIP + 10);
  ctx.stroke();
  ctx.fillStyle = '#8b98b4';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('↑ Drehpunkt', cx + 6, 12);

  if (!pd) return;
  const n = pd.columns;
  const half = THETA_MAX / n; // halbe Winkelbreite einer Spalte
  ctx.lineCap = 'butt';
  for (let led = 0; led < 8; led++) {
    const r = R_TIP - (7 - led) * ROW_STEP;
    const bit = 1 << led;
    // dunkle LED-Spur
    ctx.strokeStyle = 'rgba(255, 84, 64, 0.06)';
    ctx.lineWidth = ROW_STEP * 0.7;
    ctx.beginPath();
    ctx.arc(cx, PIVOT_Y, r, Math.PI / 2 + THETA_MAX, Math.PI / 2 - THETA_MAX, true);
    ctx.stroke();

    for (let c = 0; c < n; c++) {
      const a = pd.lr[c] & bit ? 1 : 0;
      const b = pd.rl[c] & bit ? 1 : 0;
      const level = view === 'lr' ? a : view === 'rl' ? b : (a + b) / 2;
      if (!level) continue;
      // Spalte c: Winkel von links (-THETA_MAX) nach rechts (+THETA_MAX); Canvas-Winkel 0 = rechts
      const theta = -THETA_MAX + (2 * THETA_MAX * (c + 0.5)) / n;
      const mid = Math.PI / 2 - theta;
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

/** Pendeldisplay (POV): zeigt, was das Auge bei 10 Schwingungen pro Sekunde sieht. */
export default function PendulumDisplay({ label, frequency = 10 }) {
  const { subscribePendulum } = useControlSocket();
  const canvasRef = useRef(null);
  const latest = useRef(null);
  const dirty = useRef(true);
  const viewRef = useRef('both');
  const [view, setView] = useState('both');
  const [frames, setFrames] = useState(0);

  useEffect(
    () =>
      subscribePendulum((pd) => {
        latest.current = pd;
        dirty.current = true;
      }),
    [subscribePendulum],
  );

  useEffect(() => {
    viewRef.current = view;
    dirty.current = true;
  }, [view]);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    let raf;
    let count = 0;
    const loop = () => {
      if (dirty.current) {
        dirty.current = false;
        draw(ctx, latest.current, viewRef.current);
        if (latest.current) setFrames(++count);
      }
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
      <div className="pendulum-foot">
        <span className="meta">
          {frequency} Schwingungen/s · {latest.current?.columns ?? '–'} Winkelschritte · {frames} Bilder
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
