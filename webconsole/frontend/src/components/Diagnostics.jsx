import { useEffect, useRef } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import { usePanel } from '../layout/PanelContext.js';
import Widget from './Widget.jsx';

/**
 * Diagnose: Warnungen und Fehler der Renode-Modelle, vor allem Fehlkonfigurationen von Registern
 * (Takt nicht freigegeben, DEN vergessen, offener Eingang, falsche Baudrate, ...).
 * Auf dem Board würde das Programm in diesen Fällen still nicht funktionieren – hier steht, warum.
 * Kommt eine neue Meldung, klappt das Panel von selbst auf.
 */
export default function Diagnostics() {
  const { diagnostics, send } = useControlSocket();
  const { expand } = usePanel();
  const errors = diagnostics.filter((d) => d.level === 'error').length;
  const prev = useRef(0);

  useEffect(() => {
    if (diagnostics.length > prev.current) expand();
    prev.current = diagnostics.length;
  }, [diagnostics.length, expand]);

  const level = errors ? 'error' : diagnostics.length ? 'warning' : 'ok';
  return (
    <Widget
      title="Diagnostics"
      className={`diag diag-${level}`}
      subtitle={diagnostics.length ? 'on the real board the program would not behave as intended' : undefined}
      badge={
        diagnostics.length > 0 && (
          <span className={`count-badge ${level}`}>
            {diagnostics.length}
            {errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
          </span>
        )
      }
      actions={
        diagnostics.length > 0 && (
          <button className="btn small" onClick={() => send({ type: 'clearDiagnostics' })}>
            Clear
          </button>
        )
      }
    >
      {diagnostics.length ? (
        <ul className="diag-list">
          {diagnostics.map((d) => (
            <li key={d.message} className={d.level}>
              <span className="diag-level">{d.level === 'error' ? 'Error' : 'Warning'}</span>
              <span className="diag-msg">{d.message}</span>
              {d.count > 1 && <span className="diag-count">×{d.count}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="meta">No configuration errors reported.</div>
      )}
    </Widget>
  );
}
