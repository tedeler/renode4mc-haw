import { useEffect, useRef, useState } from 'react';
import { fetchExperiments, startSolution, stopSimulation, uploadElf } from '../api.js';
import AboutDialog from './AboutDialog.jsx';
import hawLogo from '../assets/haw-logo.png';

/**
 * Kopfzeile: Versuchsauswahl, ELF-Upload, Start/Stop. Die Auswahl gehört der App (selectedId):
 * Sie zeigt die Bedienelemente des gewählten Versuchs sofort, auch ohne Firmware.
 */
export default function SetupBar({ running, activeId, selectedId, onSelect, onListLoaded, onStarted, onStopped }) {
  const [experiments, setExperiments] = useState([]);
  const experimentId = selectedId;
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileInput = useRef(null);
  const headerRef = useRef(null);
  // Mobil: Einstellungen einklappbar, nach dem Start eingeklappt (Platz für die Panels)
  const [open, setOpen] = useState(!running);
  const [about, setAbout] = useState(false);
  useEffect(() => setOpen(!running), [running]);

  // Höhe der Kopfzeile für Sprungziele (scroll-margin) und Auto-Scroll beim Verschieben
  useEffect(() => {
    const el = headerRef.current;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--hdr-h', `${el.getBoundingClientRect().height}px`),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fetchExperiments()
      .then((list) => {
        setExperiments(list);
        onListLoaded(list);
      })
      .catch((e) => setMessage({ kind: 'error', text: `Versuche nicht ladbar: ${e.message}` }));
  }, [activeId, onListLoaded]);

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
    <header className={`setup-bar ${open ? 'open' : 'closed'}`} ref={headerRef}>
      <AboutDialog open={about} onClose={() => setAbout(false)} />
      <div className="setup-top">
        <div className="brand" title="renode4mc-haw · Web-Konsole">
          <button type="button" className="brand-logo" onClick={() => setAbout(true)} title="Über diese Web-Konsole">
            <img src={hawLogo} alt="HAW Hamburg – Über diese Web-Konsole" />
          </button>
          <span className="brand-long">renode4mc-haw · Web-Konsole</span>
          <span className="brand-short">renode4mc</span>
        </div>
        <div id="hdr-status" className="hdr-status" />
        <button
          type="button"
          className="btn small setup-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title="Versuch, Firmware, Start/Stop"
        >
          {open ? 'Setup ▴' : 'Setup ▾'}
        </button>
      </div>

      <div className="setup-form">
        <label className="field">
          <span>Versuch</span>
          <select value={experimentId} onChange={(e) => onSelect(e.target.value)} disabled={busy}>
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
            {busy ? 'Bitte warten …' : running && activeId === experimentId ? 'Neu starten' : 'Start'}
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
              Musterlösung
            </button>
          )}
          {running && (
            <button className="btn" onClick={stop} disabled={busy}>
              Stop
            </button>
          )}
        </div>

        {message && (
          <div className={`message ${message.kind}`} title={message.text}>
            <span className="message-text">{message.text}</span>
            {message.log?.length > 0 && (
              <details>
                <summary>Renode-Log</summary>
                <pre>{message.log.join('\n')}</pre>
              </details>
            )}
            <button
              type="button"
              className="message-close"
              onClick={() => setMessage(null)}
              aria-label="Meldung schließen"
            >
              ×
            </button>
          </div>
        )}
      </div>

      <div id="hdr-tools" className="hdr-tools" />
    </header>
  );
}
