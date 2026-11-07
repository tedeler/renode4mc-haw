import { ControlSocketProvider, useControlSocket } from '../context/ControlSocket.jsx';
import UartMonitor from './UartMonitor.jsx';
import Led from './Led.jsx';
import PushButton from './PushButton.jsx';
import OledDisplay from './OledDisplay.jsx';
import DistanceSensor from './DistanceSensor.jsx';
import Keypad from './Keypad.jsx';
import PendulumDisplay from './PendulumDisplay.jsx';
import Widget from './Widget.jsx';
import SimulationPanel from './SimulationPanel.jsx';
import { useState } from 'react';

function Panel({ experiment }) {
  const { status, renodeState, leds, lastError, clearError, send } = useControlSocket();
  const [showSim, setShowSim] = useState(false); // Simulations-Anzeige: standardmäßig aus
  const running = status === 'open' && renodeState === 'running';

  return (
    <main className="control-panel">
      <div className="panel-status">
        <span>
          Control-WS: <b className={`ws-status ${status}`}>{status}</b>
        </span>
        <span>
          Renode: <b className={`renode-${renodeState}`}>{renodeState}</b>
        </span>
        <span className="exp-title">{experiment.title}</span>
        {lastError && (
          <span className="panel-error" onClick={clearError} title="Klicken zum Schließen">
            ⚠ {lastError}
          </span>
        )}
        <span className="panel-buttons">
          {experiment.reset && (
            <button
              className="btn small reset-btn"
              disabled={!running}
              onClick={() => send({ type: 'reset' })}
              title="Reset-Taster des Boards: nur der Mikrocontroller startet neu, die Firmware bleibt geladen"
            >
              ⟲ Reset
            </button>
          )}
          <button
            className={`btn small toggle ${showSim ? 'active' : ''}`}
            onClick={() => setShowSim((v) => !v)}
            aria-pressed={showSim}
            title="Firmware, CPU-Zustand, Simulationszeit und Meldungen anzeigen"
          >
            Simulation
          </button>
        </span>
      </div>

      <div className="grid">
        {showSim && <SimulationPanel />}
        <UartMonitor label={experiment.uart?.label} />

        {experiment.oled && (
          <OledDisplay
            width={experiment.oled.width}
            height={experiment.oled.height}
            label={experiment.oled.label}
          />
        )}

        {experiment.pendulum && (
          <PendulumDisplay
            label={experiment.pendulum.label}
            frequency={experiment.pendulum.frequency}
            minFrequency={experiment.pendulum.minFrequency}
            maxFrequency={experiment.pendulum.maxFrequency}
          />
        )}

        {(experiment.leds?.length > 0 || experiment.buttons?.length > 0) && (
          <Widget title="Board" subtitle="LEDs & Taster" className="gpio">
            <div className="led-row">
              {(experiment.leds || []).map((l) => (
                <Led key={l.id} label={l.label} color={l.color} on={!!leds[l.id]} />
              ))}
            </div>
            <div className="button-row">
              {(experiment.buttons || []).map((b) => (
                <PushButton key={b.id} id={b.id} label={b.label} />
              ))}
            </div>
          </Widget>
        )}

        {experiment.sensor && (
          <DistanceSensor
            min={experiment.sensor.min}
            max={experiment.sensor.max}
            unit={experiment.sensor.unit}
            label={experiment.sensor.label}
          />
        )}

        {experiment.keypad && (
          <Keypad
            layout={experiment.keypad.layout}
            rowPins={experiment.keypad.rowPins}
            colPins={experiment.keypad.colPins}
          />
        )}
      </div>
    </main>
  );
}

/** Control Panel: verbindet sich nach erfolgreichem Upload mit Renode (über die Backend-Bridges). */
export default function ControlPanel({ experiment }) {
  return (
    <ControlSocketProvider>
      <Panel experiment={experiment} />
    </ControlSocketProvider>
  );
}
