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

export const fetchStatus = () => fetch(`${API_BASE}/api/status`).then(json);

export const stopSimulation = () => fetch(`${API_BASE}/api/stop`, { method: 'POST' }).then(json);

/** POST /upload (multipart/form-data: experiment_id + file) */
export function uploadElf(experimentId, file) {
  const fd = new FormData();
  fd.append('experiment_id', experimentId);
  fd.append('file', file);
  return fetch(`${API_BASE}/upload`, { method: 'POST', body: fd }).then(json);
}
