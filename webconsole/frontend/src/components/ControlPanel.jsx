import { ControlSocketProvider, useControlSocket } from '../context/ControlSocket.jsx';
import UartMonitor from './UartMonitor.jsx';
import Led from './Led.jsx';
import PushButton from './PushButton.jsx';
import OledDisplay from './OledDisplay.jsx';
import DistanceSensor from './DistanceSensor.jsx';
import Keypad from './Keypad.jsx';
import PendulumDisplay from './PendulumDisplay.jsx';
import Widget from './Widget.jsx';

function Panel({ experiment }) {
  const { status, renodeState, leds, lastError, clearError } = useControlSocket();

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
      </div>

      <div className="grid">
        <UartMonitor label={experiment.uart?.label} />

        {experiment.oled && (
          <OledDisplay
            width={experiment.oled.width}
            height={experiment.oled.height}
            label={experiment.oled.label}
          />
        )}

        {experiment.pendulum && (
          <PendulumDisplay label={experiment.pendulum.label} frequency={experiment.pendulum.frequency} />
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
