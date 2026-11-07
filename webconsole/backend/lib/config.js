'use strict';

const path = require('path');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

// Standard: Repository-Layout  <repo>/webconsole/backend  ->  <repo>/sim
const repoSimDir = path.resolve(__dirname, '..', '..', '..', 'sim');

module.exports = Object.freeze({
  httpPort: int(process.env.PORT, 3000),
  uartWsPort: int(process.env.UART_WS_PORT, 3333),
  controlWsPort: int(process.env.CONTROL_WS_PORT, 3334),

  // Renode-interne Ports (nur im Container bzw. auf localhost, nicht exponiert)
  renodeHost: process.env.RENODE_HOST || '127.0.0.1',
  renodeMonitorPort: int(process.env.RENODE_MONITOR_PORT, 1234),
  renodeUartPort: int(process.env.RENODE_UART_PORT, 3335), // CreateServerSocketTerminal im .resc

  renodeBin: process.env.RENODE_BIN || 'renode',
  renodeHeadlessFlag: process.env.RENODE_HEADLESS_FLAG || '--disable-gui',
  renodeStartTimeoutMs: int(process.env.RENODE_START_TIMEOUT_MS, 60000),

  // Simulator-Verzeichnis aus dem Repository (models/, platforms/, tm4c1294.resc, experiments/).
  // Renode wird mit diesem Arbeitsverzeichnis gestartet, damit die relativen Pfade der .resc stimmen.
  simDir: process.env.SIM_DIR || repoSimDir,
  // TI-Headerdatei für die Registernamen der Simulations-Anzeige
  headerPath: process.env.HEADER_PATH || path.resolve(__dirname, '..', '..', '..', 'common', 'tm4c1294ncpdt.h'),
  experimentsSubdir: process.env.EXPERIMENTS_SUBDIR || 'experiments',

  elfPath: process.env.ELF_PATH || '/tmp/app.elf',
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 16 * 1024 * 1024),

  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 100),
});
