import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';
import ScaleBox from '../layout/ScaleBox.jsx';

// Segmente a..g je Hex-Ziffer (Bit 0 = a ... Bit 6 = g), wie ein üblicher Hex-Decoder (A b C d E F)
const SEGMENTS = {
  0: 0x3f,
  1: 0x06,
  2: 0x5b,
  3: 0x4f,
  4: 0x66,
  5: 0x6d,
  6: 0x7d,
  7: 0x07,
  8: 0x7f,
  9: 0x6f,
  A: 0x77,
  B: 0x7c,
  C: 0x39,
  D: 0x5e,
  E: 0x79,
  F: 0x71,
};

// Lage der Segmente in einer 60 x 100 großen Ziffer: [x, y, Breite, Höhe]
const GEOMETRY = [
  [10, 4, 40, 8], // a
  [48, 10, 8, 38], // b
  [48, 52, 8, 38], // c
  [10, 88, 40, 8], // d
  [4, 52, 8, 38], // e
  [4, 10, 8, 38], // f
  [10, 46, 40, 8], // g
];

function Digit({ ch }) {
  const mask = ch === '-' ? 0 : (SEGMENTS[ch] ?? 0);
  return (
    <svg className="bcd-digit" viewBox="0 0 60 100" aria-label={ch === '-' ? 'dunkel' : ch}>
      {GEOMETRY.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={3} className={mask & (1 << i) ? 'seg on' : 'seg'} />
      ))}
    </svg>
  );
}

/**
 * 7-Segment-Anzeige mit BCD-Eingängen (Lab 1): zwei Module mit je zwei Ziffern.
 * Zustand kommt per Polling aus sim/models/BcdDisplay.cs ({type:"bcd", digits, enable, data}).
 */
export default function BcdDisplay({ label }) {
  const { bcd } = useControlSocket();
  const digits = bcd?.digits ?? '----';
  const en = bcd?.enable ?? '00';
  return (
    <Widget title="7-Segment-Anzeige (BCD)" subtitle={label} className="bcd">
      <ScaleBox maxScale={2.4} minH={90} flowMaxH={220}>
        <div className="bcd-row">
          {[0, 1].map((m) => (
            <div key={m} className="bcd-module">
              <div className={`bcd-en ${en[m] === '1' ? 'on' : ''}`}>EN {m === 0 ? 'links' : 'rechts'}</div>
              <div className="bcd-digits">
                <Digit ch={digits[2 * m]} />
                <Digit ch={digits[2 * m + 1]} />
              </div>
            </div>
          ))}
        </div>
      </ScaleBox>
      <div className="meta">
        Datenleitungen D7..D0 = 0x{bcd?.data ?? '00'} · Ziffern {digits}
      </div>
    </Widget>
  );
}
