import { useLayoutEffect, useRef, useState } from 'react';
import { usePanel } from './PanelContext.js';

/**
 * Skaliert eine Anzeige mit fester Eigengröße (Canvas, Keypad, 7-Segment) so, dass sie den
 * verfügbaren Platz ausfüllt, ohne das Seitenverhältnis zu ändern.
 * Desktop: so groß, wie Breite UND Höhe des Panels erlauben. Mobil: nach der Breite
 * (höchstens flowMaxH Pixel hoch), die Seite scrollt.
 */
export default function ScaleBox({ children, maxScale = 2, minH = 120, flowMaxH = 520, className = '' }) {
  const { fit } = usePanel();
  const outer = useRef(null);
  const inner = useRef(null);
  const [st, setSt] = useState({ s: 1, h: null });

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    const update = () => {
      const nw = i.offsetWidth;
      const nh = i.offsetHeight;
      const cw = o.clientWidth;
      if (!nw || !nh || !cw) return;
      let s;
      let h = null;
      if (fit) {
        const ch = o.clientHeight;
        if (!ch) return;
        s = Math.min(cw / nw, ch / nh, maxScale);
      } else {
        s = Math.min(cw / nw, flowMaxH / nh, maxScale);
        h = Math.ceil(nh * s);
      }
      setSt((p) => (Math.abs(p.s - s) < 0.002 && p.h === h ? p : { s, h }));
    };
    const ro = new ResizeObserver(update);
    ro.observe(o);
    ro.observe(i);
    update();
    return () => ro.disconnect();
  }, [fit, maxScale, flowMaxH]);

  return (
    <div
      ref={outer}
      className={`scalebox ${fit ? 'fit' : 'flow'} ${className}`}
      style={fit ? { minHeight: minH } : { height: st.h ?? minH }}
    >
      <div ref={inner} className="scalebox-inner" style={{ transform: `translate(-50%, -50%) scale(${st.s})` }}>
        {children}
      </div>
    </div>
  );
}
