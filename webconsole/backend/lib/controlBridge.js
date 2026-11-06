'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { MonitorClient } = require('./monitorClient');
const experiments = require('./experiments');

const FB_RE = /FB:(\d+)x(\d+):([01])([01]):([A-Za-z0-9+/=]+)/;
const LED_RE = /^LED(\d)=([01])$/;

/**
 * Control-WebSocket (Port 3334) – die "Monitor-Brücke" zwischen Browser und Renode.
 *
 *  Browser --JSON--> Backend --Monitor-Befehl--> Renode (Telnet-Monitor, Port 1234)
 *  Renode  --LED-Bridge (ws://127.0.0.1:9000, sim/models/WebSocketBridge.cs)--> Backend --JSON--> Browser
 *  Renode  --Polling (OLED-Framebuffer, LEDs mit "path")--> Backend --JSON--> Browser
 *
 * Client -> Server
 *   { type: "button", id, pressed }            Taster (id aus der Versuchs-JSON)
 *   { type: "keypad", row, col, pressed }      Keypad: Zeile/Spalte der Matrix, nicht die Taste
 *   { type: "sensor", value }                  Distanz in cm
 * Server -> Client
 *   { type: "hello", experiment, renode, leds, fb }
 *   { type: "leds", states: { [id]: boolean } }
 *   { type: "fb", width, height, on, invert, data }   data = Base64, SSD1306-Page-Format
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
    this.pollTimer = null;
    this.polling = false;
    this.ledSocket = null;
    this.ledRetry = null;

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
    };
  }

  _onClient(ws) {
    this._send(ws, this._hello());
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: 'error', message: 'Ungültiges JSON' });
      }
      try {
        await this._handle(msg);
      } catch (e) {
        this._send(ws, { type: 'error', message: e.message });
      }
    });
  }

  /** Übersetzt ein UI-Kommando in Renode-Monitor-Befehle (Pfade nur aus der Versuchs-Konfiguration). */
  async _handle(msg) {
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
        } else {
          // Pegel direkt am GPIO-Eingang; activeLow: gedrückt = LOW (Taster gegen GND, Pull-up)
          const level = btn.activeLow ? !pressed : pressed;
          await run(`${btn.port} OnGPIO ${btn.pin} ${level}`);
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
      default:
        throw new Error(`Unbekannter Typ: ${msg.type}`);
    }
  }

  /** Verbindet mit der neu gestarteten Renode-Instanz und startet Polling/LED-Bridge. */
  async attach(experiment, timeoutMs, isAlive) {
    this.detach();
    this.experiment = experiment;
    this.ledStates = Object.fromEntries((experiment.leds || []).map((l) => [l.id, false]));
    this.lastFrame = null;

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
    this._startPolling();
  }

  detach() {
    this._stopPolling();
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
