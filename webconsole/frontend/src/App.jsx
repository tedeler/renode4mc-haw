import { useCallback, useEffect, useState } from 'react';
import SetupBar from './components/SetupBar.jsx';
import ControlPanel from './components/ControlPanel.jsx';
import { fetchExperiment, fetchStatus } from './api.js';

/**
 * Ablauf: Versuch wählen -> Bedienelemente erscheinen sofort als Vorschau (ohne Firmware, ohne
 * Verbindung) -> Start -> dieselben Widgets verbinden sich mit der Simulation.
 *
 * running = Versuch, der im Backend läuft ({ experiment, solution }), selectedId = Auswahl.
 * session = was das Bedienfeld zeigt: { experiment, live, solution, terminal, key }.
 * key erzwingt ein frisches Bedienfeld (neue Sockets, leere Widgets); Vorschau -> Start desselben
 * Versuchs behält den key, damit Einstellungen der Vorschau (Abstand, Frequenz, Terminal) bleiben.
 */
export default function App() {
  const [running, setRunning] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [statusKnown, setStatusKnown] = useState(false);
  const [session, setSession] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  useEffect(() => {
    fetchStatus()
      .then((s) => {
        if (s.running && s.experiment) {
          setRunning({ experiment: s.experiment, solution: !!s.solution });
          setSelectedId(s.experiment.id);
        }
      })
      .catch(() => {})
      .finally(() => setStatusKnown(true));
  }, []);

  // Erste Auswahl, wenn nichts läuft: erster Versuch der Liste
  const onListLoaded = useCallback(
    (list) => setSelectedId((cur) => cur || (list.length ? list[0].id : '')),
    [],
  );

  // Auswahl -> laufender Versuch (live) oder Vorschau
  useEffect(() => {
    if (!statusKnown || !selectedId) return undefined;
    setPreviewError(null);
    if (running && running.experiment.id === selectedId) {
      setSession((s) =>
        s && s.live && s.experiment.id === selectedId
          ? s
          : { experiment: running.experiment, live: true, solution: running.solution, key: Date.now() },
      );
      return undefined;
    }
    let cancelled = false;
    fetchExperiment(selectedId)
      .then((r) => {
        if (cancelled) return;
        setSession({ experiment: r.experiment, terminal: r.terminal, live: false, solution: false, key: Date.now() });
      })
      .catch((e) => {
        if (cancelled) return;
        setSession(null);
        setPreviewError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [statusKnown, selectedId, running]);

  const onStarted = (experiment, solution) => {
    setRunning({ experiment, solution: !!solution });
    setSelectedId(experiment.id);
    setSession((s) => ({
      experiment,
      live: true,
      solution: !!solution,
      key: s && !s.live && s.experiment.id === experiment.id ? s.key : Date.now(),
    }));
  };

  // Stop: Bedienfeld bleibt als Vorschau des gewählten Versuchs stehen
  const onStopped = () => setRunning(null);

  const background = running && session && !session.live ? running.experiment.title : null;

  return (
    <div className="app">
      <SetupBar
        running={!!running}
        activeId={running?.experiment.id}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onListLoaded={onListLoaded}
        onStarted={onStarted}
        onStopped={onStopped}
      />
      {session ? (
        <ControlPanel
          key={session.key}
          experiment={session.experiment}
          solution={session.solution}
          live={session.live}
          terminal={session.terminal}
          background={background}
        />
      ) : (
        <div className="placeholder">
          {previewError ? (
            <>Versuch nicht ladbar: {previewError}</>
          ) : (
            <>
              Versuch wählen, die von CCS bzw. <code>make</code> gebaute <code>.out</code>-Datei hochladen und{' '}
              <b>Start</b> klicken.
            </>
          )}
        </div>
      )}
    </div>
  );
}
