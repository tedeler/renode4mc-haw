import { useEffect, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

/**
 * Simulations-Anzeige: welche Firmware läuft, Zustand der CPU, Simulationszeit und Tempo,
 * UART-Einstellung von Firmware und Terminal, Resets und Meldungen von Renode.
 * Abo über {type:"watch", sim:true}; das Backend schickt dann alle 500 ms {type:"sim", …}.
 */

const de = (v, digits = 0) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function seconds(ns) {
  return `${de(ns / 1e9, 6)} s`;
}

function wall(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h} h ` : ''}${m} min ${s % 60} s`;
}

const STATES = {
  Running: ['läuft', 'sim-ok'],
  Paused: ['angehalten', 'sim-warn'],
  InReset: ['im Reset', 'sim-warn'],
  Aborted: ['abgebrochen', 'sim-bad'],
  Halted: ['angehalten', 'sim-warn'],
};

// Endlosschleifen im Startup-Code (startup_tm4c1294.c): nicht behandelter Interrupt oder Fault
const TRAP_RE = /^(IntDefaultHandler|FaultISR|HardFault_Handler|MemManage_Handler|BusFault_Handler|UsageFault_Handler|NMI_Handler)$/;

function UartLine({ uart }) {
  if (!uart || !uart.mcu || !uart.terminal) return null;
  const { mcu, terminal } = uart;
  const configured = mcu.baud > 0;
  const dev = configured ? ((mcu.baud - terminal.baud) / terminal.baud) * 100 : null;
  const ok = configured && Math.abs(dev) <= 2.5 && mcu.format === terminal.format;
  return (
    <>
      <dt>Firmware</dt>
      <dd>{configured ? `${de(mcu.baud, 1)} Baud ${mcu.format}` : 'nicht eingestellt'}</dd>
      <dt>Terminal</dt>
      <dd>{`${terminal.baud} Baud ${terminal.format}`}</dd>
      <dt>Passt?</dt>
      <dd className={ok ? 'sim-ok' : configured ? 'sim-bad' : 'sim-warn'}>
        {!configured
          ? 'UART0 noch nicht konfiguriert'
          : ok
            ? `ja (Abweichung ${de(dev, 2)} %)`
            : mcu.format !== terminal.format
              ? `nein – Format ${mcu.format} ≠ ${terminal.format}`
              : `nein – Abweichung ${de(dev, 1)} %`}
      </dd>
    </>
  );
}

export default function SimulationPanel() {
  const { send, status, subscribeMessage } = useControlSocket();
  const [sim, setSim] = useState(null);

  useEffect(() => subscribeMessage(['sim'], setSim), [subscribeMessage]);

  // Abo nach jedem (Re-)Connect erneuern, beim Schließen abbestellen
  useEffect(() => {
    if (status !== 'open') return undefined;
    send({ type: 'watch', sim: true });
    return () => send({ type: 'watch', sim: false });
  }, [status, send]);

  const cpu = sim && sim.cpu;
  const [stateText, stateClass] = cpu ? STATES[cpu.state] || [cpu.state, ''] : ['–', ''];
  const trapped = cpu && cpu.symbol && TRAP_RE.test(cpu.symbol);

  return (
    <Widget title="Simulation" subtitle={sim ? sim.experiment.title : 'warte auf Daten …'} className="sim">
      {sim && (
        <>
          <div className="sim-grid">
            <div>
              <h4>Firmware</h4>
              <dl>
                <dt>Datei</dt>
                <dd>{sim.firmware ? sim.firmware.name : 'unbekannt (vor dem Neustart des Servers geladen)'}</dd>
                {sim.firmware && (
                  <>
                    <dt>Größe</dt>
                    <dd>{`${de(sim.firmware.size / 1024, 1)} KB`}</dd>
                    <dt>SHA-256</dt>
                    <dd>
                      <code>{sim.firmware.sha256}…</code>
                    </dd>
                    <dt>Geladen</dt>
                    <dd>{new Date(sim.firmware.loadedAt).toLocaleTimeString('de-DE')}</dd>
                  </>
                )}
              </dl>
            </div>

            <div>
              <h4>CPU</h4>
              <dl>
                <dt>Zustand</dt>
                <dd className={stateClass}>
                  {stateText}
                  {cpu && cpu.halted ? ' – wartet (WFI)' : ''}
                </dd>
                <dt>PC</dt>
                <dd>
                  <code>{cpu ? cpu.pc : '–'}</code>
                  {cpu && cpu.symbol ? <> in <code>{cpu.symbol}()</code></> : ''}
                </dd>
                {trapped && (
                  <>
                    <dt />
                    <dd className="sim-bad">
                      Endlosschleife im Startup-Code: nicht behandelter Interrupt oder Fault (Handler in der
                      Vektortabelle? Takt der Peripherie freigegeben?)
                    </dd>
                  </>
                )}
                <dt>Systemtakt</dt>
                <dd>{cpu ? `${de(cpu.sysclk / 1e6, 3)} MHz` : '–'}</dd>
                <dt>Resets</dt>
                <dd>
                  {sim.resets
                    ? sim.resets.count
                      ? `${sim.resets.count}, zuletzt bei ${seconds(sim.resets.lastNs)}`
                      : 'keiner seit dem Start'
                    : '–'}
                </dd>
              </dl>
            </div>

            <div>
              <h4>Zeit</h4>
              <dl>
                <dt>Simulationszeit</dt>
                <dd>{sim.time ? seconds(sim.time.virtualNs) : '–'}</dd>
                <dt>Echtzeit</dt>
                <dd>{sim.time ? wall(sim.time.wallMs) : '–'}</dd>
                <dt>Tempo</dt>
                <dd className={sim.time && sim.time.speed !== null && sim.time.speed < 0.5 ? 'sim-warn' : ''}>
                  {sim.time && sim.time.speed !== null ? `${de(sim.time.speed, 2)} × Echtzeit` : '–'}
                </dd>
                <dt>Renode</dt>
                <dd>{sim.renode.version || '–'}</dd>
              </dl>
            </div>

            {sim.uart && (
              <div>
                <h4>UART0</h4>
                <dl>
                  <UartLine uart={sim.uart} />
                </dl>
              </div>
            )}
          </div>

          <div className="sim-messages">
            <h4>Meldungen von Renode {sim.warnings.length ? `(${sim.warnings.length})` : ''}</h4>
            {sim.warnings.length === 0 ? (
              <span className="sim-ok">keine</span>
            ) : (
              <ul>
                {[...sim.warnings].reverse().map((w) => (
                  <li key={w.text} className={w.level === 'error' ? 'sim-bad' : 'sim-warn'}>
                    {w.text}
                    {w.count > 1 && <span className="count">×{w.count}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Widget>
  );
}
