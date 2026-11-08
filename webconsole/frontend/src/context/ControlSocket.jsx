import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CONTROL_WS_URL } from '../config.js';
import { useReconnectingWebSocket } from '../hooks/useReconnectingWebSocket.js';

const ControlSocketContext = createContext(null);

function decodeFrame(msg) {
  const bin = atob(msg.data);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { width: msg.width, height: msg.height, on: msg.on, invert: msg.invert, data };
}

/** Pendeldisplay: { columns, periodUs, phase, leds, lr, rl } – lr/rl je ein Byte pro Spalte, Bit n = LED n */
function decodePendulum(msg) {
  const bin = atob(msg.data);
  const n = msg.columns;
  const lr = new Uint8Array(n);
  const rl = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    lr[i] = bin.charCodeAt(i);
    rl[i] = bin.charCodeAt(n + i);
  }
  return { columns: n, periodUs: msg.periodUs, phase: msg.phase, leds: msg.leds, lr, rl };
}

function base64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Diagnose-Liste: gleiche Meldung -> Zähler aktualisieren */
function mergeDiag(list, d) {
  const i = list.findIndex((x) => x.message === d.message);
  if (i < 0) return [...list, { level: d.level, message: d.message, count: d.count ?? 1 }].slice(-100);
  const next = [...list];
  next[i] = { ...next[i], count: d.count ?? next[i].count + 1 };
  return next;
}

/**
 * Stellt den Control-WebSocket (Renode-Monitor-Bridge) allen Widgets zur Verfügung.
 * LED-Zustände liegen im React-State; Framebuffer werden an Subscriber
 * durchgereicht (ohne Re-Render des gesamten Panels).
 */
export function ControlSocketProvider({ children }) {
  const [leds, setLeds] = useState({});
  const [renodeState, setRenodeState] = useState('unknown');
  const [lastError, setLastError] = useState(null);
  const [uartConfig, setUartConfig] = useState(null);
  const signalListeners = useRef(new Set());
  const messageListeners = useRef(new Set());
  const frameListeners = useRef(new Set());
  const lastFrame = useRef(null);
  const pendulumListeners = useRef(new Set());
  const pendulumEventListeners = useRef(new Set());
  const lastPendulum = useRef(null);
  const [bcd, setBcd] = useState(null);
  const [diagnostics, setDiagnostics] = useState([]);
  const cioListeners = useRef(new Set());
  const cioHistory = useRef(new Uint8Array(0));
  const scopeListeners = useRef(new Set());

  const emitCio = (bytes, reset) => {
    if (reset) cioHistory.current = new Uint8Array(0);
    const merged = new Uint8Array(cioHistory.current.length + bytes.length);
    merged.set(cioHistory.current);
    merged.set(bytes, cioHistory.current.length);
    cioHistory.current = merged.length > 65536 ? merged.slice(merged.length - 65536) : merged;
    cioListeners.current.forEach((fn) => fn(bytes, reset));
  };

  const emitFrame = (frame) => {
    lastFrame.current = frame;
    frameListeners.current.forEach((fn) => fn(frame));
  };

  const emitPendulum = (pd) => {
    lastPendulum.current = pd;
    pendulumListeners.current.forEach((fn) => fn(pd));
  };

  const onMessage = useCallback((ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    messageListeners.current.forEach((l) => l.types.includes(msg.type) && l.fn(msg));
    switch (msg.type) {
      case 'hello':
        setRenodeState(msg.renode);
        setLeds(msg.leds || {});
        if (msg.fb) emitFrame(decodeFrame(msg.fb));
        if (msg.pd) emitPendulum(decodePendulum(msg.pd));
        if (msg.uartConfig) setUartConfig(msg.uartConfig);
        setBcd(msg.bcd || null);
        setDiagnostics(msg.diagnostics || []);
        emitCio(base64ToBytes(msg.cio), true);
        break;
      case 'bcd':
        setBcd({ digits: msg.digits, enable: msg.enable, data: msg.data });
        break;
      case 'cio':
        emitCio(base64ToBytes(msg.data), false);
        break;
      case 'diag':
        setDiagnostics((list) => mergeDiag(list, msg));
        break;
      case 'diagReset':
        setDiagnostics([]);
        break;
      case 'uartconfig':
        setUartConfig({ baud: msg.baud, format: msg.format });
        break;
      case 'signals':
      case 'edges':
        // Signalstrom (Flanken der Leitungen, z. B. uart0.tx) für Oszilloskop/Logikanalysator
        signalListeners.current.forEach((fn) => fn(msg));
        break;
      case 'leds':
        setLeds({ ...msg.states });
        break;
      case 'fb':
        emitFrame(decodeFrame(msg));
        break;
      case 'pd':
        emitPendulum(decodePendulum(msg));
        break;
      case 'pdev':
        pendulumEventListeners.current.forEach((fn) => fn(msg));
        break;
      case 'scope':
        scopeListeners.current.forEach((fn) => fn(msg));
        break;
      case 'renode':
        setRenodeState(msg.state);
        if (msg.state === 'stopped') setLeds({});
        break;
      case 'error':
        setLastError(msg.message);
        break;
      default:
    }
  }, []);

  const { status, send: sendRaw } = useReconnectingWebSocket(CONTROL_WS_URL, {
    onMessage,
    onClose: () => setRenodeState('unknown'),
  });

  // Pause: das Pendel-Widget hält sofort an (nicht erst mit der nächsten Meldung der Simulation)
  const send = useCallback(
    (msg) => {
      if (msg && msg.type === 'pause') pendulumEventListeners.current.forEach((fn) => fn({ type: 'pausing' }));
      return sendRaw(msg);
    },
    [sendRaw],
  );

  const subscribeFrame = useCallback((fn) => {
    frameListeners.current.add(fn);
    if (lastFrame.current) fn(lastFrame.current);
    return () => frameListeners.current.delete(fn);
  }, []);

  /** Pendel-Ereignisse (LED-Wechsel mit virtueller Zeit und Phase), ohne Puffer */
  const subscribePendulumEvents = useCallback((fn) => {
    pendulumEventListeners.current.add(fn);
    return () => pendulumEventListeners.current.delete(fn);
  }, []);

  const subscribePendulum = useCallback((fn) => {
    pendulumListeners.current.add(fn);
    if (lastPendulum.current) fn(lastPendulum.current);
    return () => pendulumListeners.current.delete(fn);
  }, []);

  /** Nachrichten "signals" und "edges" (Abo vorher mit send({type:'subscribe', signals:[...]})) */
  const subscribeSignalStream = useCallback((fn) => {
    signalListeners.current.add(fn);
    return () => signalListeners.current.delete(fn);
  }, []);

  /** Beliebige Nachrichtentypen, z. B. subscribeMessage(['sim'], fn) */
  const subscribeMessage = useCallback((types, fn) => {
    const l = { types, fn };
    messageListeners.current.add(l);
    return () => messageListeners.current.delete(l);
  }, []);

  /** Oszilloskop-Daten (Pegelwechsel der angeforderten Pins), ohne Puffer */
  const subscribeScope = useCallback((fn) => {
    scopeListeners.current.add(fn);
    return () => scopeListeners.current.delete(fn);
  }, []);

  /** printf-Ausgabe (CCS-Konsole): fn(bytes, reset); beim Anmelden kommt die bisherige Ausgabe */
  const subscribeCio = useCallback((fn) => {
    cioListeners.current.add(fn);
    fn(cioHistory.current, true);
    return () => cioListeners.current.delete(fn);
  }, []);

  const value = useMemo(
    () => ({
      status,
      renodeState,
      leds,
      bcd,
      diagnostics,
      send,
      subscribeFrame,
      subscribePendulum,
      subscribePendulumEvents,
      subscribeSignalStream,
      subscribeMessage,
      uartConfig,
      subscribeCio,
      subscribeScope,
      lastError,
      clearError: () => setLastError(null),
    }),
    [status, renodeState, leds, bcd, diagnostics, send, subscribeFrame, subscribePendulum, subscribePendulumEvents,
      subscribeSignalStream, subscribeMessage, uartConfig, subscribeCio, subscribeScope, lastError],
  );

  return <ControlSocketContext.Provider value={value}>{children}</ControlSocketContext.Provider>;
}

export function useControlSocket() {
  const ctx = useContext(ControlSocketContext);
  if (!ctx) throw new Error('useControlSocket außerhalb von <ControlSocketProvider>');
  return ctx;
}
