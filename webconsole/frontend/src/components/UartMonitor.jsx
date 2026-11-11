import { useEffect, useRef } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { UART_WS_URL } from '../config.js';
import { useReconnectingWebSocket } from '../hooks/useReconnectingWebSocket.js';
import Widget from './Widget.jsx';

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const PARITIES = [
  ['N', 'keine'],
  ['E', 'gerade'],
  ['O', 'ungerade'],
  ['M', 'Mark (1)'],
  ['S', 'Space (0)'],
];

/**
 * Einstellung des PC-Terminals (wie in Tera Term: Baudrate, Datenbits, Parität, Stoppbits).
 * Das Terminal dekodiert die Leitung mit DIESER Einstellung – passt sie nicht zur Firmware,
 * erscheinen falsche Zeichen wie an der echten Hardware.
 */
function TerminalSettings() {
  const { send, uartConfig, status, live } = useControlSocket();
  if (!uartConfig) return null;
  const { baud, format } = uartConfig;
  const set = (patch) => {
    const next = { baud, format, ...patch };
    send({ type: 'uartconfig', baud: Number(next.baud), format: next.format });
  };
  const setFmt = (i, ch) => set({ format: format.slice(0, i) + ch + format.slice(i + 1) });
  // Vorschau (keine Firmware): einstellbar, gilt beim Start
  const disabled = live && status !== 'open';
  return (
    <div className="uart-settings" title="Einstellung des Terminalprogramms am PC">
      <label>
        Baud
        <select value={baud} disabled={disabled} onChange={(e) => set({ baud: e.target.value })}>
          {!BAUD_RATES.includes(baud) && <option value={baud}>{baud}</option>}
          {BAUD_RATES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label>
        Daten
        <select value={format[0]} disabled={disabled} onChange={(e) => setFmt(0, e.target.value)}>
          {['5', '6', '7', '8'].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        Parität
        <select value={format[1]} disabled={disabled} onChange={(e) => setFmt(1, e.target.value)}>
          {PARITIES.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Stopp
        <select value={format[2]} disabled={disabled} onChange={(e) => setFmt(2, e.target.value)}>
          {['1', '2'].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <span className="uart-format">{`${baud} ${format}`}</span>
    </div>
  );
}

// Empfangenes CR ohne folgendes LF als Zeilenumbruch zeigen (Tera Term: "New-line Receive CR+LF")
function crToCrlf(bytes, state) {
  const out = [];
  for (const b of bytes) {
    if (state.cr && b !== 0x0a) out.push(0x0a);
    out.push(b);
    state.cr = b === 0x0d;
  }
  return new Uint8Array(out);
}

/**
 * UART-Monitor: xterm.js direkt am UART-WebSocket (Binärframes, bidirektional).
 * localEcho: getippte Zeichen selbst anzeigen (Tera Term "Local echo"), crlf: empfangenes CR als
 * neue Zeile anzeigen. Beides wie in der Terminal-Einstellung des Laborskripts (Lab 4).
 */
export default function UartMonitor({ label, localEcho = false, crlf = false }) {
  const { live } = useControlSocket();
  const optsRef = useRef({ localEcho, crlf });
  optsRef.current = { localEcho, crlf, live };
  const crState = useRef({ cr: false });
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const sendRef = useRef(() => false);

  const { status, send } = useReconnectingWebSocket(UART_WS_URL, {
    enabled: live,
    binaryType: 'arraybuffer',
    onOpen: () => termRef.current?.writeln('\x1b[32m[UART verbunden]\x1b[0m'),
    onMessage: (ev) => {
      const t = termRef.current;
      if (!t) return;
      let data = typeof ev.data === 'string' ? new TextEncoder().encode(ev.data) : new Uint8Array(ev.data);
      if (optsRef.current.crlf) data = crToCrlf(data, crState.current);
      t.write(data);
    },
    onClose: (ev) => {
      const t = termRef.current;
      if (!t) return;
      if (ev.code === 4000) {
        t.reset();
        t.writeln('\x1b[33m[Renode neu gestartet – verbinde neu …]\x1b[0m');
      } else {
        t.writeln('\x1b[31m[UART getrennt – Reconnect …]\x1b[0m');
      }
    },
  });
  sendRef.current = send;

  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: { background: '#0b1020', foreground: '#d6e2ff', cursor: '#7dd3fc' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    if (!optsRef.current.live) term.writeln('\x1b[90m[Keine Firmware geladen – das Terminal verbindet sich nach dem Start]\x1b[0m');

    const encoder = new TextEncoder();
    const sub = term.onData((d) => {
      const bytes = encoder.encode(d);
      sendRef.current(bytes);
      if (optsRef.current.localEcho) {
        term.write(optsRef.current.crlf ? crToCrlf(bytes, { cr: false }) : bytes);
        if (optsRef.current.crlf && bytes[bytes.length - 1] === 0x0d) term.write('\n');
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* Container unsichtbar */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      sub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  return (
    <Widget
      title="UART-Monitor"
      subtitle={label}
      status={status}
      className="uart"
      actions={
        <button className="btn small" onClick={() => termRef.current?.clear()}>
          Leeren
        </button>
      }
    >
      <div className="terminal" ref={containerRef} />
      <div className="row-actions">
        <TerminalSettings />
      </div>
    </Widget>
  );
}
