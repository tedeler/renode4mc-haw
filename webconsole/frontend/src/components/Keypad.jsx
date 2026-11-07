import { useMemo, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

const DEFAULT_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];

/**
 * Matrix-Zuordnung: Taste -> { row: {index, pin}, col: {index, pin} }.
 * Beispiel (Versuch 1): "5" -> Zeile 1 (PK1), Spalte 1 (PK5).
 */
export function buildKeyMatrix(layout, rowPins = [], colPins = [], rowNames = [], colNames = []) {
  const map = new Map();
  layout.forEach((rowKeys, r) =>
    rowKeys.forEach((key, c) => {
      map.set(key, {
        row: { index: r, pin: rowPins[r] ?? `R${r}`, name: rowNames[r] },
        col: { index: c, pin: colPins[c] ?? `C${c}`, name: colNames[c] },
      });
    }),
  );
  return map;
}

/**
 * Keypad mit Multiplexing-Logik.
 * Ein Klick sendet NICHT "Taste 5", sondern die Matrix-Koordinate (Zeile, Spalte).
 * Im Simulator verbindet das Modell sim/models/KeypadMatrix.cs dann die Zeilenleitung
 * (GPIO-Ausgang der MCU) elektrisch mit der Spaltenleitung (GPIO-Eingang): Die Spalte wird
 * HIGH, sobald die Firmware die Zeile HIGH treibt -> Flanken-Interrupt bzw. Zeilen-Scan
 * funktionieren wie auf der echten Hardware.
 */
export default function Keypad({ layout = DEFAULT_LAYOUT, rowPins, colPins, rowNames, colNames, title, label }) {
  const { send } = useControlSocket();
  const matrix = useMemo(
    () => buildKeyMatrix(layout, rowPins, colPins, rowNames, colNames),
    [layout, rowPins, colPins, rowNames, colNames],
  );
  const [active, setActive] = useState(null);
  const activeRef = useRef(null);
  const cols = layout[0]?.length ?? 3;

  const drive = (key, pressed) => {
    const m = matrix.get(key);
    if (m) send({ type: 'keypad', row: m.row.index, col: m.col.index, pressed });
  };

  const release = () => {
    const key = activeRef.current;
    if (!key) return;
    activeRef.current = null;
    setActive(null);
    drive(key, false);
  };

  const press = (key) => {
    if (activeRef.current) release();
    activeRef.current = key;
    setActive(key);
    drive(key, true);
  };

  const subtitle =
    label ?? (rowPins && colPins ? `Zeilen ${rowPins.join('/')} · Spalten ${colPins.join('/')}` : undefined);
  const tag = (x) => (x.name ? `${x.name} ${x.pin}` : x.pin);

  return (
    <Widget title={title ?? `Keypad ${layout.length}×${cols}`} subtitle={subtitle} className="keypad">
      <div className="keypad-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {layout.flat().map((key) => {
          const m = matrix.get(key);
          return (
            <button
              key={key}
              type="button"
              className={`key ${active === key ? 'pressed' : ''}`}
              title={`Zeile ${m.row.index} (${tag(m.row)}) · Spalte ${m.col.index} (${tag(m.col)})`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                press(key);
              }}
              onPointerUp={release}
              onPointerCancel={release}
            >
              <span className="key-label">{key}</span>
              <span className="key-map">
                {m.row.name && m.col.name ? `${m.row.name}·${m.col.name}` : `${m.row.pin}·${m.col.pin}`}
              </span>
            </button>
          );
        })}
      </div>
    </Widget>
  );
}
