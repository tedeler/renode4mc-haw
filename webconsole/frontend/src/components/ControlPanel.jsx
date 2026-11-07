import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ControlSocketProvider, useControlSocket } from '../context/ControlSocket.jsx';
import UartMonitor from './UartMonitor.jsx';
import Led from './Led.jsx';
import PushButton from './PushButton.jsx';
import OledDisplay from './OledDisplay.jsx';
import DistanceSensor from './DistanceSensor.jsx';
import Keypad from './Keypad.jsx';
import PendulumDisplay from './PendulumDisplay.jsx';
import Widget from './Widget.jsx';
import BcdDisplay from './BcdDisplay.jsx';
import CioConsole from './CioConsole.jsx';
import Diagnostics from './Diagnostics.jsx';
import Oscilloscope from './Oscilloscope.jsx';
import SimulationPanel from './SimulationPanel.jsx';
import Workspace from '../layout/Workspace.jsx';

// Zusatzwerkzeuge (ein-/ausblendbar), Zustand bleibt im Browser gespeichert
function useToolToggle(key) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOn((v) => {
      try {
        localStorage.setItem(key, v ? '0' : '1');
      } catch {
        /* ohne Speicher */
      }
      return !v;
    });
  return [on, toggle];
}

/** Verbindungs- und Versuchsstatus, angezeigt in der Kopfzeile (Platz "hdr-status" der Setup-Leiste). */
function SessionStatus({ experiment, solution }) {
  const { status, renodeState, lastError, clearError } = useControlSocket();
  const [el, setEl] = useState(null);
  useEffect(() => setEl(document.getElementById('hdr-status')), []);
  if (!el) return null;
  return createPortal(
    <div className="session-status">
      <span className="exp-title" title={experiment.title}>
        {experiment.title}
      </span>
      {solution && (
        <span className="solution-badge" title={experiment.solution?.label}>
          Musterlösung
        </span>
      )}
      <span className={`dot ws-${status}`} title={`Control-WebSocket: ${status}`}>
        WS
      </span>
      <span className={`dot renode-${renodeState}`} title={`Renode: ${renodeState}`}>
        Renode
      </span>
      {lastError && (
        <span className="panel-error" onClick={clearError} title={`${lastError} – klicken zum Schließen`}>
          ⚠ {lastError}
        </span>
      )}
    </div>,
    el,
  );
}

function Board({ experiment }) {
  const { leds } = useControlSocket();
  return (
    <Widget title="Board" subtitle="LEDs & Taster" className="gpio">
      <div className="board-row">
        {experiment.leds?.length > 0 && (
          <div className="led-row">
            {experiment.leds.map((l) => (
              <Led key={l.id} label={l.label} color={l.color} on={!!leds[l.id]} />
            ))}
          </div>
        )}
        {experiment.buttons?.length > 0 && (
          <div className="button-row">
            {experiment.buttons.map((b) => (
              <PushButton key={b.id} id={b.id} label={b.label} />
            ))}
          </div>
        )}
      </div>
    </Widget>
  );
}

/**
 * Panels des Versuchs. zone bestimmt die Standardspalte (Anzeigen | Terminals | Bedienelemente),
 * grow den Anteil an der Spaltenhöhe (0 = natürliche Höhe), minH die kleinste Höhe auf dem Desktop.
 */
function usePanels(experiment, scopeOn, simOn) {
  const { diagnostics } = useControlSocket();
  const diagAlert = diagnostics.some((d) => d.level === 'error') ? 'error' : diagnostics.length ? 'warning' : null;
  const e = experiment;
  const base = useMemo(() => {
    const list = [];
    if (scopeOn)
      list.push({
        id: 'scope',
        title: 'Oszilloskop',
        zone: 'visual',
        grow: 3,
        minH: 260,
        el: <Oscilloscope experimentId={e.id} scope={e.scope} />,
      });
    if (simOn)
      list.push({
        id: 'sim',
        title: 'Simulation',
        zone: 'visual',
        grow: 3,
        minH: 280,
        el: <SimulationPanel debug={e.debug} />,
      });
    if (e.pendulum)
      list.push({
        id: 'pendulum',
        title: 'Pendel',
        zone: 'visual',
        grow: 3,
        minH: 240,
        el: (
          <PendulumDisplay
            label={e.pendulum.label}
            frequency={e.pendulum.frequency}
            minFrequency={e.pendulum.minFrequency}
            maxFrequency={e.pendulum.maxFrequency}
            afterglowMs={e.pendulum.afterglowMs}
          />
        ),
      });
    if (e.oled)
      list.push({
        id: 'oled',
        title: 'OLED',
        zone: 'visual',
        grow: 2,
        minH: 150,
        el: <OledDisplay width={e.oled.width} height={e.oled.height} label={e.oled.label} />,
      });
    if (e.bcd)
      list.push({
        id: 'bcd',
        title: '7-Segment',
        zone: 'visual',
        grow: 1.2,
        minH: 150,
        el: <BcdDisplay label={e.bcd.label} />,
      });
    if (e.keypad)
      list.push({
        id: 'keypad',
        title: 'Keypad',
        zone: 'visual',
        grow: 2,
        minH: 200,
        el: (
          <Keypad
            layout={e.keypad.layout}
            rowPins={e.keypad.rowPins}
            colPins={e.keypad.colPins}
            rowNames={e.keypad.rowNames}
            colNames={e.keypad.colNames}
            title={e.keypad.title}
            label={e.keypad.label}
          />
        ),
      });
    list.push({
      id: 'uart',
      title: 'UART',
      zone: 'io',
      grow: 3,
      minH: 170,
      el: <UartMonitor label={e.uart?.label} localEcho={!!e.uart?.localEcho} crlf={!!e.uart?.crlf} />,
    });
    if (e.cio)
      list.push({ id: 'cio', title: 'printf', zone: 'io', grow: 2, minH: 130, el: <CioConsole label={e.cio.label} /> });
    if (e.leds?.length > 0 || e.buttons?.length > 0)
      list.push({ id: 'board', title: 'Board', zone: 'control', grow: 0, el: <Board experiment={e} /> });
    if (e.sensor)
      list.push({
        id: 'sensor',
        title: 'Sensor',
        zone: 'control',
        grow: 0,
        el: (
          <DistanceSensor
            min={e.sensor.min}
            max={e.sensor.max}
            unit={e.sensor.unit}
            label={e.sensor.label}
            initial={e.sensor.initial}
            title={e.sensor.title}
          />
        ),
      });
    list.push({ id: 'diag', title: 'Diagnose', zone: 'control', grow: 0, minH: 90, el: <Diagnostics /> });
    return list;
  }, [e, scopeOn, simOn]);
  return useMemo(
    () => base.map((p) => (p.id === 'diag' ? { ...p, alert: diagAlert, grow: diagAlert ? 1 : 0 } : p)),
    [base, diagAlert],
  );
}

function Panel({ experiment, solution }) {
  const { status, renodeState, send } = useControlSocket();
  const running = status === 'open' && renodeState === 'running';
  const [scopeOn, toggleScope] = useToolToggle('tool.oscilloscope');
  // Simulations-Anzeige (Firmware, CPU, Debugger, Register): standardmäßig aus
  const [simOn, toggleSim] = useToolToggle('tool.simulation');
  const panels = usePanels(experiment, scopeOn, simOn);
  const tools = (
    <>
      {experiment.reset && (
        <button
          className="btn small tool-btn reset-btn"
          disabled={!running}
          onClick={() => send({ type: 'reset' })}
          title="Reset-Taster des Boards: nur der Mikrocontroller startet neu, die Firmware bleibt geladen"
        >
          ⟲ Reset
        </button>
      )}
      <button
        className={`btn small tool-btn ${simOn ? 'on' : ''}`}
        onClick={toggleSim}
        aria-pressed={simOn}
        title="Firmware, CPU-Zustand, Debugger, Register und Meldungen anzeigen"
      >
        Simulation
      </button>
      <button
        className={`btn small tool-btn ${scopeOn ? 'on' : ''}`}
        onClick={toggleScope}
        aria-pressed={scopeOn}
        title={`Oszilloskop ${scopeOn ? 'ausblenden' : 'einblenden'}`}
      >
      〰 Oszi
      </button>
    </>
  );
  return (
    <main className="control-panel">
      <SessionStatus experiment={experiment} solution={solution} />
      <Workspace layoutKey={experiment.id ?? experiment.title} panels={panels} extraTools={tools} />
    </main>
  );
}

/** Control Panel: verbindet sich nach erfolgreichem Upload mit Renode (über die Backend-Bridges). */
export default function ControlPanel({ experiment, solution = false }) {
  return (
    <ControlSocketProvider>
      <Panel experiment={experiment} solution={solution} />
    </ControlSocketProvider>
  );
}
