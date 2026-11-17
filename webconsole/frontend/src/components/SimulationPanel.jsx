import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

/**
 * Simulations-Anzeige: welche Firmware läuft, Zustand der CPU, Simulationszeit und Tempo,
 * UART-Einstellung von Firmware und Terminal, Resets und Meldungen von Renode.
 * Dazu ein kleiner Debugger: Pause/Weiter/Einzelschritt, Kernregister mit Disassembly,
 * Speicher (Adresse oder Symbol) und Peripherie-Register mit den Namen aus tm4c1294ncpdt.h.
 *
 * Abo über {type:"watch", sim:true, memory, periph}; das Backend schickt dann alle 500 ms und
 * nach jedem Befehl {type:"sim", …}.
 */

const num = (v, digits = 0) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hex8 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const seconds = (ns) => `${num(ns / 1e9, 6)} s`;

function wall(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h} h ` : ''}${m} min ${s % 60} s`;
}

const STATES = {
  Running: ['running', 'sim-ok'],
  Paused: ['paused', 'sim-warn'],
  Step: ['paused (single step)', 'sim-warn'],
  Wake: ['stepping until the next interrupt', 'sim-warn'],
  InReset: ['in reset', 'sim-warn'],
  Aborted: ['aborted', 'sim-bad'],
  Halted: ['halted', 'sim-warn'],
};

// Endlosschleifen im Startup-Code (startup_tm4c1294.c): nicht behandelter Interrupt oder Fault
const TRAP_RE = /^(IntDefaultHandler|FaultISR|HardFault_Handler|MemManage_Handler|BusFault_Handler|UsageFault_Handler|NMI_Handler)$/;

const EXCEPTIONS = { 0: 'Thread mode', 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 11: 'SVCall', 14: 'PendSV', 15: 'SysTick' };

function exceptionName(n) {
  if (EXCEPTIONS[n]) return EXCEPTIONS[n];
  if (n >= 16) return `IRQ ${n - 16}`;
  return `No. ${n}`;
}

/** Werte der vorigen Nachricht (gleiche Quelle), um Änderungen hervorzuheben */
function usePrevious(source, values) {
  const last = useRef({ source: null, values: null, prev: null });
  if (last.current.source !== source) {
    last.current = { source, values, prev: last.current.values };
  }
  return last.current.prev || {};
}

function UartLine({ uart }) {
  if (!uart || !uart.mcu || !uart.terminal) return null;
  const { mcu, terminal } = uart;
  const configured = mcu.baud > 0;
  const dev = configured ? ((mcu.baud - terminal.baud) / terminal.baud) * 100 : null;
  const ok = configured && Math.abs(dev) <= 2.5 && mcu.format === terminal.format;
  return (
    <>
      <dt>Firmware</dt>
      <dd>{configured ? `${num(mcu.baud, 1)} baud ${mcu.format}` : 'not set'}</dd>
      <dt>Terminal</dt>
      <dd>{`${terminal.baud} baud ${terminal.format}`}</dd>
      <dt>Match?</dt>
      <dd className={ok ? 'sim-ok' : configured ? 'sim-bad' : 'sim-warn'}>
        {!configured
          ? 'UART0 not configured yet'
          : ok
            ? `yes (error ${num(dev, 2)} %)`
            : mcu.format !== terminal.format
              ? `no – format ${mcu.format} ≠ ${terminal.format}`
              : `no – error ${num(dev, 1)} %`}
      </dd>
    </>
  );
}

// Anteil an der Simulationszeit in Prozent
const pct = (part, whole) => (whole > 0 ? (100 * part) / whole : 0);
const usTime = (ns) => (ns >= 1e6 ? `${num(ns / 1e6, 2)} ms` : `${num(ns / 1e3, 1)} µs`);

/** Balken Schlaf / ISR / Normalbetrieb für einen Zeitraum */
function CpuTimeBar({ w, label }) {
  if (!w || !(w.ns > 0)) {
    return (
      <>
        <dt>{label}</dt>
        <dd>–</dd>
      </>
    );
  }
  const parts = [
    ['sleep', 'Sleep', w.sleepNs],
    ['isr', 'ISR', w.isrNs],
    ['normal', 'Normal', w.normalNs],
  ];
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <div className="cpu-bar" title={parts.map(([, n, v]) => `${n} ${num(pct(v, w.ns), 2)} %`).join(' · ')}>
          {parts.map(([k, , v]) => (
            <span key={k} className={`cpu-${k}`} style={{ width: `${pct(v, w.ns)}%` }} />
          ))}
        </div>
        <span className="cpu-legend">
          {parts.map(([k, n, v]) => (
            <span key={k}>
              <i className={`cpu-${k}`} />
              {n} {num(pct(v, w.ns), pct(v, w.ns) < 10 ? 2 : 1)} %
            </span>
          ))}
        </span>
      </dd>
    </>
  );
}

/** Reiter "CPU-Zeit": Anteile, Zahlen und je Interrupt-Routine */
function CpuStats({ sim, onReset }) {
  const cs = sim.cpuStats;
  if (!cs) return <p className="sim-note">No statistics (this experiment has no status model).</p>;
  const t = cs.total;
  const rows = [...cs.vectors].sort((a, b) => b.ns - a.ns);
  return (
    <div>
      <div className="sim-grid">
        <div>
          <h4>Share of simulated time</h4>
          <dl>
            <CpuTimeBar w={t} label="since start" />
            <CpuTimeBar w={cs.recent} label="recently" />
          </dl>
        </div>
        <div>
          <h4>Since start / reset</h4>
          <dl>
            <dt>Period</dt>
            <dd>{seconds(t.ns)}</dd>
            <dt>Sleep (WFI)</dt>
            <dd>{`${usTime(t.sleepNs)} · ${num(pct(t.sleepNs, t.ns), 3)} %`}</dd>
            <dt>Interrupt routines</dt>
            <dd>{`${usTime(t.isrNs)} · ${num(pct(t.isrNs, t.ns), 3)} % · ${t.isrCount} calls`}</dd>
            <dt>Normal operation</dt>
            <dd>{`${usTime(t.normalNs)} · ${num(pct(t.normalNs, t.ns), 3)} %`}</dd>
            <dt>Instructions</dt>
            <dd>{`${num(t.instr)} · woke up ${t.wakes} ×`}</dd>
          </dl>
        </div>
      </div>
      {rows.length > 0 && (
        <table className="periph cpu-table">
          <thead>
            <tr>
              <th>Interrupt</th>
              <th>Vector</th>
              <th>Calls</th>
              <th>Time</th>
              <th>Share</th>
              <th>Per call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.vector}>
                <td>
                  <code>{v.name}</code>
                </td>
                <td>{v.vector}</td>
                <td>{v.count}</td>
                <td>{usTime(v.ns)}</td>
                <td>{`${num(pct(v.ns, t.ns), 3)} %`}</td>
                <td>{v.count ? `${num(v.instr / v.count, 1)} instr. · ${usTime(v.ns / v.count)}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="sim-note">
        Awake time = executed instructions × Renode's time per instruction ({num(cs.nsPerInstr, 1)} ns), sleep = the
        rest. ISR = from entry to return (for nested interrupts, each vector without the inner ones). Register stacking
        on entry (12 clock cycles on the board) and flash wait states are not modelled – the values show the ratios,
        not the exact timing of the board. A reset of the MCU restarts the statistics.{' '}
        <button className="btn small" onClick={onReset}>
          Restart statistics
        </button>
      </p>
    </div>
  );
}

function Overview({ sim }) {
  const cpu = sim.cpu;
  const [stateText, stateClass] = cpu ? STATES[cpu.state] || [cpu.state, ''] : ['–', ''];
  const trapped = cpu && cpu.symbol && TRAP_RE.test(cpu.symbol);
  return (
    <div className="sim-grid">
      <div>
        <h4>Firmware</h4>
        <dl>
          <dt>File</dt>
          <dd>{sim.firmware ? sim.firmware.name : 'unknown (loaded before the server restarted)'}</dd>
          {sim.firmware && (
            <>
              <dt>Size</dt>
              <dd>{`${num(sim.firmware.size / 1024, 1)} KB`}</dd>
              <dt>SHA-256</dt>
              <dd>
                <code>{sim.firmware.sha256}…</code>
              </dd>
              <dt>Loaded</dt>
              <dd>{new Date(sim.firmware.loadedAt).toLocaleTimeString('en-GB')}</dd>
            </>
          )}
        </dl>
      </div>

      <div>
        <h4>CPU</h4>
        <dl>
          <dt>State</dt>
          {/* Immer zwei Zeilen (Zustand, Schlaf-Hinweis), zu lang -> „…“: Layout springt nicht */}
          <dd className={`sim-2l ${stateClass}`}>
            <span title={stateText}>{stateText}</span>
            <span title={cpu && cpu.halted ? 'sleeping (WFI), waiting for an interrupt' : undefined}>
              {cpu && cpu.halted ? 'sleeping (WFI), waiting for an interrupt' : '\u00a0'}
            </span>
          </dd>
          <dt>PC</dt>
          {/* Immer zwei Zeilen (Adresse, Funktion), zu lange Namen mit „…“ gekürzt: Layout springt nicht */}
          <dd className="sim-2l">
            <code>{cpu ? cpu.pc : '–'}</code>
            <span title={cpu && cpu.symbol ? `${cpu.symbol}()` : undefined}>
              {cpu && cpu.symbol ? (
                <>
                  in <code>{cpu.symbol}()</code>
                </>
              ) : (
                '\u00a0'
              )}
            </span>
          </dd>
          {trapped && (
            <>
              <dt />
              <dd className="sim-bad">
                Endless loop in the startup code: unhandled interrupt or fault (Is the handler in the vector table? Is
                the clock of the peripheral enabled?)
              </dd>
            </>
          )}
          <dt>System clock</dt>
          <dd>{cpu ? `${num(cpu.sysclk / 1e6, 3)} MHz` : '–'}</dd>
          <dt>Resets</dt>
          <dd>
            {sim.resets
              ? sim.resets.count
                ? `${sim.resets.count}, last at ${seconds(sim.resets.lastNs)}`
                : 'none since start'
              : '–'}
          </dd>
        </dl>
      </div>

      <div>
        <h4>Time</h4>
        <dl>
          <dt>Simulated time</dt>
          <dd>{sim.time ? seconds(sim.time.virtualNs) : '–'}</dd>
          <dt>Real time</dt>
          <dd>{sim.time ? wall(sim.time.wallMs) : '–'}</dd>
          <dt>Speed</dt>
          <dd className={sim.time && sim.time.speed !== null && sim.time.speed < 0.5 && !sim.stopped ? 'sim-warn' : ''}>
            {sim.stopped ? 'paused' : sim.time && sim.time.speed !== null ? `${num(sim.time.speed, 2)} × real time` : '–'}
          </dd>
          <dt>Renode</dt>
          <dd>{sim.renode.version || '–'}</dd>
        </dl>
      </div>

      {sim.cpuStats && (
        <div>
          <h4>CPU time</h4>
          <dl>
            <CpuTimeBar w={sim.cpuStats.total} label="since start" />
            <CpuTimeBar w={sim.cpuStats.recent} label="recently" />
          </dl>
        </div>
      )}

      {sim.uart && (
        <div>
          <h4>UART0</h4>
          <dl>
            <UartLine uart={sim.uart} />
          </dl>
        </div>
      )}
    </div>
  );
}

function Registers({ sim }) {
  const values = sim.regs ? Object.fromEntries(sim.regs.map((r) => [r.name, r.value])) : null;
  const prev = usePrevious(sim, values);
  if (!sim.regs) return <p className="sim-note">No register data.</p>;
  const xpsr = values.xPSR;
  return (
    <div className="sim-regs">
      <div>
        <div className="reg-grid">
          {sim.regs.map((r) => (
            <div key={r.name} className={`reg ${prev[r.name] !== undefined && prev[r.name] !== r.value ? 'sim-changed' : ''}`}>
              <span className="reg-name">{r.name}</span>
              <code>{hex8(r.value)}</code>
            </div>
          ))}
        </div>
        {xpsr !== undefined && (
          <p className="sim-note">
            Flags{' '}
            <code>
              {['N', 'Z', 'C', 'V'].map((f, i) => ((xpsr >>> (31 - i)) & 1 ? f : f.toLowerCase())).join(' ')}
            </code>
            {' · '}Exception {xpsr & 0x1ff}: {exceptionName(xpsr & 0x1ff)}
            {values.PRIMASK & 1 ? ' · interrupts disabled (PRIMASK)' : ''}
          </p>
        )}
      </div>
      <div>
        <h4>Next instructions</h4>
        {sim.disasm && sim.disasm.length ? (
          <ol className="disasm">
            {sim.disasm.map((d, i) => (
              <li key={d.addr} className={i === 0 ? 'current' : ''}>
                <code className="addr">{hex8(d.addr)}</code>
                <code className="bytes">{d.bytes}</code>
                <code>{d.text}</code>
              </li>
            ))}
          </ol>
        ) : (
          <p className="sim-note">Only visible while the simulation is paused (Pause or Step).</p>
        )}
      </div>
    </div>
  );
}

function Memory({ sim, request, onRequest }) {
  const [text, setText] = useState(request.addr);
  const mem = sim.memory;
  const bytes = mem && mem.data ? mem.data.match(/../g).map((h) => parseInt(h, 16)) : [];
  const values = mem && mem.data ? { key: `${mem.addr}`, data: bytes } : null;
  const prevRef = useRef(null);
  const prev = prevRef.current && values && prevRef.current.key === values.key ? prevRef.current.data : null;
  useEffect(() => {
    prevRef.current = values;
  });
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) rows.push(i);
  const apply = (e) => {
    e.preventDefault();
    onRequest({ ...request, addr: text.trim() });
  };
  return (
    <div>
      <form className="sim-form" onSubmit={apply}>
        <label>
          Address or symbol
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x20000000 or ticks" />
        </label>
        <label>
          Bytes
          <select value={request.count} onChange={(e) => onRequest({ ...request, count: Number(e.target.value) })}>
            {[64, 128, 256, 512].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" type="submit">
          Show
        </button>
        <span className="sim-note">Flash 0x00000000–0x000FFFFF, SRAM 0x20000000–0x2003FFFF (peripherals: tab "Peripherals")</span>
      </form>
      {mem && mem.error && <p className="sim-bad">{mem.error}</p>}
      {mem && mem.symbol && (
        <p className="sim-note">
          <code>{mem.symbol}</code> is at <code>0x{hex8(mem.addr)}</code>
        </p>
      )}
      {bytes.length > 0 && (
        <pre className="hexdump">
          {rows.map((o) => (
            <div key={o}>
              <span className="addr">{hex8(mem.addr + o)}</span>
              {'  '}
              {bytes.slice(o, o + 16).map((b, j) => (
                <span key={j} className={prev && prev[o + j] !== b ? 'sim-changed' : ''}>
                  {b.toString(16).toUpperCase().padStart(2, '0')}
                  {j === 7 ? '  ' : ' '}
                </span>
              ))}
              {' '}
              <span className="ascii">
                {bytes
                  .slice(o, o + 16)
                  .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
                  .join('')}
              </span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function Peripheral({ sim, modules, module, onModule }) {
  const p = sim.periph;
  const values = p ? Object.fromEntries(p.regs.map((r) => [r.addr, r.value])) : null;
  const prevRef = useRef(null);
  const prev = prevRef.current && p && prevRef.current.module === p.module ? prevRef.current.values : null;
  useEffect(() => {
    prevRef.current = p && { module: p.module, values };
  });
  return (
    <div>
      <form className="sim-form" onSubmit={(e) => e.preventDefault()}>
        <label>
          Module
          <select value={module || ''} onChange={(e) => onModule(e.target.value || null)}>
            <option value="">– choose –</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <span className="sim-note">Names from tm4c1294ncpdt.h; read without side effects (reading UARTDR here does not take anything out of the FIFO)</span>
      </form>
      {p && p.noClock && <p className="sim-warn">The module has no clock (RCGC bit not set) – its registers cannot be read.</p>}
      {p && !p.noClock && (
        <table className="periph">
          <thead>
            <tr>
              <th>Register</th>
              <th>Address</th>
              <th>Value</th>
              <th>Bits 31 … 0</th>
            </tr>
          </thead>
          <tbody>
            {p.regs.map((r) => (
              <tr key={r.name} className={prev && prev[r.addr] !== r.value ? 'sim-changed' : ''}>
                <td>
                  <code>{r.name}</code>
                </td>
                <td>
                  <code>{hex8(r.addr)}</code>
                </td>
                <td>
                  <code>{r.value === null ? '–' : `0x${hex8(r.value)}`}</code>
                </td>
                <td>
                  <code className="bits">
                    {r.value === null ? '' : (r.value >>> 0).toString(2).padStart(32, '0').match(/..../g).join(' ')}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Messages({ sim }) {
  if (sim.warnings.length === 0) return <span className="sim-ok">none</span>;
  return (
    <ul className="sim-messages">
      {[...sim.warnings].reverse().map((w) => (
        <li key={w.text} className={w.level === 'error' ? 'sim-bad' : 'sim-warn'}>
          {w.text}
          {w.count > 1 && <span className="count">×{w.count}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function SimulationPanel({ debug = false }) {
  const { send, status, subscribeMessage } = useControlSocket();
  const [sim, setSim] = useState(null);
  const [modules, setModules] = useState([]);
  const [tab, setTab] = useState('regs');
  const [memory, setMemory] = useState({ addr: '0x20000000', count: 128 });
  const [periph, setPeriph] = useState('UART0');
  const [steps, setSteps] = useState(1);

  useEffect(() => subscribeMessage(['sim'], setSim), [subscribeMessage]);
  useEffect(() => subscribeMessage(['simmeta'], (m) => setModules(m.modules || [])), [subscribeMessage]);

  // Abo nach jedem (Re-)Connect und bei geänderter Auswahl erneuern, beim Schließen abbestellen
  useEffect(() => {
    if (status !== 'open') return undefined;
    send({
      type: 'watch',
      sim: true,
      memory: tab === 'memory' ? memory : undefined,
      periph: tab === 'periph' ? periph : undefined,
    });
    return undefined;
  }, [status, send, tab, memory, periph]);
  useEffect(() => () => send({ type: 'watch', sim: false }), [send]);

  const stopped = sim && sim.stopped;
  const tabs = [
    ['regs', 'CPU registers'],
    ['cpustats', 'CPU time'],
    ['memory', 'Memory'],
    ['periph', 'Peripherals'],
    ['messages', `Messages${sim && sim.warnings.length ? ` (${sim.warnings.length})` : ''}`],
  ];

  return (
    <Widget title="Simulation" subtitle={sim ? sim.experiment.title : 'waiting for data …'} className="sim">
      {debug && (
        <div className="sim-debug">
          {stopped ? (
            <button className="btn small primary" onClick={() => send({ type: 'continue' })} title="Continue the simulation">
              ▶ Continue
            </button>
          ) : (
            <button className="btn small" onClick={() => send({ type: 'pause' })} disabled={!sim} title="Pause the simulation">
              ⏸ Pause
            </button>
          )}
          <button
            className="btn small"
            onClick={() => send({ type: 'step', count: steps })}
            disabled={!sim}
            title="Execute the next instructions, then pause"
          >
            ⏭ Step
          </button>
          <select value={steps} onChange={(e) => setSteps(Number(e.target.value))} title="Instructions per step">
            {[1, 10, 100, 1000].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'instruction' : 'instructions'}
              </option>
            ))}
          </select>
          {stopped && sim.cpu && sim.cpu.halted && (
            <span className="sim-warn">
              {sim.cpu.state === 'Wake'
                ? 'Step running: the simulation waits for the next interrupt …'
                : 'CPU is sleeping (WFI): a step runs until the next interrupt'}
            </span>
          )}
        </div>
      )}
      {sim && (
        <>
          <Overview sim={sim} />
          <div className="sim-tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="sim-tab">
            {tab === 'regs' && <Registers sim={sim} />}
            {tab === 'cpustats' && <CpuStats sim={sim} onReset={() => send({ type: 'cpuStatsReset' })} />}
            {tab === 'memory' && <Memory sim={sim} request={memory} onRequest={setMemory} />}
            {tab === 'periph' && <Peripheral sim={sim} modules={modules} module={periph} onModule={setPeriph} />}
            {tab === 'messages' && <Messages sim={sim} />}
          </div>
        </>
      )}
    </Widget>
  );
}
