import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

/**
 * Ultraschall-Distanzsensor: Slider 0..400 cm.
 * onChange -> {type:"sensor", value} -> Backend -> Monitor "sysbus.i2c1.sensor Distance <Wert>"
 * (gedrosselt auf max. 20 Updates/s, letzter Wert wird immer gesendet).
 */
export default function DistanceSensor({ min = 0, max = 400, unit = 'cm', label, initial = 100, title }) {
  const { send, status } = useControlSocket();
  const [value, setValue] = useState(initial);
  const pending = useRef(null);
  const timer = useRef(null);

  const flush = () => {
    timer.current = null;
    if (pending.current !== null) {
      send({ type: 'sensor', value: pending.current });
      pending.current = null;
    }
  };

  const onChange = (e) => {
    const v = Number(e.target.value);
    setValue(v);
    pending.current = v;
    if (!timer.current) timer.current = setTimeout(flush, 50);
  };

  // Nach (Re-)Connect den aktuellen Wert erneut setzen
  useEffect(() => {
    if (status === 'open') send({ type: 'sensor', value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const pct = ((value - min) / (max - min)) * 100;

  return (
    <Widget title={title ?? 'Distanzsensor (Ultraschall)'} subtitle={label} className="sensor">
      <div className="sensor-readout">
        <span className="sensor-value">{value}</span>
        <span className="sensor-unit">{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={onChange}
        className="sensor-range"
        aria-label="Distanz"
      />
      <div className="sensor-scene">
        <div className="sensor-device">)))</div>
        <div className="sensor-object" style={{ left: `calc(${pct}% * 0.85 + 12%)` }} />
      </div>
    </Widget>
  );
}
