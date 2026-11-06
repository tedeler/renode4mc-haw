const host = window.location.hostname || 'localhost';
const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';

export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
export const UART_WS_URL = import.meta.env.VITE_UART_WS_URL ?? `${wsProto}://${host}:3333`;
export const CONTROL_WS_URL = import.meta.env.VITE_CONTROL_WS_URL ?? `${wsProto}://${host}:3334`;
