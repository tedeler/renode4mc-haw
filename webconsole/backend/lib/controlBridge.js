'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { MonitorClient } = require('./monitorClient');
const experiments = require('./experiments');
const registers = require('./registers');

const FB_RE = /FB:(\d+)x(\d+):([01])([01]):([A-Za-z0-9+/=]+)/;
const LED_RE = /^LED(\d)=([01])$/;
const PD_RE = /PD:(\d+):(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+)/;
const EV_RE = /EV:(\d+):(\d+):(\d+):(\d+):([\d,;]*)/;
// Flanken einer Leitung (sim/models/UartLine.cs, SignalRecorder.Format):
// Zustand der Simulation (TivaSysCtl.GetStatus, GetCpuRegisters, ReadMemory, PeekRegisters)
const ST_RE = /ST:(\d+):(\d+):(\d+):(\d+):(\w+|-):([01]):(\d+):([0-9A-F]+):(\S*)/;
const CR_RE = /CR:(\S*)/;
const MEM_RE = /MEM:([0-9A-F]{8}):([0-9A-F]*)|MEM:ERR:(.*)/;
const PR_RE = /PR:(\S*)/;
const DIS_RE = /^0x([0-9a-fA-F]+):\s+([0-9a-fA-F]+)\s+(.*)$/;
const SYMBOL_RE = /^[A-Za-z_]\w{0,63}$/;
const LOG_RE = /\[(WARNING|ERROR)\]\s*(.*)$/;
// SE:<name>:<now ns>:<level>:<baud>:<format>:<lost>:<t0>,<l>;<dt>,<l>;...
const SE_RE = /SE:([a-z0-9_.]+):(\d+):([01]):([\d.]+):([^:\s]+):(\d+):([\d,;]*)/g;
const BCD_RE = /BCD:([0-9A-F-]{4}):([01]{2}):([0-9A-F]{2})/;
const CIO_RE = /CIO:([A-Za-z0-9+/=]*)/;
const SC_RE = /SC:(\d+):([A-Z0-9,]*):([0-9,]*):([\d,;]*):(\d+)/;
// Pins des TM4C1294NCPDT (128 Pins), Datenblatt Tabelle 26-5
const PORT_PINS = { A: 8, B: 6, C: 8, D: 8, E: 6, F: 5, G: 2, H: 4, J: 2, K: 8, L: 8, M: 8, N: 6, P: 6, Q: 5 };
const isPin = (p) => typeof p === 'string' && /^P[A-Q][0-7]$/.test(p) && PORT_PINS[p[1]] > +p[2];
const SCOPE_PATH = 'sysbus.scope';
const MAX_SCOPE_SOURCES = 5; // CH1..CH4 + externer Trigger
// Renode-Logzeile: "[12:00:00.0000] [WARNING] tm4c1294/gpioM: GPIO Port M: ..."
const DIAG_RE = /\[(WARNING|ERROR)\]\s*(.*)$/;
const CIO_HISTORY_BYTES = 16384;
const MAX_DIAGNOSTICS = 100;

/**
 * Control-WebSocket (Port 3334) – die "Monitor-Brücke" zwischen Browser und Renode.
 *
 *  Browser --JSON--> Backend --Monitor-Befehl--> Renode (Telnet-Monitor, Port 1234)
 *  Renode  --LED-Bridge (ws://127.0.0.1:9000, sim/models/WebSocketBridge.cs)--> Backend --JSON--> Browser
 *  Renode  --Polling (OLED-Framebuffer, Pendeldisplay, LEDs mit "path")--> Backend --JSON--> Browser
 *
 * Client -> Server
 *   { type: "button", id, pressed }            Taster (id aus der Versuchs-JSON)
 *   { type: "keypad", row, col, pressed }      Keypad: Zeile/Spalte der Matrix, nicht die Taste
 *   { type: "sensor", value }                  Distanz in cm
 *   { type: "pendulum", frequency }            Pendelfrequenz in Hz (Pendeldisplay)
 *   { type: "uartconfig", baud, format }       Einstellung des PC-Terminals (z. B. 9600, "7N1");
 *                                              gilt auch für spätere Neustarts von Renode
 *   { type: "subscribe", signals: [name, …] }  Flanken dieser Leitungen abonnieren (Oszilloskop)
 *   { type: "unsubscribe", signals: [name, …] }
 *   { type: "reset" }                          Reset-Taster: nur der Mikrocontroller startet neu
 *   { type: "watch", sim: true|false, memory?: { addr, count }, periph? }
 *                                              Simulations-Anzeige an/aus (Zustand alle 500 ms);
 *                                              memory.addr = Zahl oder Symbolname aus der ELF-Datei,
 *                                              periph = Modulname aus "simmeta" (z. B. "UART0")
 *   { type: "pause" } | { type: "continue" } | { type: "step", count }
 *                                              Ausführung anhalten, fortsetzen, count Befehle ausführen
 *   { type: "clearDiagnostics" }               Diagnose-Liste leeren
 *   { type: "scope", sources: ["PD0", …] }     Oszilloskop: Pins, die dieser Browser sehen will (max. 5,
 *                                              [] = Oszilloskop aus). Aufgezeichnet wird die Vereinigung
 *                                              aller Browser (sim/models/Oscilloscope.cs).
 * Server -> Client
 *   { type: "hello", experiment, renode, leds, fb, pd, uartConfig }
 *   { type: "leds", states: { [id]: boolean } }
 *   { type: "fb", width, height, on, invert, data }   data = Base64, SSD1306-Page-Format
 *   { type: "pd", columns, periodUs, phase, leds, data }
 *                                                     Pendeldisplay: phase = 1/10000 halbe Schwingung
 *                                                     (0..19999), leds = LED-Zustand jetzt,
 *                                                     data = Base64, erst alle Spalten
 *                                                     links->rechts, dann rechts->links (Bit n = LED n)
 *   { type: "pdev", now: [t, phi, leds, periodUs], ev: [[t, phi, leds, periodUs], …] }
 *                                                     Pendel-Ereignisse seit dem letzten Abruf (LED-Wechsel
 *                                                     mit virtueller Zeit t in us und Phase phi in 1/10000
 *                                                     halber Schwingung) für die Wiedergabe im Browser
 *   { type: "uartconfig", baud, format }      aktuelle Terminal-Einstellung (an alle)
 *   { type: "signals", signals: [{ name, label, idle, protocol? }] }
 *                                                     Leitungen des Versuchs; protocol = { kind: "uart",
 *                                                     baud, format } (Einstellung des Senders); nach dem
 *                                                     Verbinden, nach subscribe und bei Änderungen
 *   { type: "edges", name, now, level, edges: [[t, level], …], lost? }
 *                                                     Flanken einer abonnierten Leitung seit dem letzten
 *                                                     Abruf; t und now in ns virtueller Zeit, level = Pegel
 *                                                     bei now; bis now ist die Leitung vollständig bekannt
 *   { type: "sim", firmware, experiment, renode, time, cpu, resets, uart, warnings }
 *                                                     Zustand der Simulation (nur an Clients mit watch)
 *                                                     dazu je Client: regs (Kernregister), disasm (nur
 *                                                     angehalten), memory, periph
 *   { type: "simmeta", modules: [name, …] }           Module für die Peripherie-Register-Ansicht
 *   { type: "reset" }                                 Reset wurde ausgelöst
 *   { type: "bcd", digits, enable, data }      BCD-Anzeige: digits = 4 Zeichen (0-9, A-F, "-" = dunkel),
 *                                                     enable = "<EN links><EN rechts>", data = D7..D0 hex
 *   { type: "cio", data }                             printf-Ausgabe (CCS-Konsole), Base64; im hello: cio = alles bisher
 *   { type: "diag", level, message, count }           Warnung/Fehler aus Renode (Fehlkonfiguration usw.);
 *                                                     im hello: diagnostics = [{level, message, count}]
 *   { type: "scope", now, pins, levels, ev, dropped }
 *                                                     Oszilloskop (nur an Browser mit Quellen): now = virtuelle
 *                                                     Zeit in ns, pins/levels = aufgezeichnete Pins und ihr Pegel
 *                                                     jetzt (0 LOW, 1 HIGH, 2 offen), ev = flach [i, dt ns, Pegel, …]
 *                                                     (i = Index in pins, dt seit dem vorigen Wechsel bzw. seit
 *                                                     Start), dropped = verlorene Wechsel (Puffer voll)
 *   { type: "renode", state: "running" | "stopped" }
 *   { type: "error", message }
 */
class ControlBridge {
  constructor({ wsPort, renodeHost, monitorPort, pollIntervalMs, headerPath }) {
    this.registers = registers.load(headerPath);
    this.renodeHost = renodeHost;
    this.monitorPort = monitorPort;
    this.pollIntervalMs = pollIntervalMs;
    this.monitor = null;
    this.experiment = null; // vollständige Konfiguration (mit Renode-Pfaden)
    this.ledStates = {};
    this.lastFrame = null;
    this.lastPendulum = null;
    this.lastBcd = null;
    this.cioHistory = Buffer.alloc(0);
    this.diagnostics = [];
    this.pollTimer = null;
    this.polling = false;
    this.ledSocket = null;
    this.ledRetry = null;
    this.uartSettings = null; // vom Browser gewählte Terminal-Einstellung (null = Standard des Versuchs)
    this.signalInfo = {}; // name -> { baud, format } laut Modell
    this.freshPaths = new Set(); // Pfade, deren alter Flankenpuffer beim nächsten Abruf verworfen wird
    this.firmware = null; // { name, size, sha256, loadedAt } – setzt server.js beim Upload
    this.renodeVersion = null;
    this.warnings = []; // [{ level, text, count, last }] aus dem Renode-Log
    this.startedAt = null;
    this.lastSim = null;
    this.pollCount = 0;
    this.stopped = false; // angehalten (Pause oder Einzelschritt)
    this.symbols = new Map();
    this.scopeProbes = ''; // in Renode eingestellte Pins (Komma-Liste)

    this.wss = new WebSocketServer({ port: wsPort });
    this.wss.on('connection', (ws) => this._onClient(ws));
    console.log(`[control] WebSocket auf Port ${wsPort}`);
  }

  get attached() {
    return !!(this.monitor && this.monitor.connected);
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  /** Terminal-Einstellung für den Versuch: Wahl des Browsers oder Standard aus der JSON-Datei */
  terminalSettings(exp = this.experiment) {
    if (!exp || !exp.uart || !exp.uart.host) return null;
    return this.uartSettings || { baud: exp.uart.baud, format: exp.uart.format };
  }

  _signalsMessage() {
    const sigs = (this.experiment && this.experiment.signals) || [];
    return {
      type: 'signals',
      signals: sigs.map((sig) => {
        const info = this.signalInfo[sig.name];
        const d = { name: sig.name, label: sig.label || sig.name, idle: 1 };
        if (info && info.baud > 0) d.protocol = { kind: 'uart', baud: info.baud, format: info.format };
        return d;
      }),
    };
  }

  /** Vor jedem Start von Renode: Meldungen des vorigen Laufs vergessen */
  resetLog() {
    this.warnings = [];
    this.renodeVersion = null;
  }

  /** Zeile aus dem Renode-Log (renodeManager 'log'): Version und Warnungen merken */
  onRenodeLog(line) {
    const v = /Renode, version (\S+)/.exec(line);
    if (v) this.renodeVersion = v[1];
    const m = LOG_RE.exec(line);
    if (!m) return;
    // Meldungstext ohne Zeitstempel; gleiche Meldungen zählen statt wiederholen
    const text = m[2].replace(/\s+/g, ' ').slice(0, 400);
    const old = this.warnings.find((w) => w.text === text);
    if (old) {
      old.count++;
      old.last = Date.now();
    } else {
      this.warnings.push({ level: m[1] === 'ERROR' ? 'error' : 'warning', text, count: 1, last: Date.now() });
      if (this.warnings.length > 30) this.warnings.shift();
    }
  }

  _watchers() {
    return [...this.wss.clients].filter((ws) => ws.readyState === WebSocket.OPEN && ws.watchSim);
  }

  _subscribedPaths() {
    const names = new Set();
    for (const ws of this.wss.clients) for (const n of ws.signals || []) names.add(n);
    const sigs = (this.experiment && this.experiment.signals) || [];
    return [...new Set(sigs.filter((sig) => names.has(sig.name)).map((sig) => sig.path))];
  }

  _hello() {
    return {
      type: 'hello',
      experiment: experiments.publicView(this.experiment),
      renode: this.attached ? 'running' : 'stopped',
      leds: this.ledStates,
      fb: this.lastFrame,
      pd: this.lastPendulum,
      uartConfig: this.terminalSettings(),
      bcd: this.lastBcd,
      cio: this.cioHistory.toString('base64'),
      diagnostics: this.diagnostics,
    };
  }

  /** Neue Renode-Instanz: Diagnose und printf-Ausgabe des vorigen Laufs verwerfen. */
  resetDiagnostics() {
    this.diagnostics = [];
    this.cioHistory = Buffer.alloc(0);
    this._broadcast({ type: 'diagReset' });
  }

  /** Renode-Logzeile; Warnungen und Fehler gehen an alle Browser (gleiche Meldung: Zähler). */
  diagnostic(line) {
    const m = DIAG_RE.exec(line);
    if (!m) return;
    const level = m[1] === 'ERROR' ? 'error' : 'warning';
    const message = m[2].trim();
    if (!message) return;
    let d = this.diagnostics.find((x) => x.message === message);
    if (d) d.count += 1;
    else {
      d = { level, message, count: 1 };
      this.diagnostics.push(d);
      if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
    }
    this._broadcast({ type: 'diag', ...d });
  }

  _onClient(ws) {
    ws.signals = new Set();
    ws.scopeSources = [];
    ws.on('close', () => this._updateScopeProbes().catch(() => {}));
    this._send(ws, this._hello());
    if (this.experiment) this._send(ws, this._signalsMessage());
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: 'error', message: 'Ungültiges JSON' });
      }
      try {
        if (msg && msg.type === 'scope') return await this._scopeSources(ws, msg.sources);
        await this._handle(msg, ws);
      } catch (e) {
        this._send(ws, { type: 'error', message: e.message });
      }
    });
  }

  /** Übersetzt ein UI-Kommando in Renode-Monitor-Befehle (Pfade nur aus der Versuchs-Konfiguration). */
  async _handle(msg, ws) {
    switch (msg.type) {
      case 'subscribe':
      case 'unsubscribe': {
        const names = Array.isArray(msg.signals) ? msg.signals.filter((n) => typeof n === 'string') : [];
        const before = new Set(this._subscribedPaths());
        for (const n of names) {
          if (msg.type === 'subscribe') ws.signals.add(n);
          else ws.signals.delete(n);
        }
        // Neu abgefragte Pfade: Flanken aus der Zeit ohne Abonnenten verwerfen
        for (const p of this._subscribedPaths()) if (!before.has(p)) this.freshPaths.add(p);
        if (msg.type === 'subscribe' && this.experiment) this._send(ws, this._signalsMessage());
        return;
      }
      case 'watch': {
        const was = ws.watchSim;
        ws.watchSim = !!msg.sim;
        ws.simMemory = null;
        if (msg.memory && (typeof msg.memory.addr === 'number' || typeof msg.memory.addr === 'string')) {
          const count = Math.max(16, Math.min(1024, Math.round(Number(msg.memory.count) || 128)));
          ws.simMemory = { addr: msg.memory.addr, count };
        }
        ws.simPeriph = typeof msg.periph === 'string' && this.registers.byModule[msg.periph] ? msg.periph : null;
        if (ws.watchSim && !was) this._send(ws, { type: 'simmeta', modules: this.registers.modules });
        if (ws.watchSim && this.attached && this.experiment) this._pollSimSoon();
        return;
      }
      case 'uartconfig': {
        const baud = Number(msg.baud);
        const format = String(msg.format || '').toUpperCase();
        if (!experiments.isValidUartSettings(baud, format)) throw new Error('Ungültige Terminal-Einstellung');
        this.uartSettings = { baud, format };
        const exp = this.experiment;
        if (this.attached && exp && exp.uart && exp.uart.host) {
          await this.monitor.execute(`${exp.uart.host} TerminalBaudRate ${baud}`, { priority: true });
          await this.monitor.execute(`${exp.uart.host} Format "${format}"`, { priority: true });
        }
        this._broadcast({ type: 'uartconfig', baud, format });
        return;
      }
      case 'clearDiagnostics':
        this.diagnostics = [];
        this._broadcast({ type: 'diagReset' });
        return;
      default:
    }
    if (!this.attached || !this.experiment) throw new Error('Renode läuft nicht');
    const exp = this.experiment;
    const run = (cmd) => this.monitor.execute(cmd, { priority: true });

    switch (msg.type) {
      case 'button': {
        const btn = (exp.buttons || []).find((b) => b.id === msg.id);
        if (!btn) throw new Error(`Unbekannter Taster: ${msg.id}`);
        const pressed = !!msg.pressed;
        if (btn.path) {
          // Renode-Peripherie Miscellaneous.Button
          await run(`${btn.path} ${pressed ? 'Press' : 'Release'}`);
        } else if (pressed) {
          // Gedrückt: Taster verbindet den Pin mit GND (activeLow) bzw. VCC
          await run(`${btn.port} OnGPIO ${btn.pin} ${!btn.activeLow}`);
        } else {
          // Losgelassen: Pin ist offen – nur der Pull-up/-down der Firmware bestimmt den Pegel
          await run(`${btn.port} ReleaseInput ${btn.pin}`);
        }
        break;
      }
      case 'keypad': {
        const kp = exp.keypad;
        if (!kp) throw new Error('Kein Keypad in diesem Versuch');
        const rows = kp.layout.length;
        const cols = kp.layout[0].length;
        const { row, col } = msg;
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rows || col >= cols) {
          throw new Error('Ungültige Keypad-Position');
        }
        // sim/models/KeypadMatrix.cs verbindet Zeile und Spalte elektrisch
        await run(`${kp.path} SetKey ${row} ${col} ${!!msg.pressed}`);
        break;
      }
      case 'sensor': {
        if (!exp.sensor) throw new Error('Kein Sensor in diesem Versuch');
        const min = exp.sensor.min ?? 0;
        const max = exp.sensor.max ?? 400;
        const v = Math.round(Number(msg.value));
        if (!Number.isFinite(v)) throw new Error('Ungültiger Sensorwert');
        // Renode-Monitor-Syntax für "sensor.Distance = <Wert>"
        await run(`${exp.sensor.path} Distance ${Math.min(max, Math.max(min, v))}`);
        break;
      }
      case 'reset': {
        if (!exp.reset) throw new Error('Kein Reset in diesem Versuch');
        await run(`${exp.reset.path} ResetMcu`);
        // Der Reset geschieht beim nächsten Zeitschritt: angehaltene Simulation dafür fortsetzen
        if (this.stopped) await this._continue(run);
        this._broadcast({ type: 'reset' });
        this._pollSimSoon();
        break;
      }
      case 'pause': {
        if (!exp.debug) throw new Error('Kein Debugger in diesem Versuch');
        await run('pause');
        this.stopped = true;
        this._pollSimSoon();
        break;
      }
      case 'continue': {
        if (!exp.debug) throw new Error('Kein Debugger in diesem Versuch');
        await this._continue(run);
        this._pollSimSoon();
        break;
      }
      case 'step': {
        if (!exp.debug) throw new Error('Kein Debugger in diesem Versuch');
        const n = Math.max(1, Math.min(10000, Math.round(Number(msg.count) || 1)));
        this.stopped = true;
        await run(`${exp.debug.cpu} Step ${n}`);
        this._pollSimSoon();
        break;
      }
      case 'pendulum': {
        const pd = exp.pendulum;
        if (!pd) throw new Error('Kein Pendeldisplay in diesem Versuch');
        const f = Number(msg.frequency);
        if (!Number.isFinite(f)) throw new Error('Ungültige Pendelfrequenz');
        const hz = Math.min(pd.maxFrequency, Math.max(pd.minFrequency, f));
        // Modell erwartet die Periode in us (gerade Zahl); gilt ab dem nächsten Nulldurchgang
        const periodUs = 2 * Math.round(1e6 / hz / 2);
        await run(`${pd.path} PeriodUs ${periodUs}`);
        break;
      }
      default:
        throw new Error(`Unbekannter Typ: ${msg.type}`);
    }
  }

  async _continue(run) {
    await run(`${this.experiment.debug ? this.experiment.debug.cpu : 'sysbus.cpu'} ExecutionMode Continuous`);
    await run('start');
    this.stopped = false;
  }

  /** Simulations-Anzeige sofort aktualisieren (nach Pause, Schritt, Reset, neuem watch) */
  _pollSimSoon() {
    clearTimeout(this.simSoon);
    this.simSoon = setTimeout(async () => {
      if (!this.attached || !this.experiment || !this._watchers().length) return;
      try {
        await this._pollSim(this.monitor);
      } catch (e) {
        if (this.attached) console.error(`[control] Sim-Fehler: ${e.message}`);
      }
    }, 30);
  }

  /** Oszilloskop: Quellen eines Browsers setzen (gilt auch, wenn Renode gerade nicht läuft) */
  async _scopeSources(ws, sources) {
    if (!Array.isArray(sources)) throw new Error('Oszilloskop: sources muss eine Liste sein');
    const pins = [...new Set(sources.filter(Boolean))];
    if (pins.length > MAX_SCOPE_SOURCES) throw new Error(`Oszilloskop: höchstens ${MAX_SCOPE_SOURCES} Quellen`);
    const bad = pins.find((p) => !isPin(p));
    if (bad) throw new Error(`Oszilloskop: unbekannter Pin ${bad}`);
    ws.scopeSources = pins;
    await this._updateScopeProbes();
  }

  /** Vereinigung der Quellen aller Browser in Renode einstellen (Format: sim/models/Oscilloscope.cs) */
  async _updateScopeProbes(force = false) {
    const all = new Set();
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) (c.scopeSources || []).forEach((p) => all.add(p));
    const list = [...all].sort().join(',');
    if (!this.attached || (!force && list === this.scopeProbes)) return;
    this.scopeProbes = list;
    await this.monitor.execute(`${SCOPE_PATH} Probe "${list}"`, { priority: true });
  }

  /** Verbindet mit der neu gestarteten Renode-Instanz und startet Polling/LED-Bridge. */
  async attach(experiment, timeoutMs, isAlive) {
    this.detach();
    this.experiment = experiment;
    this.ledStates = Object.fromEntries((experiment.leds || []).map((l) => [l.id, false]));
    this.lastFrame = null;
    this.lastPendulum = null;
    this.signalInfo = {};
    this.freshPaths.clear();
    this.startedAt = Date.now();
    this.lastSim = null;
    this.simPrev = null;
    this.stopped = false;
    this.symbols = new Map();
    this.lastBcd = null;

    const mon = new MonitorClient({ host: this.renodeHost, port: this.monitorPort });
    mon.on('error', (e) => console.error(`[control] Monitor-Fehler: ${e.message}`));
    mon.on('close', () => {
      console.log('[control] Monitor-Verbindung geschlossen');
      this._stopPolling();
      this._broadcast({ type: 'renode', state: 'stopped' });
    });
    await mon.connect(timeoutMs, isAlive);
    this.monitor = mon;

    // Monitor-Kontext auf die Maschine setzen (Prompt "(tm4c1294)")
    if (experiment.machine) {
      await mon.execute(`mach set "${experiment.machine}"`).catch(() => {});
    }
    // Renode-Version für die Simulations-Anzeige
    const ver = await mon.execute('version').catch(() => '');
    const v = /(\d+\.\d+\.\d+\S*)/.exec(ver);
    if (v) this.renodeVersion = v[1];
    this._connectLedBridge();
    this._broadcast(this._hello());
    this._broadcast(this._signalsMessage());
    await this._updateScopeProbes(true).catch((e) => console.error(`[control] Oszilloskop: ${e.message}`));
    this._startPolling();
  }

  detach() {
    this._stopPolling();
    this.scopeProbes = '';
    this._disconnectLedBridge();
    if (this.monitor) {
      this.monitor.removeAllListeners();
      this.monitor.on('error', () => {});
      this.monitor.close();
    }
    this.monitor = null;
    if (this.experiment) this._broadcast({ type: 'renode', state: 'stopped' });
    this.experiment = null;
  }

  // ---- LEDs über die WebSocketBridge aus sim/models (Push statt Polling) ----------------
  _connectLedBridge() {
    const exp = this.experiment;
    if (!exp || !exp.ledBridge) return;
    const byIndex = new Map((exp.leds || []).filter((l) => l.bridge !== undefined).map((l) => [l.bridge, l.id]));
    if (!byIndex.size) return;

    const ws = new WebSocket(exp.ledBridge);
    this.ledSocket = ws;
    ws.on('open', () => console.log(`[control] LED-Bridge verbunden (${exp.ledBridge})`));
    ws.on('message', (data) => {
      const m = LED_RE.exec(data.toString());
      if (!m) return;
      const id = byIndex.get(+m[1]);
      if (id === undefined) return;
      const on = m[2] === '1';
      if (this.ledStates[id] !== on) {
        this.ledStates[id] = on;
        this._broadcast({ type: 'leds', states: this.ledStates });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ledSocket !== ws || !this.attached) return;
      this.ledRetry = setTimeout(() => this._connectLedBridge(), 500);
    });
  }

  _disconnectLedBridge() {
    clearTimeout(this.ledRetry);
    this.ledRetry = null;
    const ws = this.ledSocket;
    this.ledSocket = null;
    if (ws) ws.terminate();
  }

  // ---- Polling: OLED-Framebuffer und LEDs mit Renode-Pfad -------------------------------
  _startPolling() {
    this._stopPolling();
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  _stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async _poll() {
    // Nicht aufstauen: nur pollen, wenn die letzte Runde fertig ist und keine UI-Befehle warten
    if (this.polling || !this.attached || this.monitor.busy) return;
    this.polling = true;
    const mon = this.monitor;
    const exp = this.experiment;
    try {
      let changed = false;
      for (const led of (exp.leds || []).filter((l) => l.path)) {
        const out = await mon.execute(`${led.path} State`);
        const m = /\b(True|False)\b/i.exec(out);
        if (!m) continue;
        const on = m[1].toLowerCase() === 'true';
        if (this.ledStates[led.id] !== on) {
          this.ledStates[led.id] = on;
          changed = true;
        }
      }
      if (changed) this._broadcast({ type: 'leds', states: this.ledStates });

      if (exp.oled) {
        const out = await mon.execute(`${exp.oled.path} GetFrameIfChanged`);
        const m = FB_RE.exec(out);
        if (m) {
          this.lastFrame = {
            type: 'fb',
            width: +m[1],
            height: +m[2],
            on: m[3] === '1',
            invert: m[4] === '1',
            data: m[5],
          };
          this._broadcast(this.lastFrame);
        }
      }

      if (exp.bcd) {
        const m = BCD_RE.exec(await mon.execute(`${exp.bcd.path} GetState`));
        if (m && (!this.lastBcd || this.lastBcd.digits !== m[1] || this.lastBcd.enable !== m[2] || this.lastBcd.data !== m[3])) {
          this.lastBcd = { type: 'bcd', digits: m[1], enable: m[2], data: m[3] };
          this._broadcast(this.lastBcd);
        }
      }

      if (exp.cio) {
        const m = CIO_RE.exec(await mon.execute(`${exp.cio.path} GetOutput`));
        if (m && m[1]) {
          const bytes = Buffer.from(m[1], 'base64');
          this.cioHistory = Buffer.concat([this.cioHistory, bytes]);
          if (this.cioHistory.length > CIO_HISTORY_BYTES) {
            this.cioHistory = this.cioHistory.subarray(this.cioHistory.length - CIO_HISTORY_BYTES);
          }
          this._broadcast({ type: 'cio', data: m[1] });
        }
      }

      if (exp.pendulum) {
        // Immer abfragen: Phase und LED-Zustand ändern sich laufend (Animation des Pendelstabs)
        const out = await mon.execute(`${exp.pendulum.path} GetFrame`);
        const m = PD_RE.exec(out);
        if (m) {
          this.lastPendulum = { type: 'pd', columns: +m[1], periodUs: +m[2], phase: +m[3], leds: +m[4], data: m[5] };
          this._broadcast(this.lastPendulum);
        }
        const evOut = await mon.execute(`${exp.pendulum.path} GetEvents`);
        const e = EV_RE.exec(evOut);
        if (e) {
          const ev = e[5]
            .split(';')
            .filter(Boolean)
            .map((x) => x.split(',').map(Number));
          this._broadcast({ type: 'pdev', now: [+e[1], +e[2], +e[3], +e[4]], ev });
        }
      }

      if (this.scopeProbes) {
        const m = SC_RE.exec(await mon.execute(`${SCOPE_PATH} GetEvents`));
        if (m) {
          const ev = m[4] ? m[4].split(/[;,]/).filter(Boolean).map(Number) : [];
          const msg = JSON.stringify({
            type: 'scope',
            now: +m[1],
            pins: m[2] ? m[2].split(',') : [],
            levels: m[3] ? m[3].split(',').map(Number) : [],
            ev,
            dropped: +m[5],
          });
          for (const ws of this.wss.clients) {
            if (ws.readyState === WebSocket.OPEN && ws.scopeSources && ws.scopeSources.length) ws.send(msg);
          }
        }
      }
      await this._pollSignals(mon);
      if (this.pollCount++ % 5 === 0 && this._watchers().length) await this._pollSim(mon);
    } catch (e) {
      if (this.attached) console.error(`[control] Poll-Fehler: ${e.message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Zustand der Simulation für die Anzeige (Firmware, CPU, Zeit, UART, Meldungen) */
  async _pollSim(mon) {
    const exp = this.experiment;
    const sim = {
      type: 'sim',
      experiment: { id: exp.id, title: exp.title },
      firmware: this.firmware,
      renode: { version: this.renodeVersion, startedAt: this.startedAt },
      warnings: this.warnings,
    };
    if (exp.status) {
      const m = ST_RE.exec(await mon.execute(`${exp.status.path} GetStatus`));
      if (m) {
        const now = Date.now();
        const virtualNs = Number(m[1]);
        let speed = null;
        if (this.simPrev && now > this.simPrev.wall) {
          speed = (virtualNs - this.simPrev.virtualNs) / 1e6 / (now - this.simPrev.wall);
        }
        this.simPrev = { wall: now, virtualNs };
        sim.time = { virtualNs, wallMs: now - this.startedAt, speed };
        sim.cpu = { state: m[5], halted: m[6] === '1', pc: `0x${m[8]}`, symbol: m[9] || null, sysclk: Number(m[4]) };
        sim.resets = { count: Number(m[2]), lastNs: Number(m[3]) };
        this.stopped = m[5] === 'Paused' || m[5] === 'Step';
        sim.stopped = this.stopped;
      }
      const cr = CR_RE.exec(await mon.execute(`${exp.status.path} GetCpuRegisters`));
      if (cr) {
        sim.regs = cr[1].split(';').filter(Boolean).map((x) => {
          const [name, hex] = x.split('=');
          return { name, value: parseInt(hex, 16) };
        });
      }
      if (this.stopped && exp.debug && sim.cpu) {
        // Die nächsten Befehle ab PC (Thumb-2: 2 oder 4 Bytes)
        const out = await mon.execute(`${exp.debug.cpu} DisassembleBlock ${sim.cpu.pc} 24`);
        sim.disasm = out
          .split(/\r?\n/)
          .map((l) => DIS_RE.exec(l.trim()))
          .filter(Boolean)
          .slice(0, 8)
          .map((d) => ({ addr: parseInt(d[1], 16), bytes: d[2], text: d[3].replace(/\s+/g, ' ').trim() }));
      }
    }
    if (exp.uart && exp.uart.host) {
      const uartPath = exp.uart.host.replace(/\.[^.]+$/, '');
      const baud = /([\d.]+)/.exec(await mon.execute(`${uartPath} LineBaudRate`));
      const fmt = /"?([5-8][NOEMS][12])"?/.exec(await mon.execute(`${uartPath} FrameFormat`));
      sim.uart = { mcu: { baud: baud ? Number(baud[1]) : null, format: fmt ? fmt[1] : null }, terminal: this.terminalSettings() };
    }
    this.lastSim = sim;
    for (const ws of this._watchers()) {
      const own = { ...sim };
      if (exp.status && ws.simMemory) own.memory = await this._readMemory(mon, ws.simMemory);
      if (exp.status && ws.simPeriph) own.periph = await this._peekModule(mon, ws.simPeriph);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(own));
    }
  }

  /** Speicher ab Adresse oder Symbol (Flash/SRAM) */
  async _readMemory(mon, { addr, count }) {
    const exp = this.experiment;
    let a = addr;
    let symbol = null;
    if (typeof addr === 'string') {
      const s = addr.trim();
      if (/^(0x)?[0-9a-fA-F]{1,8}$/.test(s) && /^0x|^\d/.test(s)) {
        a = parseInt(s, 16);
      } else if (SYMBOL_RE.test(s)) {
        symbol = s;
        if (!this.symbols.has(s)) {
          const out = await mon.execute(`sysbus GetSymbolAddress "${s}"`);
          const m = /0x([0-9a-fA-F]+)/.exec(out);
          this.symbols.set(s, m ? parseInt(m[1], 16) : null);
        }
        a = this.symbols.get(s);
        if (a === null) return { request: s, error: `Symbol "${s}" nicht in der ELF-Datei` };
      } else {
        return { request: s, error: 'Adresse (hex, z. B. 0x20000000) oder Symbolname angeben' };
      }
    }
    if (!Number.isFinite(a)) return { request: String(addr), error: 'Ungültige Adresse' };
    const out = await mon.execute(`${exp.status.path} ReadMemory 0x${a.toString(16)} ${count}`);
    const m = MEM_RE.exec(out);
    if (!m) return { request: String(addr), error: 'Keine Antwort' };
    if (m[3]) return { request: String(addr), error: m[3].trim() };
    return { request: String(addr), symbol, addr: parseInt(m[1], 16), data: m[2] };
  }

  /** Peripherie-Register eines Moduls ohne Nebenwirkung lesen */
  async _peekModule(mon, module) {
    const regs = this.registers.byModule[module] || [];
    const addrs = [...new Set(regs.map((r) => r.addr))];
    const values = {};
    // In Stücken, damit eine Monitor-Zeile nicht zu lang wird
    for (let i = 0; i < addrs.length; i += 64) {
      const list = addrs.slice(i, i + 64).map((x) => x.toString(16).toUpperCase().padStart(8, '0'));
      const m = PR_RE.exec(await mon.execute(`${this.experiment.status.path} PeekRegisters "${list.join(',')}"`));
      if (!m) continue;
      for (const x of m[1].split(';').filter(Boolean)) {
        const [ad, v] = x.split('=');
        values[parseInt(ad, 16)] = v === '-' ? null : parseInt(v, 16);
      }
    }
    return {
      module,
      regs: regs.map((r) => ({ name: r.name, addr: r.addr, value: values[r.addr] === undefined ? null : values[r.addr] })),
      noClock: regs.length > 0 && regs.every((r) => values[r.addr] === null),
    };
  }

  /** Flanken der abonnierten Leitungen abholen und an die Abonnenten verteilen */
  async _pollSignals(mon) {
    let infoChanged = false;
    for (const path of this._subscribedPaths()) {
      const out = await mon.execute(`${path} GetEdges`);
      const discard = this.freshPaths.delete(path);
      for (const m of out.matchAll(SE_RE)) {
        const name = m[1];
        const baud = Number(m[4]);
        const format = m[5];
        const old = this.signalInfo[name];
        if (!old || old.baud !== baud || old.format !== format) {
          this.signalInfo[name] = { baud, format };
          infoChanged = true;
        }
        const msg = { type: 'edges', name, now: Number(m[2]), level: Number(m[3]), edges: [] };
        if (!discard) {
          let t = 0;
          m[7].split(';').forEach((x, i) => {
            if (!x) return;
            const [d, l] = x.split(',');
            t = i === 0 ? Number(d) : t + Number(d);
            msg.edges.push([t, Number(l)]);
          });
          if (+m[6] > 0) msg.lost = +m[6];
        }
        const data = JSON.stringify(msg);
        for (const ws of this.wss.clients) {
          if (ws.readyState === WebSocket.OPEN && ws.signals && ws.signals.has(name)) ws.send(data);
        }
      }
    }
    if (infoChanged) {
      const data = JSON.stringify(this._signalsMessage());
      for (const ws of this.wss.clients) {
        if (ws.readyState === WebSocket.OPEN && ws.signals && ws.signals.size) ws.send(data);
      }
    }
  }

  close() {
    this.detach();
    this.wss.close();
  }
}

module.exports = { ControlBridge };
