import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

/**
 * Oszilloskop für die Digitalsignale des Mikrocontrollers (3,3-V-Logik).
 *
 * Datenweg: Browser wählt Quellen (Pins) -> {type:"scope", sources} -> Backend -> Renode
 * (sim/models/Oscilloscope.cs zeichnet die Pegelwechsel mit virtueller Zeit auf) -> Backend pollt
 * alle 100 ms -> {type:"scope", now, pins, levels, ev}. Triggern und Zeichnen passiert hier.
 *
 * Bedienung wie an einem echten Gerät: 4 Kanäle (Quelle, V/div, Lage), Zeitbasis s/div,
 * Horizontalposition des Triggerpunkts, Trigger auf CH1..CH4 oder einen externen Eingang mit
 * Flanke und Pegel, Modus Auto/Normal/Einzel, Run/Stop.
 * Zeitauflösung: 1 us (Renode). Alle Zeiten sind virtuelle Simulationszeit.
 */

const VCC = 3.3; // Logikpegel HIGH
const VZ = 1.65; // offener (hochohmiger) Pin: gestrichelt in der Mitte gezeichnet
const DIV_X = 10;
const DIV_Y = 8;
const W = 800;
const H = 480;
const KEEP_NS = 25e9; // so viel virtuelle Zeit vorhalten (2 x 10 s bei 1 s/div + Reserve)
const MAX_EDGES = 400000; // je Pin
const AUTO_WAIT_NS = 250e6; // Auto: so lange (virtuell) ohne Trigger, dann frei laufen

const CH_COLORS = ['#facc15', '#22d3ee', '#f472b6', '#4ade80'];
const EXT_COLOR = '#cbd5e1';

// Pins des TM4C1294NCPDT (128 Pins)
const PORT_PINS = { A: 8, B: 6, C: 8, D: 8, E: 6, F: 5, G: 2, H: 4, J: 2, K: 8, L: 8, M: 8, N: 6, P: 6, Q: 5 };
const ALL_PORTS = Object.entries(PORT_PINS).map(([port, n]) => ({
  port,
  pins: Array.from({ length: n }, (_, i) => `P${port}${i}`),
}));

// Zeitbasis 1-2-5 von 1 us/div bis 1 s/div (Werte in ns)
const TIMEBASES = [];
for (let e = 3; e <= 9; e++) for (const m of [1, 2, 5]) if (m * 10 ** e <= 1e9) TIMEBASES.push(m * 10 ** e);
const VOLTS = [0.5, 1, 2, 5];

const de = (v, d = 2) => v.toLocaleString('de-DE', { maximumFractionDigits: d });
function fmtTime(ns) {
  const a = Math.abs(ns);
  if (a >= 1e9) return `${de(ns / 1e9, 3)} s`;
  if (a >= 1e6) return `${de(ns / 1e6, 3)} ms`;
  if (a >= 1e3) return `${de(ns / 1e3, 2)} µs`;
  return `${de(ns, 0)} ns`;
}
const fmtDiv = (ns) => `${fmtTime(ns)}/div`;
const fmtV = (v) => `${de(v, 2)} V`;

/** Pegelverlauf eines Pins: Stützstellen (Zeit ns, Pegel 0/1/2), Pegel gilt bis zur nächsten. */
class Trace {
  constructor(startNs, level) {
    this.t = [startNs];
    this.l = [level];
  }

  get start() {
    return this.t[0];
  }

  push(t, l) {
    const n = this.t.length;
    if (t < this.t[n - 1]) t = this.t[n - 1];
    if (this.l[n - 1] === l) return;
    this.t.push(t);
    this.l.push(l);
  }

  trim(fromNs) {
    let i = 0;
    while (i < this.t.length - 1 && this.t[i + 1] < fromNs) i++;
    if (this.t.length - i > MAX_EDGES) i = this.t.length - MAX_EDGES;
    if (i > 0) {
      this.t.splice(0, i);
      this.l.splice(0, i);
    }
  }

  /** Index der letzten Stützstelle mit Zeit <= t (-1: davor gibt es keine Daten) */
  index(t) {
    const a = this.t;
    if (!a.length || t < a[0]) return -1;
    let lo = 0;
    let hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

const volts = (l) => (l === 1 ? VCC : l === 0 ? 0 : VZ);

/**
 * Triggerflanke im Zeitraum [from, to] (Pegel kreuzt die Triggerschwelle): die jüngste
 * (laufende Anzeige) bzw. mit first = true die erste (Einzelaufnahme nach dem Scharfschalten).
 */
function findTrigger(trace, from, to, level, edge, first = false) {
  if (!trace || to < from) return null;
  const hit = (i) => {
    const a = volts(trace.l[i - 1]);
    const b = volts(trace.l[i]);
    return edge === 'rising' ? a < level && b >= level : a > level && b <= level;
  };
  const last = trace.index(to);
  if (first) {
    for (let i = Math.max(1, trace.index(from) + 1); i <= last; i++) if (trace.t[i] >= from && hit(i)) return trace.t[i];
    return null;
  }
  for (let i = last; i >= 1 && trace.t[i] >= from; i--) if (hit(i)) return trace.t[i];
  return null;
}

/**
 * Zeichnet den Pegelverlauf im Zeitraum [ta, tb]. Offene Abschnitte (Pegel 2) gestrichelt in der Mitte.
 * Bei mehr Flanken als Pixeln: je Pixelspalte eine senkrechte Linie vom tiefsten zum höchsten Pegel.
 */
function drawTrace(ctx, tr, ta, tb, xOf, yOf, color) {
  if (ta >= tb) return;
  const first = Math.max(0, tr.index(ta));
  const last = tr.index(tb);
  if (last < first) return;
  const solid = new Path2D();
  const open = new Path2D();
  const end = (k) => (k + 1 < tr.t.length ? Math.min(tb, tr.t[k + 1]) : tb);

  if (last - first > 2 * W) {
    const cols = new Map(); // Spalte -> [yMin, yMax]
    for (let k = first; k <= last; k++) {
      const xa = Math.floor(xOf(Math.max(ta, tr.t[k])));
      const xb = Math.floor(xOf(end(k)));
      const y = yOf(tr.l[k]);
      for (let x = xa; x <= xb && x < W; x++) {
        const c = cols.get(x);
        if (c) {
          c[0] = Math.min(c[0], y);
          c[1] = Math.max(c[1], y);
        } else cols.set(x, [y, y]);
      }
    }
    for (const [x, [y0, y1]] of cols) {
      solid.moveTo(x + 0.5, y0);
      solid.lineTo(x + 0.5, y1 + (y1 === y0 ? 0.01 : 0));
      solid.lineTo(x + 1.5, y1);
    }
  } else {
    let pen = false;
    for (let k = first; k <= last; k++) {
      const xa = xOf(Math.max(ta, tr.t[k]));
      const xb = xOf(end(k));
      const l = tr.l[k];
      if (l === 2) {
        open.moveTo(xa, yOf(2));
        open.lineTo(xb, yOf(2));
        pen = false;
        continue;
      }
      const y = yOf(l);
      if (pen) solid.lineTo(xa, y);
      else solid.moveTo(xa, y);
      solid.lineTo(xb, y);
      pen = true;
    }
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  ctx.stroke(solid);
  ctx.shadowBlur = 0;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.75;
  ctx.stroke(open);
  ctx.restore();
}

/** Auswahl einer Quelle: erst die benannten Signale des Versuchs, dann alle Pins nach Port */
function SourceSelect({ value, onChange, signals, labels, disabled = false }) {
  const label = (pin) => (labels.has(pin) ? `${pin} – ${labels.get(pin)}` : pin);
  return (
    <select className="scope-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">– aus –</option>
      {signals.length > 0 && (
        <optgroup label="Signale dieses Versuchs">
          {signals.map((s) => (
            <option key={`s-${s.pin}`} value={s.pin}>
              {label(s.pin)}
            </option>
          ))}
        </optgroup>
      )}
      {ALL_PORTS.map(({ port, pins }) => (
        <optgroup key={port} label={`Port ${port}`}>
          {pins.map((p) => (
            <option key={p} value={p}>
              {label(p)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function loadSettings(key, fallback) {
  try {
    const s = JSON.parse(localStorage.getItem(key));
    return s && s.version === 1 ? { ...fallback, ...s } : fallback;
  } catch {
    return fallback;
  }
}

function defaultSettings(scope) {
  const ch = scope?.channels || [];
  const trig = scope?.trigger || {};
  const trigCh = ch.indexOf(trig.source);
  return {
    version: 1,
    channels: [0, 1, 2, 3].map((i) => ({
      on: !!ch[i],
      pin: ch[i] || '',
      vdiv: 2,
      pos: 2.1 - 2 * i, // Lage der 0-V-Linie in Teilungen über der Mitte
    })),
    timebase: 1e6, // 1 ms/div
    hpos: 0.5, // Triggerpunkt in der Mitte
    trigger: {
      source: trigCh >= 0 ? `CH${trigCh + 1}` : trig.source ? 'EXT' : 'CH1',
      ext: trigCh >= 0 ? '' : trig.source || '',
      edge: trig.edge || 'rising',
      level: 1.6,
    },
    mode: 'auto',
  };
}

export default function Oscilloscope({ experimentId, scope }) {
  const { send, status, subscribeScope, renodeState } = useControlSocket();
  const storageKey = `scope.${experimentId}`;
  const [cfg, setCfg] = useState(() => loadSettings(storageKey, defaultSettings(scope)));
  const [run, setRun] = useState(true);
  const [info, setInfo] = useState({ state: 'warte', now: 0, dropped: 0 });
  const canvasRef = useRef(null);
  const data = useRef({ traces: new Map(), now: 0, dropped: 0 });
  const view = useRef({ t0: null, trigT: null, lastTrigNs: -Infinity, frozen: false });
  const cfgRef = useRef(cfg);
  const runRef = useRef(run);
  cfgRef.current = cfg;
  runRef.current = run;

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cfg));
    } catch {
      /* ohne Speicher weiter */
    }
  }, [cfg, storageKey]);

  const labels = useMemo(() => new Map((scope?.signals || []).map((s) => [s.pin, s.label])), [scope]);

  const trigPin = cfg.trigger.source === 'EXT' ? cfg.trigger.ext : cfg.channels[+cfg.trigger.source.slice(2) - 1]?.pin;

  // Quellen an das Backend: eingeschaltete Kanäle und externer Trigger
  const sources = useMemo(() => {
    const s = new Set(cfg.channels.filter((c) => c.on && c.pin).map((c) => c.pin));
    if (cfg.trigger.source === 'EXT' && cfg.trigger.ext) s.add(cfg.trigger.ext);
    return [...s].sort();
  }, [cfg]);
  const sourcesKey = sources.join(',');

  useEffect(() => {
    if (status === 'open') send({ type: 'scope', sources });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey, status]);

  // Beim Ausblenden (Unmount) nichts mehr aufzeichnen lassen
  useEffect(() => () => send({ type: 'scope', sources: [] }), [send]);

  // ---------------- Daten ----------------
  useEffect(
    () =>
      subscribeScope((msg) => {
        const d = data.current;
        if (msg.now < d.now) {
          d.traces = new Map(); // Renode neu gestartet
          view.current = { t0: null, trigT: null, lastTrigNs: -Infinity, frozen: false };
        }
        const known = msg.pins.map((p) => d.traces.has(p));
        let t = 0;
        for (let k = 0; k + 2 < msg.ev.length; k += 3) {
          t += msg.ev[k + 1];
          const i = msg.ev[k];
          if (known[i]) d.traces.get(msg.pins[i]).push(t, msg.ev[k + 2]);
        }
        msg.pins.forEach((p, i) => {
          if (!known[i]) d.traces.set(p, new Trace(msg.now, msg.levels[i]));
          else d.traces.get(p).push(msg.now, msg.levels[i]);
        });
        for (const [p, tr] of d.traces) {
          if (!msg.pins.includes(p)) d.traces.delete(p);
          else tr.trim(msg.now - KEEP_NS);
        }
        d.now = msg.now;
        d.dropped += msg.dropped;
        update();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribeScope],
  );

  // ---------------- Triggern ----------------
  const update = useCallback(() => {
    const c = cfgRef.current;
    const d = data.current;
    const v = view.current;
    const span = DIV_X * c.timebase;
    const pre = c.hpos * span;
    const post = span - pre;
    let state;
    if (!runRef.current || v.frozen) {
      state = 'stop';
    } else {
      const tp = c.trigger.source === 'EXT' ? c.trigger.ext : c.channels[+c.trigger.source.slice(2) - 1]?.pin;
      const tr = d.traces.get(tp);
      // jüngste Flanke, nach der schon ein ganzer Bildschirm Daten da ist
      const from = v.searchFrom ?? d.now - KEEP_NS; // nur neuere Flanken als die zuletzt gezeigte
      const trig = findTrigger(tr, from, d.now - post, c.trigger.level, c.trigger.edge, c.mode === 'single');
      if (trig !== null) {
        v.trigT = trig;
        v.searchFrom = trig + 1;
        v.t0 = trig - pre;
        v.lastTrigNs = d.now;
        state = 'trig';
        if (c.mode === 'single') {
          v.frozen = true;
          setRun(false);
        }
      } else if (c.mode === 'auto' && d.now - v.lastTrigNs > Math.max(AUTO_WAIT_NS, 2 * span)) {
        v.trigT = null; // frei laufend: die jüngsten Daten
        v.t0 = d.now - span;
        state = 'auto';
      } else {
        state = v.t0 !== null && d.now - v.lastTrigNs <= Math.max(AUTO_WAIT_NS, 2 * span) ? (v.trigT === null ? 'auto' : 'trig') : 'warte';
      }
    }
    draw();
    setInfo((old) =>
      old.state === state && Math.abs(old.now - d.now) < 5e7 && old.dropped === d.dropped ? old : { state, now: d.now, dropped: d.dropped },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- Zeichnen ----------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const c = cfgRef.current;
    const d = data.current;
    const v = view.current;
    const dx = W / DIV_X;
    const dy = H / DIV_Y;
    const span = DIV_X * c.timebase;

    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, W, H);

    // Gitter: gepunktete Teilungen, Mittelachsen mit Feinteilung (5 je Teilung)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 4]);
    ctx.beginPath();
    for (let i = 1; i < DIV_X; i++) {
      ctx.moveTo(i * dx + 0.5, 0);
      ctx.lineTo(i * dx + 0.5, H);
    }
    for (let j = 1; j < DIV_Y; j++) {
      ctx.moveTo(0, j * dy + 0.5);
      ctx.lineTo(W, j * dy + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.beginPath();
    ctx.moveTo(W / 2 + 0.5, 0);
    ctx.lineTo(W / 2 + 0.5, H);
    ctx.moveTo(0, H / 2 + 0.5);
    ctx.lineTo(W, H / 2 + 0.5);
    for (let i = 0; i <= DIV_X * 5; i++) {
      const x = (i * dx) / 5 + 0.5;
      const l = i % 5 === 0 ? 6 : 3;
      ctx.moveTo(x, H / 2 - l);
      ctx.lineTo(x, H / 2 + l);
    }
    for (let j = 0; j <= DIV_Y * 5; j++) {
      const y = (j * dy) / 5 + 0.5;
      const l = j % 5 === 0 ? 6 : 3;
      ctx.moveTo(W / 2 - l, y);
      ctx.lineTo(W / 2 + l, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    const yOf = (ch, volt) => H / 2 - (ch.pos + volt / ch.vdiv) * dy;

    // Kurven
    const t0 = v.t0;
    if (t0 !== null) {
      const t1 = t0 + span;
      const xOf = (t) => ((t - t0) / span) * W;
      c.channels.forEach((ch, n) => {
        if (!ch.on || !ch.pin) return;
        const tr = d.traces.get(ch.pin);
        if (tr) drawTrace(ctx, tr, Math.max(t0, tr.start), Math.min(t1, d.now), xOf, (l) => yOf(ch, volts(l)), CH_COLORS[n]);
      });
    }

    // Marken: 0-V-Linie je Kanal (links), Triggerpegel (rechts), Triggerpunkt (oben)
    ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    c.channels.forEach((ch, n) => {
      if (!ch.on || !ch.pin) return;
      const y = Math.max(7, Math.min(H - 7, yOf(ch, 0)));
      ctx.fillStyle = CH_COLORS[n];
      ctx.beginPath();
      ctx.moveTo(0, y - 7);
      ctx.lineTo(14, y - 7);
      ctx.lineTo(20, y);
      ctx.lineTo(14, y + 7);
      ctx.lineTo(0, y + 7);
      ctx.fill();
      ctx.fillStyle = '#05080a';
      ctx.fillText(String(n + 1), 4, y + 0.5);
    });
    const tsrc = c.trigger.source;
    const trigCh = tsrc === 'EXT' ? null : c.channels[+tsrc.slice(2) - 1];
    if (trigCh && trigCh.on) {
      const y = Math.max(7, Math.min(H - 7, yOf(trigCh, c.trigger.level)));
      ctx.fillStyle = CH_COLORS[+tsrc.slice(2) - 1];
      ctx.beginPath();
      ctx.moveTo(W, y - 7);
      ctx.lineTo(W - 14, y - 7);
      ctx.lineTo(W - 20, y);
      ctx.lineTo(W - 14, y + 7);
      ctx.lineTo(W, y + 7);
      ctx.fill();
      ctx.fillStyle = '#05080a';
      ctx.fillText('T', W - 12, y + 0.5);
    }
    const xt = c.hpos * W;
    ctx.fillStyle = tsrc === 'EXT' ? EXT_COLOR : CH_COLORS[+tsrc.slice(2) - 1];
    ctx.beginPath();
    ctx.moveTo(xt - 7, 0);
    ctx.lineTo(xt + 7, 0);
    ctx.lineTo(xt, 9);
    ctx.fill();
  }, []);

  // Neu zeichnen bei Änderung der Einstellungen
  useEffect(() => {
    if (!run) draw();
    else update();
  }, [cfg, run, draw, update]);

  // Run/Stop und Einzel
  const toggleRun = () => {
    if (!run) {
      view.current.frozen = false;
      view.current.trigT = null;
      view.current.searchFrom = null;
      view.current.lastTrigNs = data.current.now;
    }
    setRun(!run);
  };

  // ---------------- Bedienung ----------------
  const setCh = (n, patch) => setCfg((old) => ({ ...old, channels: old.channels.map((c, i) => (i === n ? { ...c, ...patch } : c)) }));
  const setTrig = (patch) => {
    view.current.trigT = null;
    view.current.searchFrom = null;
    setCfg((old) => ({ ...old, trigger: { ...old.trigger, ...patch } }));
  };
  const signals = scope?.signals || [];

  const stateText = {
    trig: 'Trig’d',
    auto: 'Auto',
    warte: 'Warten …',
    stop: 'Stop',
  }[info.state];

  const trigColor = cfg.trigger.source === 'EXT' ? EXT_COLOR : CH_COLORS[+cfg.trigger.source.slice(2) - 1];

  return (
    <Widget title="Oszilloskop" subtitle="Pegel an den Pins, 3,3-V-Logik · virtuelle Zeit der Simulation" className="scope">
      <div className="scope-top">
        <div className="scope-screen">
          <canvas ref={canvasRef} width={W} height={H} className="scope-canvas" />
          <div className="scope-readout">
            {cfg.channels.map((c, n) =>
              c.on && c.pin ? (
                <span key={n} style={{ color: CH_COLORS[n] }}>
                  CH{n + 1} {fmtV(c.vdiv)}/div
                </span>
              ) : null,
            )}
            <span className="scope-tb">{fmtDiv(cfg.timebase)}</span>
            <span style={{ color: trigColor }}>
              {cfg.trigger.source === 'EXT' ? `EXT ${cfg.trigger.ext || '–'}` : cfg.trigger.source}{' '}
              {cfg.trigger.edge === 'rising' ? '↑' : '↓'} {fmtV(cfg.trigger.level)}
            </span>
            <span className={`scope-state ${info.state}`} title={info.state === 'warte' ? 'Warte auf Trigger' : undefined}>{renodeState === 'running' ? stateText : 'Renode steht'}</span>
          </div>
        </div>

        <div className="scope-side">
          <fieldset className="scope-group">
            <legend>Horizontal</legend>
            <label className="scope-row">
              <span>Zeitbasis</span>
              <select className="scope-select" value={cfg.timebase} onChange={(e) => setCfg({ ...cfg, timebase: +e.target.value })}>
                {TIMEBASES.map((t) => (
                  <option key={t} value={t}>
                    {fmtDiv(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="scope-row">
              <span>Trigger­punkt</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cfg.hpos}
                onChange={(e) => setCfg({ ...cfg, hpos: +e.target.value })}
              />
              <span className="scope-val">{de((0.5 - cfg.hpos) * DIV_X, 1)} div</span>
            </label>
          </fieldset>

          <fieldset className="scope-group">
            <legend>Trigger</legend>
            <label className="scope-row">
              <span>Quelle</span>
              <select className="scope-select" value={cfg.trigger.source} onChange={(e) => setTrig({ source: e.target.value })}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={`CH${n}`}>
                    CH{n}
                    {cfg.channels[n - 1].pin ? ` (${cfg.channels[n - 1].pin})` : ''}
                  </option>
                ))}
                <option value="EXT">Extern</option>
              </select>
            </label>
            <label className={`scope-row ${cfg.trigger.source === 'EXT' ? '' : 'scope-disabled'}`}>
              <span>Ext. Eingang</span>
              <SourceSelect
                value={cfg.trigger.ext}
                onChange={(p) => setTrig({ ext: p })}
                signals={signals}
                labels={labels}
                disabled={cfg.trigger.source !== 'EXT'}
              />
            </label>
            <div className="scope-row">
              <span>Flanke</span>
              <div className="scope-seg">
                {[
                  ['rising', '↑ steigend'],
                  ['falling', '↓ fallend'],
                ].map(([id, l]) => (
                  <button key={id} className={cfg.trigger.edge === id ? 'on' : ''} onClick={() => setTrig({ edge: id })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <label className="scope-row">
              <span>Pegel</span>
              <input
                type="range"
                min={0}
                max={VCC}
                step={0.05}
                value={cfg.trigger.level}
                onChange={(e) => setTrig({ level: +e.target.value })}
              />
              <span className="scope-val">{fmtV(cfg.trigger.level)}</span>
            </label>
            <div className="scope-row">
              <span>Modus</span>
              <div className="scope-seg">
                {[
                  ['auto', 'Auto'],
                  ['normal', 'Normal'],
                  ['single', 'Einzel'],
                ].map(([id, l]) => (
                  <button
                    key={id}
                    className={cfg.mode === id ? 'on' : ''}
                    onClick={() => {
                      view.current.frozen = false;
                      setCfg({ ...cfg, mode: id });
                      if (id === 'single') {
                        view.current.trigT = null;
                        view.current.searchFrom = data.current.now; // nur Flanken nach dem Scharfschalten
                        setRun(true);
                      }
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <button className={`btn small scope-run ${run ? 'running' : 'stopped'}`} onClick={toggleRun}>
              {run ? 'Run – klicken für Stop' : 'Stop – klicken für Run'}
            </button>
          </fieldset>
        </div>
      </div>

      <div className="scope-channels">
        {cfg.channels.map((c, n) => (
          <fieldset key={n} className={`scope-ch ${c.on ? 'on' : ''}`} style={{ '--ch': CH_COLORS[n] }}>
            <legend>
              <label>
                <input type="checkbox" checked={c.on} onChange={(e) => setCh(n, { on: e.target.checked })} /> CH{n + 1}
              </label>
            </legend>
            <SourceSelect value={c.pin} onChange={(p) => setCh(n, { pin: p, on: !!p })} signals={signals} labels={labels} />
            <div className="scope-row">
              <span>V/div</span>
              <select className="scope-select" value={c.vdiv} onChange={(e) => setCh(n, { vdiv: +e.target.value })}>
                {VOLTS.map((vv) => (
                  <option key={vv} value={vv}>
                    {fmtV(vv)}
                  </option>
                ))}
              </select>
            </div>
            <label className="scope-row">
              <span>Lage</span>
              <input type="range" min={-4} max={4} step={0.1} value={c.pos} onChange={(e) => setCh(n, { pos: +e.target.value })} />
            </label>
          </fieldset>
        ))}
      </div>

      <div className="scope-foot meta">
        <span>Simulationszeit {fmtTime(info.now)}</span>
        <span>Auflösung 1 µs · gestrichelt = Pin offen (hochohmig)</span>
        {info.dropped > 0 && <span className="scope-warn">⚠ {info.dropped} Flanken verloren (zu viele Pegelwechsel)</span>}
        {trigPin === '' && <span className="scope-warn">Trigger-Quelle ohne Signal</span>}
      </div>
    </Widget>
  );
}
