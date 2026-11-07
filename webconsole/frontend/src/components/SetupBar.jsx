import { useEffect, useRef, useState } from 'react';
import { fetchExperiments, startSolution, stopSimulation, uploadElf } from '../api.js';

/** Kopfzeile: Versuchsauswahl, ELF-Upload, Start/Stop. */
export default function SetupBar({ running, activeId, onStarted, onStopped }) {
  const [experiments, setExperiments] = useState([]);
  const [experimentId, setExperimentId] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    fetchExperiments()
      .then((list) => {
        setExperiments(list);
        setExperimentId((cur) => cur || activeId || list[0]?.id || '');
      })
      .catch((e) => setMessage({ kind: 'error', text: `Versuche nicht ladbar: ${e.message}` }));
  }, [activeId]);

  const start = async () => {
    if (!experimentId || !file) return;
    setBusy(true);
    setMessage({ kind: 'info', text: 'Lade Firmware & starte Renode …' });
    try {
      const res = await uploadElf(experimentId, file);
      setMessage({ kind: 'ok', text: `„${res.experiment.title}“ läuft` });
      onStarted(res.experiment, false);
    } catch (e) {
      setMessage({ kind: 'error', text: e.message, log: e.log });
    } finally {
      setBusy(false);
    }
  };

  // Musterlösung zum Vergleich: zeigt, wie sich das fertige Programm verhalten soll
  const selected = experiments.find((x) => x.id === experimentId);
  const solution = selected?.solution;
  const startReference = async () => {
    if (!experimentId) return;
    setBusy(true);
    setMessage({ kind: 'info', text: 'Starte Musterlösung …' });
    try {
      const res = await startSolution(experimentId);
      setMessage({ kind: 'ok', text: `„${res.experiment.title}“ läuft mit der Musterlösung` });
      onStarted(res.experiment, true);
    } catch (e) {
      setMessage({ kind: 'error', text: e.message, log: e.log });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopSimulation();
      setMessage({ kind: 'info', text: 'Simulation gestoppt' });
      onStopped();
    } catch (e) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="setup-bar">
      <div className="brand">
        <span className="brand-dot" /> renode4mc-haw · Web-Konsole
      </div>

      <label className="field">
        <span>Versuch</span>
        <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)} disabled={busy}>
          {experiments.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Firmware (.out / .elf)</span>
        <input
          ref={fileInput}
          type="file"
          accept=".out,.elf,.axf"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="actions">
        <button className="btn primary" onClick={start} disabled={busy || !file || !experimentId}>
          {busy ? 'Bitte warten …' : running ? 'Neu starten' : 'Start'}
        </button>
        {solution && (
          <button
            className="btn"
            onClick={startReference}
            disabled={busy || !solution.available}
            title={
              solution.available
                ? `${solution.label}: zum Vergleich, wie sich das fertige Programm verhält`
                : 'Musterlösung nicht gebaut (tools/build-solutions.sh)'
            }
          >
            Musterlösung starten
          </button>
        )}
        {running && (
          <button className="btn" onClick={stop} disabled={busy}>
            Stop
          </button>
        )}
      </div>

      {message && (
        <div className={`message ${message.kind}`}>
          {message.text}
          {message.log?.length > 0 && (
            <details>
              <summary>Renode-Log</summary>
              <pre>{message.log.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </header>
  );
}
