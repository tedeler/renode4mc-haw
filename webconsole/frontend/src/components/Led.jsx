/** LED (Ausgabe): CSS-Kreis, Farbe abhängig vom GPIO-Zustand. */
export default function Led({ label, color = '#22c55e', on }) {
  return (
    <div className="led">
      <div
        className={`led-bulb ${on ? 'on' : ''}`}
        style={{
          background: on ? color : '#2a2f3a',
          boxShadow: on ? `0 0 14px 4px ${color}88, inset 0 -3px 6px #0004` : 'inset 0 -3px 6px #0006',
        }}
        aria-label={`${label}: ${on ? 'an' : 'aus'}`}
        role="img"
      />
      <span className="led-label">{label}</span>
    </div>
  );
}
