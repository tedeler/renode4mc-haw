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
      title="Diagnose"
      className={`diag diag-${level}`}
      subtitle={diagnostics.length ? 'das Programm verhält sich auf dem Board so nicht wie gedacht' : undefined}
      badge={
        diagnostics.length > 0 && (
          <span className={`count-badge ${level}`}>
            {diagnostics.length}
            {errors ? ` · ${errors} Fehler` : ''}
          </span>
        )
      }
      actions={
        diagnostics.length > 0 && (
          <button className="btn small" onClick={() => send({ type: 'clearDiagnostics' })}>
            Leeren
          </button>
        )
      }
    >
      {diagnostics.length ? (
        <ul className="diag-list">
          {diagnostics.map((d) => (
            <li key={d.message} className={d.level}>
              <span className="diag-level">{d.level === 'error' ? 'Fehler' : 'Warnung'}</span>
              <span className="diag-msg">{d.message}</span>
              {d.count > 1 && <span className="diag-count">×{d.count}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="meta">Keine Konfigurationsfehler gemeldet.</div>
      )}
    </Widget>
  );
}
