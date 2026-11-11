/**
 * LED (Ausgabe): CSS-Kreis, Farbe abhängig vom GPIO-Zustand.
 * level (0..1, optional): Helligkeit bei PWM, wie vom Auge gemittelt (sim/models/WebSocketBridge.cs);
 * fehlt sie, gilt an/aus.
 */
const OFF = '#2a2f3a';

export default function Led({ label, color = '#22c55e', on, level }) {
  const dimmed = typeof level === 'number';
  const b = dimmed ? Math.max(0, Math.min(1, level)) : on ? 1 : 0;
  const pct = Math.round(b * 100);
  const lit = b > 0.02;
  const glowAlpha = Math.round(b * 0x88).toString(16).padStart(2, '0');
  const state = dimmed ? `gedimmt ${pct} %` : on ? 'an' : 'aus';
  return (
    <div className="led">
      <div
        className={`led-bulb ${lit ? 'on' : ''}`}
        style={{
          background: dimmed ? `color-mix(in srgb, ${color} ${pct}%, ${OFF})` : on ? color : OFF,
          boxShadow: lit
            ? `0 0 ${Math.round(4 + 10 * b)}px ${Math.round(4 * b)}px ${color}${glowAlpha}, inset 0 -3px 6px #0004`
            : 'inset 0 -3px 6px #0006',
        }}
        aria-label={`${label}: ${state}`}
        title={dimmed ? `PWM: mittlere Helligkeit ${pct} %` : undefined}
        role="img"
      />
      <span className="led-label">{label}</span>
    </div>
  );
}
