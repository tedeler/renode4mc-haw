/** Einheitlicher Rahmen für alle Control-Panel-Widgets. */
export default function Widget({ title, subtitle, className = '', children, status }) {
  return (
    <section className={`widget ${className}`}>
      <header className="widget-head">
        <h3>{title}</h3>
        {subtitle && <span className="widget-sub">{subtitle}</span>}
        {status && <span className={`ws-status ${status}`}>{status}</span>}
      </header>
      <div className="widget-body">{children}</div>
    </section>
  );
}
