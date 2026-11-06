import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { UART_WS_URL } from '../config.js';
import { useReconnectingWebSocket } from '../hooks/useReconnectingWebSocket.js';
import Widget from './Widget.jsx';

/** UART-Monitor: xterm.js direkt am UART-WebSocket (Binärframes, bidirektional). */
export default function UartMonitor({ label }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const sendRef = useRef(() => false);

  const { status, send } = useReconnectingWebSocket(UART_WS_URL, {
    binaryType: 'arraybuffer',
    onOpen: () => termRef.current?.writeln('\x1b[32m[UART verbunden]\x1b[0m'),
    onMessage: (ev) => {
      const t = termRef.current;
      if (!t) return;
      t.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
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

    const encoder = new TextEncoder();
    const sub = term.onData((d) => sendRef.current(encoder.encode(d)));

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
    <Widget title="UART-Monitor" subtitle={label} status={status} className="uart">
      <div className="terminal" ref={containerRef} />
      <div className="row-actions">
        <button className="btn small" onClick={() => termRef.current?.clear()}>
          Leeren
        </button>
      </div>
    </Widget>
  );
}
