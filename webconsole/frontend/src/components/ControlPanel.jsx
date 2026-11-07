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

function Panel({ experiment, solution }) {
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
        {solution && (
          <span className="solution-badge" title={experiment.solution?.label}>
            Musterlösung läuft – so soll es aussehen
          </span>
        )}
        {lastError && (
          <span className="panel-error" onClick={clearError} title="Klicken zum Schließen">
            ⚠ {lastError}
          </span>
        )}
      </div>

      <Diagnostics />

      <div className="grid">
        <UartMonitor label={experiment.uart?.label} localEcho={!!experiment.uart?.localEcho} crlf={!!experiment.uart?.crlf} />

        {experiment.cio && <CioConsole label={experiment.cio.label} />}

        {experiment.bcd && <BcdDisplay label={experiment.bcd.label} />}

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
            afterglowMs={experiment.pendulum.afterglowMs}
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
            initial={experiment.sensor.initial}
            title={experiment.sensor.title}
          />
        )}

        {experiment.keypad && (
          <Keypad
            layout={experiment.keypad.layout}
            rowPins={experiment.keypad.rowPins}
            colPins={experiment.keypad.colPins}
            rowNames={experiment.keypad.rowNames}
            colNames={experiment.keypad.colNames}
            title={experiment.keypad.title}
            label={experiment.keypad.label}
          />
        )}
      </div>
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
