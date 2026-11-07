'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { MonitorClient } = require('./monitorClient');
const experiments = require('./experiments');

const FB_RE = /FB:(\d+)x(\d+):([01])([01]):([A-Za-z0-9+/=]+)/;
const LED_RE = /^LED(\d)=([01])$/;
const PD_RE = /PD:(\d+):(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+)/;
const EV_RE = /EV:(\d+):(\d+):(\d+):(\d+):([\d,;]*)/;
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
 *   { type: "clearDiagnostics" }               Diagnose-Liste leeren
 *   { type: "scope", sources: ["PD0", …] }     Oszilloskop: Pins, die dieser Browser sehen will (max. 5,
 *                                              [] = Oszilloskop aus). Aufgezeichnet wird die Vereinigung
 *                                              aller Browser (sim/models/Oscilloscope.cs).
 * Server -> Client
 *   { type: "hello", experiment, renode, leds, fb, pd }
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
  constructor({ wsPort, renodeHost, monitorPort, pollIntervalMs }) {
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

  _hello() {
    return {
      type: 'hello',
      experiment: experiments.publicView(this.experiment),
      renode: this.attached ? 'running' : 'stopped',
      leds: this.ledStates,
      fb: this.lastFrame,
      pd: this.lastPendulum,
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
    ws.scopeSources = [];
    ws.on('close', () => this._updateScopeProbes().catch(() => {}));
    this._send(ws, this._hello());
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: 'error', message: 'Ungültiges JSON' });
      }
      try {
        if (msg && msg.type === 'scope') return await this._scopeSources(ws, msg.sources);
        await this._handle(msg);
      } catch (e) {
        this._send(ws, { type: 'error', message: e.message });
      }
    });
  }

  /** Übersetzt ein UI-Kommando in Renode-Monitor-Befehle (Pfade nur aus der Versuchs-Konfiguration). */
  async _handle(msg) {
    if (msg && msg.type === 'clearDiagnostics') {
      this.diagnostics = [];
      this._broadcast({ type: 'diagReset' });
      return;
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
    this._connectLedBridge();
    this._broadcast(this._hello());
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
    } catch (e) {
      if (this.attached) console.error(`[control] Poll-Fehler: ${e.message}`);
    } finally {
      this.polling = false;
    }
  }

  close() {
    this.detach();
    this.wss.close();
  }
}

module.exports = { ControlBridge };
