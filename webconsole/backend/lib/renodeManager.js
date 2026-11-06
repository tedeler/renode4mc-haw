'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
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
    const msg = `[renode${stream === 'stderr' ? ':err' : ''}] ${line}`;
    if (stream === 'stderr') console.error(msg);
    else console.log(msg);
    this.logTail.push(line);
    if (this.logTail.length > 80) this.logTail.shift();
    this.emit('log', line);
  }

  /**
   * Startet Renode headless:  renode --disable-gui --port <n> -e "$elf=@<elf>; s @<rescPath>"
   * Arbeitsverzeichnis ist sim/, damit die relativen Pfade in den .resc-Dateien stimmen.
   */
  async start(experimentId, rescPath, elfPath) {
    await this.stop();
    this.logTail = [];

    const args = [
      this.headlessFlag,
      '--port',
      String(this.monitorPort),
      '-e',
      `$elf=@${elfPath}; s @${rescPath}`,
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

module.exports = { RenodeManager };
