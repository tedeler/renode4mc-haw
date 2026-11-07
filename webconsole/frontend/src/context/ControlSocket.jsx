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

  const { status, send } = useReconnectingWebSocket(CONTROL_WS_URL, {
    onMessage,
    onClose: () => setRenodeState('unknown'),
  });

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

  const value = useMemo(
    () => ({
      status,
      renodeState,
      leds,
      send,
      subscribeFrame,
      subscribePendulum,
      subscribePendulumEvents,
      subscribeSignalStream,
      subscribeMessage,
      uartConfig,
      lastError,
      clearError: () => setLastError(null),
    }),
    [status, renodeState, leds, send, subscribeFrame, subscribePendulum, subscribePendulumEvents, subscribeSignalStream,
      subscribeMessage, uartConfig, lastError],
  );

  return <ControlSocketContext.Provider value={value}>{children}</ControlSocketContext.Provider>;
}

export function useControlSocket() {
  const ctx = useContext(ControlSocketContext);
  if (!ctx) throw new Error('useControlSocket außerhalb von <ControlSocketProvider>');
  return ctx;
}
