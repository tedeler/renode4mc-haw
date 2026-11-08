import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const REPO_URL = 'https://github.com/tedeler/renode4mc-haw';

// Versionsangaben für den Über-Dialog, zur Build-Zeit eingesetzt.
// Git-Stand: aus dem Repository; im Docker-Build gibt es kein .git (siehe .dockerignore),
// dort kommt er aus der Build-Variable GIT_COMMIT (Dockerfile/docker-compose.yml).
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const commit = process.env.GIT_COMMIT || git('rev-parse HEAD');
const branch = process.env.GIT_BRANCH || git('rev-parse --abbrev-ref HEAD');
const commitDate = process.env.GIT_DATE || git('log -1 --format=%cI');
// Nicht eingecheckte Änderungen kennzeichnen (nur wenn git verfügbar ist)
const dirty = !process.env.GIT_COMMIT && commit && git('status --porcelain') !== '';

const BUILD_INFO = {
  version: pkg.version,
  commit,
  dirty,
  branch: branch === 'HEAD' ? '' : branch,
  commitDate,
  buildDate: new Date().toISOString(),
  repoUrl: REPO_URL,
};

// Dev: `npm run dev` proxied API-Aufrufe zum Backend auf :3000.
// WebSockets (3333/3334) werden direkt angesprochen.
export default defineConfig({
  plugins: [react()],
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/upload': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
});
