import { API_BASE } from './config.js';

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.log = body.log;
    throw err;
  }
  return body;
}

export const fetchExperiments = () => fetch(`${API_BASE}/api/experiments`).then(json);

/** Konfiguration eines Versuchs ohne Start: { experiment, terminal } */
export const fetchExperiment = (id) => fetch(`${API_BASE}/api/experiments/${encodeURIComponent(id)}`).then(json);

/** Terminal-Einstellung eines (noch nicht laufenden) Versuchs merken */
export const saveTerminal = (experimentId, baud, format) =>
  fetch(`${API_BASE}/api/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experiment_id: experimentId, baud, format }),
  }).then(json);

export const fetchStatus = () => fetch(`${API_BASE}/api/status`).then(json);

export const stopSimulation = () => fetch(`${API_BASE}/api/stop`, { method: 'POST' }).then(json);

/** POST /api/solution: Musterlösung des Versuchs starten */
export const startSolution = (experimentId) =>
  fetch(`${API_BASE}/api/solution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experiment_id: experimentId }),
  }).then(json);

/** POST /upload (multipart/form-data: experiment_id + file) */
export function uploadElf(experimentId, file) {
  const fd = new FormData();
  fd.append('experiment_id', experimentId);
  fd.append('file', file);
  return fetch(`${API_BASE}/upload`, { method: 'POST', body: fd }).then(json);
}
