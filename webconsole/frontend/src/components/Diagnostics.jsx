import { useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';

/**
 * Diagnose: Warnungen und Fehler der Renode-Modelle, vor allem Fehlkonfigurationen von Registern
 * (Takt nicht freigegeben, DEN vergessen, offener Eingang, falsche Baudrate, ...).
 * Auf dem Board würde das Programm in diesen Fällen still nicht funktionieren – hier steht, warum.
 */
export default function Diagnostics() {
  const { diagnostics, send } = useControlSocket();
  const [open, setOpen] = useState(true);
  if (!diagnostics.length) {
    return <div className="diag diag-ok">Diagnose: keine Konfigurationsfehler gemeldet</div>;
  }
  const errors = diagnostics.filter((d) => d.level === 'error').length;
  return (
    <section className={`diag ${errors ? 'diag-error' : 'diag-warning'}`}>
      <header className="diag-head">
        <button className="diag-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} Diagnose: {diagnostics.length} Meldung{diagnostics.length === 1 ? '' : 'en'}
          {errors ? ` (${errors} Fehler)` : ''} – das Programm verhält sich auf dem Board so nicht wie gedacht
        </button>
        <button className="btn small" onClick={() => send({ type: 'clearDiagnostics' })}>
          Leeren
        </button>
      </header>
      {open && (
        <ul className="diag-list">
          {diagnostics.map((d) => (
            <li key={d.message} className={d.level}>
              <span className="diag-level">{d.level === 'error' ? 'Fehler' : 'Warnung'}</span>
              <span className="diag-msg">{d.message}</span>
              {d.count > 1 && <span className="diag-count">×{d.count}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
