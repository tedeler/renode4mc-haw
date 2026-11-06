import { useEffect, useState } from 'react';
import SetupBar from './components/SetupBar.jsx';
import ControlPanel from './components/ControlPanel.jsx';
import { fetchStatus } from './api.js';

export default function App() {
  // session.key erzwingt bei jedem Start ein frisches Control Panel (neue Sockets, leere Widgets)
  const [session, setSession] = useState(null);

  useEffect(() => {
    fetchStatus()
      .then((s) => s.running && s.experiment && setSession({ experiment: s.experiment, key: Date.now() }))
      .catch(() => {});
  }, []);

  return (
    <div className="app">
      <SetupBar
        running={!!session}
        activeId={session?.experiment.id}
        onStarted={(experiment) => setSession({ experiment, key: Date.now() })}
        onStopped={() => setSession(null)}
      />
      {session ? (
        <ControlPanel key={session.key} experiment={session.experiment} />
      ) : (
        <div className="placeholder">
          Versuch wählen, die von CCS bzw. <code>make</code> gebaute <code>.out</code>-Datei hochladen und{' '}
          <b>Start</b> klicken.
        </div>
      )}
    </div>
  );
}
