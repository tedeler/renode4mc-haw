/**
 * Bildmarke Renode4MC-HAW: Chip mit UART-Rechtecksignal.
 * Farben über CSS (.app-logo-chip / .app-logo-wave), damit sie zum Thema passen.
 * Gleiche Geometrie wie public/favicon.svg.
 */
export default function AppLogo({ size = 24, title }) {
  return (
    <svg
      className="app-logo"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    >
      <path
        className="app-logo-chip"
        d="M22 4V12M22 52V60M4 22H12M52 22H60M32 4V12M32 52V60M4 32H12M52 32H60M42 4V12M42 52V60M4 42H12M52 42H60"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect className="app-logo-chip" x="12" y="12" width="40" height="40" rx="7" fill="none" strokeWidth="3" />
      <path
        className="app-logo-wave"
        d="M15 36H20V26H25V36H29V26H39V36H44V26H49"
        fill="none"
        strokeWidth="3.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
