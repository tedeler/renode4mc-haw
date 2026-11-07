import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelContext } from './PanelContext.js';

/*
 * Arbeitsbereich der Web-Konsole: Panels (Widgets) in Spalten.
 *
 * Desktop ("fit"): alles passt auf eine Seite, die Seite scrollt nicht. Die Panels einer Spalte
 * teilen sich die Höhe (Gewicht "grow"), Panels ohne grow behalten ihre natürliche Höhe.
 * Kopfzeile ziehen = Panel verschieben (auch an den linken/rechten Rand -> neue Spalte),
 * Kopfzeile klicken = ein-/ausklappen, Trennlinie zwischen Spalten ziehen = Breite ändern.
 *
 * Mobil: eine Spalte in Layout-Reihenfolge, die Seite scrollt; eine Sprungleiste in der
 * Kopfzeile führt zu jedem Panel. Verschieben über den Griff ⠿.
 *
 * Die Panels werden in eigene, stabile DOM-Knoten gerendert (Portal) und nur umgehängt, wenn sie
 * die Spalte wechseln. So bleiben Terminal-Inhalt, Canvas-Bilder und WebSockets beim Verschieben
 * erhalten.
 *
 * Das Layout wird je Versuch im Browser gespeichert (localStorage); "↺ Standardlayout" stellt die
 * Standardanordnung wieder her, alle Panels ausgeklappt.
 */

const FIT_QUERY = '(min-width: 760px) and (min-height: 520px)';
const MIN_COL_PX = 240;
const MAX_COLS = 4;
const EDGE_PX = 28;
const STORE_PREFIX = 'renode4mc.layout.v1.';

export function useFitMode() {
  const get = () => typeof window !== 'undefined' && window.matchMedia(FIT_QUERY).matches;
  const [fit, setFit] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(FIT_QUERY);
    const on = () => setFit(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, []);
  return fit;
}

const ZONE_WIDTH = { visual: 1.3, io: 1.2, control: 0.8 };

/** Standard: alles sichtbar. Breit: Anzeigen | Terminals | Bedienelemente; schmaler: zwei Spalten. */
export function defaultLayout(panels, width) {
  const zone = { visual: [], io: [], control: [] };
  for (const p of panels) zone[p.zone ?? 'control'].push(p.id);
  let cols;
  let widths;
  if (!zone.visual.length) {
    cols = [zone.io, zone.control];
    widths = [ZONE_WIDTH.io, ZONE_WIDTH.control];
  } else if (width >= 1280) {
    cols = [zone.visual, zone.io, zone.control];
    widths = [ZONE_WIDTH.visual, ZONE_WIDTH.io, ZONE_WIDTH.control];
  } else {
    // schmaler: Anzeigen (+ Diagnose) | Terminals + Bedienelemente
    const diag = zone.control.filter((id) => id === 'diag');
    cols = [
      [...zone.visual, ...diag],
      [...zone.io, ...zone.control.filter((id) => id !== 'diag')],
    ];
    widths = [1, 1];
  }
  const keep = cols.map((c) => c.length > 0);
  return { cols: cols.filter((_, i) => keep[i]), widths: widths.filter((_, i) => keep[i]), collapsed: {} };
}

/** Gespeichertes Layout an die aktuellen Panels anpassen (unbekannte weg, neue anhängen). */
function normalize(saved, panels, width) {
  const ids = new Set(panels.map((p) => p.id));
  if (!saved || !Array.isArray(saved.cols)) return defaultLayout(panels, width);
  const seen = new Set();
  let cols = saved.cols.map((c) =>
    (Array.isArray(c) ? c : []).filter((id) => ids.has(id) && !seen.has(id) && seen.add(id)),
  );
  let widths =
    Array.isArray(saved.widths) && saved.widths.length === cols.length
      ? saved.widths.map((w) => (Number.isFinite(w) && w > 0 ? w : 1))
      : cols.map(() => 1);
  const keep = cols.map((c) => c.length > 0);
  cols = cols.filter((_, i) => keep[i]);
  widths = widths.filter((_, i) => keep[i]);
  if (!cols.length) return defaultLayout(panels, width);
  // Neu hinzugekommene Panels (z. B. Oszilloskop eingeblendet): oben in die Spalte ihrer Zone,
  // gibt es dort keine, als neue Spalte rechts (sofern Platz), sonst in die letzte Spalte
  const zoneOf = Object.fromEntries(panels.map((p) => [p.id, p.zone ?? 'control']));
  for (const id of panels.map((p) => p.id).filter((x) => !seen.has(x))) {
    const ci = cols.findIndex((c) => c.some((x) => zoneOf[x] === zoneOf[id]));
    if (ci >= 0) cols[ci] = [id, ...cols[ci]];
    else if (cols.length < Math.min(MAX_COLS, Math.floor(width / MIN_COL_PX))) {
      cols.push([id]);
      widths.push(1.2);
    } else cols[cols.length - 1] = [...cols[cols.length - 1], id];
  }
  const collapsed = {};
  for (const [id, v] of Object.entries(saved.collapsed ?? {})) if (ids.has(id) && v) collapsed[id] = true;
  return { cols, widths, collapsed };
}

function loadLayout(key) {
  try {
    return JSON.parse(window.localStorage.getItem(STORE_PREFIX + key) ?? 'null');
  } catch {
    return null;
  }
}

function saveLayout(key, layout) {
  try {
    window.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(layout));
  } catch {
    /* kein Speicher (privater Modus o. Ä.): Layout gilt nur bis zum Neuladen */
  }
}

function applyMove(layout, id, t) {
  const cols = layout.cols.map((c) => c.filter((x) => x !== id));
  const widths = [...layout.widths];
  if (t.newCol !== undefined) {
    const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
    cols.splice(t.newCol, 0, [id]);
    widths.splice(t.newCol, 0, avg);
  } else if (t.flat !== undefined) {
    let k = t.flat;
    let placed = false;
    for (const c of cols) {
      if (k <= c.length) {
        c.splice(k, 0, id);
        placed = true;
        break;
      }
      k -= c.length;
    }
    if (!placed) cols[cols.length - 1].push(id);
  } else {
    cols[t.col].splice(t.index, 0, id);
  }
  const keep = cols.map((c) => c.length > 0);
  return { ...layout, cols: cols.filter((_, i) => keep[i]), widths: widths.filter((_, i) => keep[i]) };
}

/** Kopfzeilen-Platz, den die Setup-Leiste bereitstellt (für Werkzeuge bzw. Sprungleiste). */
function useSlot(id) {
  const [el, setEl] = useState(null);
  useEffect(() => setEl(document.getElementById(id)), [id]);
  return el;
}

export default function Workspace({ layoutKey, panels, extraTools = null, toolsSlotId = 'hdr-tools' }) {
  const fit = useFitMode();
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const idsKey = panels.map((p) => p.id).join(',');
  const byId = useMemo(() => Object.fromEntries(panels.map((p) => [p.id, p])), [panels]);

  const [layout, setLayout] = useState(() => normalize(loadLayout(layoutKey), panels, window.innerWidth));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    setLayout((l) => normalize(l, panels, window.innerWidth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  useEffect(() => saveLayout(layoutKey, layout), [layoutKey, layout]);

  // ---------- stabile DOM-Knoten je Panel ----------
  const hosts = useRef(new Map());
  const hostFor = (id) => {
    let h = hosts.current.get(id);
    if (!h) {
      h = document.createElement('div');
      h.className = 'panel-host';
      hosts.current.set(id, h);
    }
    return h;
  };
  const attachers = useRef(new Map());
  const attach = (id) => {
    let fn = attachers.current.get(id);
    if (!fn) {
      fn = (el) => {
        if (!el) return;
        const h = hostFor(id);
        if (h.parentNode !== el) el.appendChild(h);
      };
      attachers.current.set(id, fn);
    }
    return fn;
  };

  // ---------- Ein-/Ausklappen ----------
  const setCollapsed = useCallback(
    (id, v) =>
      setLayout((l) => {
        if (!!l.collapsed[id] === v) return l;
        const collapsed = { ...l.collapsed };
        if (v) collapsed[id] = true;
        else delete collapsed[id];
        return { ...l, collapsed };
      }),
    [],
  );

  // ---------- Verschieben ----------
  const wsRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClick = useRef(null);
  const [drag, setDrag] = useState(null);

  const computeTarget = (x, y, id) => {
    const ws = wsRef.current;
    if (!ws) return null;
    const r = ws.getBoundingClientRect();
    const L = layoutRef.current;
    if (fitRef.current) {
      const colEls = [...ws.querySelectorAll(':scope > .ws-col')];
      const maxCols = Math.max(1, Math.min(MAX_COLS, Math.floor(r.width / MIN_COL_PX)));
      const alone = L.cols.some((c) => c.length === 1 && c[0] === id);
      if (L.cols.length - (alone ? 1 : 0) < maxCols) {
        if (x < r.left + EDGE_PX) return { newCol: 0, ind: { left: r.left, top: r.top, width: 4, height: r.height } };
        if (x > r.right - EDGE_PX)
          return { newCol: L.cols.length, ind: { left: r.right - 4, top: r.top, width: 4, height: r.height } };
      }
      let ci = 0;
      let best = Infinity;
      colEls.forEach((c, i) => {
        const cr = c.getBoundingClientRect();
        const d = x < cr.left ? cr.left - x : x > cr.right ? x - cr.right : 0;
        if (d < best) {
          best = d;
          ci = i;
        }
      });
      const colEl = colEls[ci];
      if (!colEl) return null;
      const cr = colEl.getBoundingClientRect();
      const slots = [...colEl.querySelectorAll(':scope > .ws-slot')].filter((s) => s.dataset.slot !== id);
      return { col: ci, ...insertion(slots, y, cr) };
    }
    const slots = [...ws.querySelectorAll(':scope > .ws-slot')].filter((s) => s.dataset.slot !== id);
    const res = insertion(slots, y, r);
    return { flat: res.index, ind: res.ind };
  };

  const startDrag = useCallback((e, id) => {
    if (e.button !== undefined && e.button !== 0) return;
    const d = { id, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, active: false, target: null };
    dragRef.current = d;
    let raf = 0;

    const refresh = () => {
      d.target = computeTarget(d.x, d.y, id);
      setDrag({ id, x: d.x, y: d.y, ind: d.target?.ind ?? null });
    };
    // Mobil: am oberen/unteren Rand automatisch weiterscrollen
    const autoscroll = () => {
      raf = 0;
      if (!d.active || fitRef.current) return;
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hdr-h')) || 0;
      const v = d.y < top + 48 ? -14 : d.y > window.innerHeight - 48 ? 14 : 0;
      if (v) {
        window.scrollBy(0, v);
        refresh();
        raf = requestAnimationFrame(autoscroll);
      }
    };
    const move = (ev) => {
      d.x = ev.clientX;
      d.y = ev.clientY;
      if (!d.active) {
        if (Math.hypot(d.x - d.sx, d.y - d.sy) < 6) return;
        d.active = true;
        document.body.classList.add('ws-dragging');
      }
      ev.preventDefault();
      refresh();
      if (!raf) raf = requestAnimationFrame(autoscroll);
    };
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (raf) cancelAnimationFrame(raf);
      document.body.classList.remove('ws-dragging');
      dragRef.current = null;
      if (d.active) {
        suppressClick.current = { id, t: performance.now() };
        if (ev.type === 'pointerup' && d.target) setLayout((l) => applyMove(l, id, d.target));
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const consumeClick = useCallback((id) => {
    const s = suppressClick.current;
    suppressClick.current = null;
    return !!s && s.id === id && performance.now() - s.t < 400;
  }, []);

  // ---------- Spaltenbreite ----------
  const startResize = (e, i) => {
    e.preventDefault();
    const colEls = [...wsRef.current.querySelectorAll(':scope > .ws-col')];
    const pa = colEls[i].getBoundingClientRect().width;
    const pb = colEls[i + 1].getBoundingClientRect().width;
    const w0 = layoutRef.current.widths;
    const sum = w0[i] + w0[i + 1];
    const sx = e.clientX;
    const gutter = e.currentTarget;
    gutter.classList.add('active');
    document.body.classList.add('ws-resizing');
    const move = (ev) => {
      const na = Math.min(Math.max(pa + ev.clientX - sx, MIN_COL_PX), pa + pb - MIN_COL_PX);
      setLayout((l) => {
        const widths = [...l.widths];
        widths[i] = (sum * na) / (pa + pb);
        widths[i + 1] = sum - widths[i];
        return { ...l, widths };
      });
    };
    const up = () => {
      gutter.classList.remove('active');
      document.body.classList.remove('ws-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const equalize = (i) =>
    setLayout((l) => {
      const widths = [...l.widths];
      const m = (widths[i] + widths[i + 1]) / 2;
      widths[i] = m;
      widths[i + 1] = m;
      return { ...l, widths };
    });

  // ---------- Werkzeuge / Sprungleiste ----------
  const order = layout.cols.flat();
  const anyCollapsed = order.some((id) => layout.collapsed[id]);
  const reset = () => setLayout(defaultLayout(panels, window.innerWidth));
  const expandAll = () => setLayout((l) => ({ ...l, collapsed: {} }));
  const collapseAll = () => setLayout((l) => ({ ...l, collapsed: Object.fromEntries(order.map((id) => [id, true])) }));
  const goTo = (id) => {
    setCollapsed(id, false);
    requestAnimationFrame(() =>
      wsRef.current?.querySelector(`[data-slot="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  const toolsEl = useSlot(toolsSlotId);
  const tools = fit ? (
    <div className="ws-tools-row">
      {extraTools}
      {anyCollapsed ? (
        <button className="btn small ghost icon" onClick={expandAll} title="Alle Panels ausklappen">
          ⊞
        </button>
      ) : (
        <button className="btn small ghost icon" onClick={collapseAll} title="Alle Panels einklappen">
          ⊟
        </button>
      )}
      <button
        className="btn small ghost"
        onClick={reset}
        title="Zurück zum Standardlayout: alle Panels sichtbar, Anordnung wie beim ersten Start (die gespeicherte Anordnung dieses Versuchs wird ersetzt)"
      >
        ↺ Standardlayout
      </button>
    </div>
  ) : (
    <nav className="ws-jump" aria-label="Zu Panel springen">
      {extraTools}
      {order.map((id) => (
        <button
          key={id}
          className={`chip ${layout.collapsed[id] ? 'off' : ''} ${byId[id]?.alert ? `alert-${byId[id].alert}` : ''}`}
          onClick={() => goTo(id)}
        >
          {byId[id]?.title ?? id}
        </button>
      ))}
      <button className="chip ghost" onClick={reset} title="Zurück zum Standardlayout (alles ausgeklappt)">
        ↺ Standardlayout
      </button>
    </nav>
  );

  // ---------- Darstellung ----------
  const slot = (id) => {
    const p = byId[id];
    if (!p) return null;
    const c = !!layout.collapsed[id];
    let style;
    if (fit) style = c || !p.grow ? { flex: '0 0 auto' } : { flex: `${p.grow} 1 0px`, minHeight: p.minH ?? 120 };
    return (
      <div
        key={id}
        ref={attach(id)}
        data-slot={id}
        className={`ws-slot ${c ? 'collapsed' : ''} ${drag?.id === id ? 'dragging' : ''}`}
        style={style}
      />
    );
  };

  return (
    <>
      <div ref={wsRef} className={`ws ${fit ? 'fit' : 'flow'}`}>
        {fit
          ? layout.cols.map((col, ci) => (
              <Fragment key={ci}>
                {ci > 0 && (
                  <div
                    className="ws-gutter"
                    role="separator"
                    aria-orientation="vertical"
                    title="Ziehen: Spaltenbreite ändern · Doppelklick: beide gleich breit"
                    onPointerDown={(e) => startResize(e, ci - 1)}
                    onDoubleClick={() => equalize(ci - 1)}
                  />
                )}
                <div className="ws-col" data-col={ci} style={{ flexGrow: layout.widths[ci] }}>
                  {col.map(slot)}
                </div>
              </Fragment>
            ))
          : order.map(slot)}
      </div>

      {panels.map((p) =>
        createPortal(
          <PanelContext.Provider
            value={{
              id: p.id,
              fit,
              collapsed: !!layout.collapsed[p.id],
              toggle: () => setCollapsed(p.id, !layoutRef.current.collapsed[p.id]),
              expand: () => setCollapsed(p.id, false),
              startDrag: (e) => startDrag(e, p.id),
              consumeClick: () => consumeClick(p.id),
              dragging: drag?.id === p.id,
            }}
          >
            {p.el}
          </PanelContext.Provider>,
          hostFor(p.id),
          p.id,
        ),
      )}

      {toolsEl && createPortal(tools, toolsEl)}

      {drag && (
        <>
          {drag.ind && <div className="ws-drop" style={drag.ind} />}
          <div className="ws-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {byId[drag.id]?.title ?? drag.id}
          </div>
        </>
      )}
    </>
  );
}

/** Einfügestelle in einer Liste von Panels anhand der Zeigerhöhe (vor dem ersten Panel, dessen Mitte darunter liegt). */
function insertion(slots, y, box) {
  let index = slots.length;
  for (let k = 0; k < slots.length; k++) {
    const sr = slots[k].getBoundingClientRect();
    if (y < sr.top + sr.height / 2) {
      index = k;
      break;
    }
  }
  let top;
  if (index < slots.length) top = slots[index].getBoundingClientRect().top - 6;
  else if (slots.length) top = slots[slots.length - 1].getBoundingClientRect().bottom + 2;
  else top = box.top + 4;
  return { index, ind: { left: box.left, top, width: box.width, height: 4 } };
}
