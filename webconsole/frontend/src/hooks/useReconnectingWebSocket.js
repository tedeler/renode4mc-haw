import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * WebSocket mit automatischem Reconnect (exponentielles Backoff + Jitter).
 * Wird Renode beim Versuchswechsel neu gestartet, schließt das Backend die Sockets
 * (Code 4000) – der Hook verbindet sich dann selbstständig neu.
 *
 * @returns {{ status: 'idle'|'connecting'|'open'|'reconnecting', send: (data) => boolean }}
 */
export function useReconnectingWebSocket(
  url,
  {
    enabled = true,
    binaryType = 'blob',
    minDelay = 300,
    maxDelay = 5000,
    onMessage,
    onOpen,
    onClose,
  } = {},
) {
  const [status, setStatus] = useState('idle');
  const wsRef = useRef(null);
  const handlers = useRef({});
  handlers.current = { onMessage, onOpen, onClose };

  useEffect(() => {
    if (!enabled || !url) {
      setStatus('idle');
      return undefined;
    }

    let disposed = false;
    let timer = null;
    let attempt = 0;

    const schedule = () => {
      if (disposed) return;
      const delay = Math.min(maxDelay, minDelay * 2 ** attempt) + Math.random() * 200;
      attempt += 1;
      setStatus('reconnecting');
      timer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        schedule();
        return;
      }
      ws.binaryType = binaryType;
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus('open');
        handlers.current.onOpen?.(ws);
      };
      ws.onmessage = (ev) => handlers.current.onMessage?.(ev);
      ws.onerror = () => ws.close();
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        handlers.current.onClose?.(ev);
        // Bewusster Neustart von Renode: schnell wieder verbinden
        if (ev.code === 4000) attempt = 0;
        schedule();
      };
    }

    // Sofort neu verbinden, wenn das Netzwerk/Tab zurückkommt
    const kick = () => {
      if (!wsRef.current && !disposed) {
        clearTimeout(timer);
        attempt = 0;
        connect();
      }
    };
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', kick);

    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', kick);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      setStatus('idle');
    };
  }, [url, enabled, binaryType, minDelay, maxDelay]);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const payload =
      typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
        ? data
        : JSON.stringify(data);
    ws.send(payload);
    return true;
  }, []);

  return { status, send };
}
