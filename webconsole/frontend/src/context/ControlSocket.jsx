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

/**
 * Stellt den Control-WebSocket (Renode-Monitor-Bridge) allen Widgets zur Verfügung.
 * LED-Zustände liegen im React-State; Framebuffer werden an Subscriber
 * durchgereicht (ohne Re-Render des gesamten Panels).
 */
export function ControlSocketProvider({ children }) {
  const [leds, setLeds] = useState({});
  const [renodeState, setRenodeState] = useState('unknown');
  const [lastError, setLastError] = useState(null);
  const frameListeners = useRef(new Set());
  const lastFrame = useRef(null);

  const emitFrame = (frame) => {
    lastFrame.current = frame;
    frameListeners.current.forEach((fn) => fn(frame));
  };

  const onMessage = useCallback((ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        setRenodeState(msg.renode);
        setLeds(msg.leds || {});
        if (msg.fb) emitFrame(decodeFrame(msg.fb));
        break;
      case 'leds':
        setLeds({ ...msg.states });
        break;
      case 'fb':
        emitFrame(decodeFrame(msg));
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

  const value = useMemo(
    () => ({ status, renodeState, leds, send, subscribeFrame, lastError, clearError: () => setLastError(null) }),
    [status, renodeState, leds, send, subscribeFrame, lastError],
  );

  return <ControlSocketContext.Provider value={value}>{children}</ControlSocketContext.Provider>;
}

export function useControlSocket() {
  const ctx = useContext(ControlSocketContext);
  if (!ctx) throw new Error('useControlSocket außerhalb von <ControlSocketProvider>');
  return ctx;
}
