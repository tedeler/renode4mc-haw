'use strict';

const { spawn, spawnSync } = require('child_process');
const { isValidUartSettings } = require('./experiments');

function uartVars(uart) {
  if (!uart || !isValidUartSettings(uart.baud, uart.format)) return '';
  return `$uartBaud=${uart.baud}; $uartFormat="${uart.format}"; `;
}
const { EventEmitter } = require('events');
const net = require('net');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { MonitorClient } = require('./monitorClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Übersetzungsreihenfolge beim Vorab-Laden: wie tm4c1294.resc (UartLine vor TivaUART, UartHostTerminal
// danach), dann die übrigen Modelle alphabetisch
const BASE_MODELS = [
  'TivaSysCtl.cs',
  'TivaGPIOPort.cs',
  'TivaTimer.cs',
  'UartLine.cs',
  'TivaUART.cs',
  'UartHostTerminal.cs',
  'TivaI2C.cs',
  'WebSocketBridge.cs',
  'Oscilloscope.cs',
];

const LOAD_ERROR_RE = /There was an error executing command|Unhandled exception|Exception has been thrown/;

/**
 * Verwaltet genau einen Renode-Child-Prozess (headless).
 *
 * Dauerbetrieb (Standard, RENODE_PERSISTENT=0 schaltet ihn ab): Renode startet einmal, übersetzt alle
 * C#-Modelle aus sim/models (~6 s) und bleibt laufen. Ein Versuch wird über den Monitor geladen:
 * `Clear` (Maschine und Emulation zurücksetzen), Variablen setzen, `include @<versuch>.resc` (~0,3 s statt ~10 s).
 * Renode überspringt bereits übersetzte .cs-Dateien ("has already been compiled"); geänderte
 * Modelldateien erkennt load() am Änderungsdatum und startet Renode dann neu. Schlägt das Laden fehl,
 * wird Renode einmal neu gestartet und das Laden wiederholt.
 */
class RenodeManager extends EventEmitter {
  constructor({ bin, headlessFlag, monitorPort, queryPort, cwd, persistent = true, host = '127.0.0.1', loadTimeoutMs = 120000 }) {
    super();
    this.bin = bin;
    this.headlessFlag = headlessFlag;
    this.monitorPort = monitorPort;
    this.queryPort = queryPort;
    this.cwd = cwd;
    this.persistent = persistent;
    this.host = host;
    this.loadTimeoutMs = loadTimeoutMs;
    this.child = null;
    this.experimentId = null;
    this.machine = null; // geladene Maschine (Dauerbetrieb)
    this.logTail = [];
    this.booting = null; // Promise eines laufenden Vorab-Ladens
    this.modelStamp = ''; // Stand der übersetzten Modelldateien ('' = nicht bereit)
  }

  get running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** true, solange eine Maschine geladen ist (Dauerbetrieb) bzw. der Prozess läuft (sonst) */
  get loaded() {
    return this.running && (!this.persistent || !!this.machine);
  }

  _log(stream, line) {
    // ein Ereignis je Zeile (auch Stackframes): log(line, stream)
    this.emit('log', line, stream);
    const msg = `[renode${stream === 'stderr' ? ':err' : ''}] ${line}`;
    if (stream === 'stderr') console.error(msg);
    else console.log(msg);
    // .NET-Stackframes nur auf die Konsole: Sie verdrängen sonst die eigentliche
    // Fehlermeldung (z.B. "Address already in use") aus dem Log-Ausschnitt fürs Frontend.
    if (/^\s+at |^\s*--- End of /.test(line)) return;
    this.logTail.push(line);
    if (this.logTail.length > 80) this.logTail.shift();
  }

  _spawn(execute, experimentId) {
    const args = [this.headlessFlag, '--port', String(this.monitorPort)];
    if (execute) args.push('-e', execute);
    console.log(`[renode] spawn: ${this.bin} ${args.map((a) => JSON.stringify(a)).join(' ')}`);

    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      // stdin offen halten: Renode beendet sich sonst unter Umständen (siehe docs/TOOLCHAIN.md)
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // eigene Prozessgruppe -> komplette Gruppe kann gekillt werden
      env: { ...process.env, TERM: 'dumb' },
    });
    this.child = child;
    this.experimentId = experimentId;

    readline.createInterface({ input: child.stdout }).on('line', (l) => this._log('stdout', l));
    readline.createInterface({ input: child.stderr }).on('line', (l) => this._log('stderr', l));

    child.once('error', (e) => this._log('stderr', `spawn error: ${e.message}`));
    child.once('exit', (code, signal) => {
      console.log(`[renode] beendet (code=${code}, signal=${signal})`);
      const expId = this.experimentId;
      if (this.child === child) {
        this.child = null;
        this.experimentId = null;
        this.machine = null;
        this.modelStamp = '';
      }
      this.emit('exit', { code, signal, experimentId: expId });
    });
    return child;
  }

  async _assertSpawned() {
    // Kurz warten, um Sofort-Abstürze (z.B. Binary nicht gefunden) zu erkennen
    await sleep(200);
    if (!this.running) {
      throw new Error(`Renode konnte nicht gestartet werden:\n${this.logTail.join('\n')}`);
    }
  }

  /** Änderungsdaten aller Modelldateien (geändertes Modell -> Renode neu starten) */
  _models() {
    const dir = path.join(this.cwd, 'models');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.cs'));
    } catch {
      /* kein models/ */
    }
    const rest = files.filter((f) => !BASE_MODELS.includes(f)).sort();
    const order = [...BASE_MODELS.filter((f) => files.includes(f)), ...rest];
    const stamp = order.map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
    return { order, stamp };
  }

  async _monitor(timeoutMs) {
    const mon = new MonitorClient({ host: this.host, port: this.monitorPort, commandTimeoutMs: timeoutMs });
    mon.on('error', () => {});
    await mon.connect(timeoutMs, () => this.running);
    return mon;
  }

  async _run(mon, cmd) {
    const out = await mon.execute(cmd);
    if (LOAD_ERROR_RE.test(out)) throw new Error(`Renode: ${cmd}\n${out}`);
    return out;
  }

  /**
   * Dauerbetrieb: Renode starten (falls nötig) und alle Modelle übersetzen. Mehrfachaufruf wartet auf
   * dasselbe Vorab-Laden. Wird beim Start des Backends aufgerufen, damit schon der erste Upload schnell ist.
   */
  boot() {
    if (!this.persistent) return Promise.resolve();
    if (this.booting) return this.booting;
    const { stamp } = this._models();
    if (this.running && this.modelStamp === stamp) return Promise.resolve();
    if (this.running && this.modelStamp) console.log('[renode] Modelldateien geändert – Renode wird neu gestartet');
    this.booting = this._boot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  async _boot() {
    await this.kill();
    const t0 = Date.now();
    const { order, stamp } = this._models();
    this.logTail = [];
    this._spawn(null, null);
    await this._assertSpawned();
    const mon = await this._monitor(this.loadTimeoutMs);
    try {
      for (const f of order) await this._run(mon, `include @models/${f}`);
    } finally {
      mon.close();
    }
    this.modelStamp = stamp;
    console.log(`[renode] bereit: ${order.length} Modelle übersetzt in ${Date.now() - t0} ms`);
    this.emit('spawned', { experimentId: null });
  }

  /**
   * Startet einen Versuch.
   * uart = { baud, format }: Einstellung des PC-Terminals ($uartBaud, $uartFormat im .resc),
   * schon vor dem Start der Emulation gesetzt, damit die ersten Zeichen richtig ankommen.
   * machine: Name der Maschine im .resc (nur zur Anzeige im Log)
   */
  async start(experimentId, rescPath, elfPath, uart = null, machine = 'tm4c1294') {
    if (!this.persistent) return this._startProcess(experimentId, rescPath, elfPath, uart);
    try {
      await this._load(experimentId, rescPath, elfPath, uart, machine);
    } catch (e) {
      console.error(`[renode] Laden fehlgeschlagen (${e.message.split('\n')[0]}) – starte Renode neu`);
      await this.kill();
      await this._load(experimentId, rescPath, elfPath, uart, machine);
    }
  }

  async _load(experimentId, rescPath, elfPath, uart, machine) {
    await this.boot();
    const t0 = Date.now();
    const mon = await this._monitor(this.loadTimeoutMs);
    try {
      if (this.machine) {
        // "Clear" statt "mach rem": setzt auch die Emulation zurück. Nach "mach rem" liefe die
        // virtuelle Zeit der neuen Maschine ab dem Stand der alten weiter, und das "start" am Ende
        // der .resc würde ignoriert ("Emulation is already started"). Übersetzte Modelle bleiben.
        await this._run(mon, 'Clear');
        this.machine = null;
      }
      this.logTail = [];
      await this._run(mon, `$elf=@${elfPath}`);
      if (this.queryPort) await this._run(mon, `$queryPort=${this.queryPort}`);
      if (uart && isValidUartSettings(uart.baud, uart.format)) {
        await this._run(mon, `$uartBaud=${uart.baud}`);
        await this._run(mon, `$uartFormat="${uart.format}"`);
      }
      this.machine = machine;
      this.experimentId = experimentId;
      await this._run(mon, `include @${rescPath}`);
    } finally {
      mon.close();
    }
    console.log(`[renode] Versuch "${experimentId}" geladen in ${Date.now() - t0} ms`);
  }

  /** Ohne Dauerbetrieb: eigener Renode-Prozess je Versuch (bisheriges Verhalten) */
  async _startProcess(experimentId, rescPath, elfPath, uart) {
    await this.kill();
    this.logTail = [];
    const execute = `$elf=@${elfPath}; ${this.queryPort ? `$queryPort=${this.queryPort}; ` : ''}${uartVars(uart)}s @${rescPath}`;
    this._spawn(execute, experimentId);
    await this._assertSpawned();
    this.emit('spawned', { experimentId });
  }

  /**
   * Versuch beenden. Dauerbetrieb: nur die Maschine entfernen (Renode läuft weiter und gibt dabei die
   * Ports der Modelle frei); sonst Prozess beenden.
   */
  async stop() {
    if (!this.persistent) return this.kill();
    if (this.booting) await this.booting.catch(() => {});
    if (!this.running || !this.machine) {
      this.experimentId = null;
      return;
    }
    try {
      const mon = await this._monitor(10000);
      try {
        await this._run(mon, 'Clear');
      } finally {
        mon.close();
      }
      this.machine = null;
      this.experimentId = null;
    } catch (e) {
      console.error(`[renode] Entfernen der Maschine fehlgeschlagen (${e.message}) – beende Renode`);
      await this.kill();
    }
  }

  /** Renode-Prozess beenden (auch verwaiste Instanzen) */
  async kill() {
    const child = this.child;
    if (child && this.running) {
      const exited = new Promise((r) => child.once('exit', r));
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const ok = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)]);
      if (!ok) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        await Promise.race([exited, sleep(2000)]);
      }
    }
    this.child = null;
    this.experimentId = null;
    this.machine = null;
    this.modelStamp = '';

    // Verwaiste Instanzen (z.B. nach Server-Neustart) beseitigen: pkill renode
    // portable Version: Prozessname "renode"; Mono/.NET-Varianten: Renode.exe / Renode.dll
    for (const args of [['-x', 'renode'], ['-f', 'Renode\\.(exe|dll)']]) {
      try {
        spawnSync('pkill', args, { stdio: 'ignore' });
      } catch {
        /* pkill nicht vorhanden */
      }
    }
    // Ports freigeben lassen
    await sleep(300);
  }
}

/** true, wenn auf 127.0.0.1:<port> gerade niemand lauscht. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Prüft vor dem Renode-Start, ob die von Renode geöffneten Ports frei sind.
 * Renode selbst bricht bei einem belegten Port (z.B. LED-Bridge 9000) mit einer
 * unbehandelten SocketException ab – mit über 100 Zeilen Stacktrace und ohne klaren Hinweis.
 * @param {{port:number, name:string}[]} ports
 */
async function assertPortsFree(ports, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = [];
    for (const p of ports) if (!(await portFree(p.port))) busy.push(p);
    if (!busy.length) return;
    if (Date.now() >= deadline) {
      const list = busy.map((p) => `${p.port} (${p.name})`).join(', ');
      throw new Error(
        `Port ${list} ist bereits belegt. Läuft noch eine andere Renode-Instanz ` +
          `(z.B. ucsim/Visualizer) oder ein anderer Dienst auf diesem Port? ` +
          `Prüfen mit: ss -ltnp | grep -E ':(${busy.map((p) => p.port).join('|')})\\b'`,
      );
    }
    await sleep(250); // Ports eines eben beendeten Renode werden evtl. noch freigegeben
  }
}

module.exports = { RenodeManager, assertPortsFree };
