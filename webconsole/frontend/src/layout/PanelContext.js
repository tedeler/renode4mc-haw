import { createContext, useContext } from 'react';

/**
 * Was ein Panel über seinen Platz im Arbeitsbereich wissen muss:
 * fit = Desktop-Ansicht (alles auf einer Seite, Panels teilen sich die Höhe),
 * sonst Mobil-Ansicht (eine Spalte, Seite scrollt).
 */
export const PanelContext = createContext({
  id: null,
  fit: false,
  collapsed: false,
  toggle: () => {},
  expand: () => {},
  startDrag: () => {},
  consumeClick: () => false,
  dragging: false,
});

export const usePanel = () => useContext(PanelContext);
