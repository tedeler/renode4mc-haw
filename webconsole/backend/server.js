'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const cfg = require('./lib/config');
const experiments = require('./lib/experiments');
const { RenodeManager, assertPortsFree } = require('./lib/renodeManager');
const { UartBridge } = require('./lib/uartBridge');
const { ControlBridge } = require('./lib/controlBridge');

// ---------------------------------------------------------------------------
// Laufzeit-Komponenten
// ---------------------------------------------------------------------------
const renode = new RenodeManager({
  bin: cfg.renodeBin,
  headlessFlag: cfg.renodeHeadlessFlag,
  monitorPort: cfg.renodeMonitorPort,
  cwd: cfg.simDir,
});

const uart = new UartBridge({
  wsPort: cfg.uartWsPort,
  renodeHost: cfg.renodeHost,
  renodePort: cfg.renodeUartPort,
});

const control = new ControlBridge({
  wsPort: cfg.controlWsPort,
  renodeHost: cfg.renodeHost,
  monitorPort: cfg.renodeMonitorPort,
  pollIntervalMs: cfg.pollIntervalMs,
});

let activeExperiment = null;

renode.on('exit', () => {
  activeExperiment = null;
  uart.detach('renode-exit');
  control.detach();
});

// Serialisiert Start-Vorgänge (gleichzeitige Uploads)
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function startExperiment(exp) {
  uart.detach('renode-restart');
  control.detach();
  activeExperiment = null;

  await renode.stop();
  renode.logTail = []; // kein Log des vorherigen Laufs in der Fehlermeldung
  const ports = [
    { port: cfg.renodeMonitorPort, name: 'Renode-Monitor' },
    { port: cfg.renodeUartPort, name: 'UART-Terminal' },
  ];
  if (exp.ledBridge) ports.push({ port: Number(new URL(exp.ledBridge).port), name: 'LED-Bridge' });
  await assertPortsFree(ports);

  await renode.start(exp.id, exp.rescPath, cfg.elfPath, control.terminalSettings(exp));
  const alive = () => renode.running;
  // Reihenfolge: UART-Socket existiert erst, wenn das .resc-Skript die Maschine angelegt hat
  await uart.attach(cfg.renodeStartTimeoutMs, alive);
  await control.attach(exp, cfg.renodeStartTimeoutMs, alive);
  activeExperiment = exp;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.dirname(cfg.elfPath),
    filename: (_req, _file, cb) => cb(null, `${path.basename(cfg.elfPath)}.${Date.now()}.upload`),
  }),
  limits: { fileSize: cfg.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    // CCS/tiarmclang erzeugt .out, GCC meist .elf – beides ist ELF
    if (!/\.(elf|out|axf)$/i.test(file.originalname)) return cb(new Error('Nur .out-/.elf-Dateien erlaubt'));
    cb(null, true);
  },
});

function isElf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    return magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    fs.closeSync(fd);
  }
}

app.get('/api/experiments', (_req, res) => {
  res.json(experiments.list(cfg.simDir, cfg.experimentsSubdir));
});

app.get('/api/status', (_req, res) => {
  res.json({
    running: renode.running && !!activeExperiment,
    experiment: activeExperiment ? experiments.publicView(activeExperiment) : null,
  });
});

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    const tmp = req.file && req.file.path;
    const cleanup = () => tmp && fs.rm(tmp, { force: true }, () => {});

    if (err) {
      cleanup();
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Keine Datei (Feld "file") empfangen' });

    const id = req.body && req.body.experiment_id;
    let exp;
    try {
      exp = experiments.load(cfg.simDir, cfg.experimentsSubdir, id);
    } catch (e) {
      cleanup();
      return res.status(500).json({ error: e.message });
    }
    if (!exp) {
      cleanup();
      return res.status(400).json({ error: `Unbekannter Versuch: ${id}` });
    }
    if (!isElf(tmp)) {
      cleanup();
      return res.status(400).json({ error: 'Datei ist kein gültiges ELF-Binary' });
    }

    try {
      await exclusive(async () => {
        // Browser zuerst sauber trennen (Code 4000 -> sofortiger Reconnect), dann Renode beenden
        uart.detach('renode-restart');
        control.detach();
        await renode.stop();
        fs.renameSync(tmp, cfg.elfPath);
        await startExperiment(exp);
      });
      console.log(`[server] Versuch "${exp.id}" läuft`);
      res.status(200).json({ status: 'running', experiment: experiments.publicView(exp) });
    } catch (e) {
      cleanup();
      console.error(`[server] Start fehlgeschlagen: ${e.message}`);
      const log = renode.logTail.slice(-30);
      await renode.stop().catch(() => {});
      res.status(500).json({ error: e.message, log });
    }
  });
});

app.post('/api/stop', async (_req, res) => {
  await exclusive(async () => {
    uart.detach('renode-stop');
    control.detach();
    activeExperiment = null;
    await renode.stop();
  });
  res.json({ status: 'stopped' });
});

// Statisches React-Frontend + SPA-Fallback
app.use(express.static(cfg.publicDir, { index: 'index.html', maxAge: '1h' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const index = path.join(cfg.publicDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('Frontend nicht gebaut (public/index.html fehlt)');
});

const server = app.listen(cfg.httpPort, () => {
  console.log(`[server] HTTP auf Port ${cfg.httpPort}`);
  console.log(`[server] Simulator: ${cfg.simDir} (Versuche in ${cfg.experimentsSubdir}/)`);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
async function shutdown(sig) {
  console.log(`[server] ${sig} – fahre herunter`);
  server.close();
  uart.close();
  control.close();
  await renode.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
