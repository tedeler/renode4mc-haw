import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

const MAX_CHARS = 60000;

/**
 * CCS-Konsole: Ausgabe von printf()/puts() der Firmware. Auf dem Board zeigt sie Code Composer
 * Studio über den Debugger an (CIO); im Simulator übernimmt das sim/models/TiCioConsole.cs.
 */
export default function CioConsole({ label }) {
  const { subscribeCio } = useControlSocket();
  const [text, setText] = useState('');
  const preRef = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    const decoder = new TextDecoder('utf-8');
    return subscribeCio((bytes, reset) => {
      const chunk = decoder.decode(bytes, { stream: true });
      setText((t) => {
        const next = (reset ? '' : t) + chunk;
        return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next;
      });
    });
  }, [subscribeCio]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <Widget title="CCS-Konsole (printf)" subtitle={label} className="cio">
      <pre
        className="cio-output"
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {text || <span className="cio-empty">Noch keine Ausgabe. printf() erscheint hier.</span>}
      </pre>
      <div className="row-actions">
        <button className="btn small" onClick={() => setText('')}>
          Leeren
        </button>
      </div>
    </Widget>
  );
}
