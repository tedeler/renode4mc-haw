import { usePanel } from '../layout/PanelContext.js';

const isControl = (el) => !!el.closest('button, select, input, a, textarea, label');

/**
 * Einheitlicher Rahmen für alle Control-Panel-Widgets.
 * Kopfzeile klicken = ein-/ausklappen, Kopfzeile ziehen (Maus) bzw. Griff ⠿ ziehen (Touch) =
 * verschieben. actions: kleine Knöpfe rechts in der Kopfzeile (z. B. "Leeren").
 * Der Inhalt bleibt eingeklappt erhalten (nur versteckt), damit Terminal und Anzeigen weiterlaufen.
 */
export default function Widget({ title, subtitle, className = '', children, status, actions, badge }) {
  const panel = usePanel();
  const { collapsed, fit } = panel;

  const onPointerDown = (e) => {
    if (isControl(e.target)) return;
    const grip = !!e.target.closest('.widget-grip');
    if (grip || e.pointerType === 'mouse') panel.startDrag(e);
  };
  const onClick = (e) => {
    if (isControl(e.target) || e.target.closest('.widget-grip')) return;
    if (panel.consumeClick()) return;
    panel.toggle();
  };

  return (
    <section
      className={`widget ${className} ${collapsed ? 'is-collapsed' : ''} ${fit ? 'is-fit' : 'is-flow'}`}
      aria-label={title}
    >
      <header className="widget-head" onPointerDown={onPointerDown} onClick={onClick}>
        <span className="widget-grip" title="Ziehen zum Verschieben" aria-hidden="true">
          ⠿
        </span>
        <h3>{title}</h3>
        {badge}
        {subtitle && (
          <span className="widget-sub" title={subtitle}>
            {subtitle}
          </span>
        )}
        {status && <span className={`ws-status ${status}`}>{status}</span>}
        {actions && !collapsed && <span className="widget-actions">{actions}</span>}
        <button
          type="button"
          className="widget-fold"
          aria-expanded={!collapsed}
          title={collapsed ? 'Ausklappen' : 'Einklappen'}
          onClick={(e) => {
            e.stopPropagation();
            panel.toggle();
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </header>
      <div className="widget-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
