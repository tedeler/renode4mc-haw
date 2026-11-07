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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verwaltet genau einen Renode-Child-Prozess (headless).
 */
class RenodeManager extends EventEmitter {
  constructor({ bin, headlessFlag, monitorPort, cwd }) {
    super();
    this.bin = bin;
    this.headlessFlag = headlessFlag;
    this.monitorPort = monitorPort;
    this.cwd = cwd;
    this.child = null;
    this.experimentId = null;
    this.logTail = [];
  }

  get running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
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

  /**
   * Startet Renode headless:  renode --disable-gui --port <n> -e "$elf=@<elf>; s @<rescPath>"
   * Arbeitsverzeichnis ist sim/, damit die relativen Pfade in den .resc-Dateien stimmen.
   * uart = { baud, format }: Einstellung des PC-Terminals ($uartBaud, $uartFormat im .resc),
   * schon vor dem Start der Emulation gesetzt, damit die ersten Zeichen richtig ankommen.
   */
  async start(experimentId, rescPath, elfPath, uart = null) {
    await this.stop();
    this.logTail = [];

    const args = [
      this.headlessFlag,
      '--port',
      String(this.monitorPort),
      '-e',
      `$elf=@${elfPath}; ${uartVars(uart)}s @${rescPath}`,
    ];
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
      if (this.child === child) {
        this.child = null;
        this.experimentId = null;
      }
      this.emit('exit', { code, signal, experimentId });
    });

    // Kurz warten, um Sofort-Abstürze (z.B. Binary nicht gefunden) zu erkennen
    await sleep(200);
    if (!this.running) {
      throw new Error(`Renode konnte nicht gestartet werden:\n${this.logTail.join('\n')}`);
    }
    this.emit('spawned', { experimentId });
  }

  async stop() {
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
