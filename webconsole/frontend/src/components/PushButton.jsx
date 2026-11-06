import { useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';

/** Taster (Eingabe): MouseDown -> Press (High), MouseUp -> Release (Low). */
export default function PushButton({ id, label }) {
  const { send } = useControlSocket();
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);

  const set = (p) => {
    if (pressedRef.current === p) return;
    pressedRef.current = p;
    setPressed(p);
    send({ type: 'button', id, pressed: p });
  };

  return (
    <button
      type="button"
      className={`push-button ${pressed ? 'pressed' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        set(true);
      }}
      onMouseUp={() => set(false)}
      onMouseLeave={() => set(false)}
      onTouchStart={(e) => {
        e.preventDefault();
        set(true);
      }}
      onTouchEnd={() => set(false)}
      onTouchCancel={() => set(false)}
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && set(true)}
      onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && set(false)}
    >
      <span className="cap" />
      <span className="push-label">{label}</span>
    </button>
  );
}
