'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
const PROMPT_RE = /\(([^()\r\n]+)\)\s*$/;

/** Entfernt Telnet-Steuersequenzen (IAC ...) aus einem Buffer. */
function stripTelnet(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 0xff) {
      out[n++] = b;
      continue;
    }
    const cmd = buf[i + 1];
    if (cmd === 0xff) {
      out[n++] = 0xff;
      i += 1;
    } else if (cmd === 0xfa) {
      let j = i + 2;
      while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xf0)) j++;
      i = j + 1;
    } else if (cmd >= 0xfb && cmd <= 0xfe) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return out.subarray(0, n);
}

/**
 * Minimaler Client für den Renode-Monitor (Telnet, `renode --port <n>`).
 * Befehle werden seriell abgearbeitet; die Antwort endet mit dem Monitor-Prompt "(machine) ".
 */
class MonitorClient extends EventEmitter {
  constructor({ host, port, commandTimeoutMs = 3000 }) {
    super();
    this.host = host;
    this.port = port;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = null;
    this.buffer = '';
    this.queue = [];
    this.current = null;
    this.connected = false;
  }

  /** Verbindet mit Retries, bis `timeoutMs` abgelaufen ist. */
  async connect(timeoutMs = 30000, isAlive = () => true) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      if (!isAlive()) throw new Error('Renode-Prozess wurde beendet');
      try {
        await this._connectOnce();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error(`Renode-Monitor nicht erreichbar: ${lastErr ? lastErr.message : 'Timeout'}`);
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      const fail = (e) => {
        sock.destroy();
        reject(e);
      };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        this.socket = sock;
        this.connected = true;
        this.buffer = '';
        sock.on('data', (d) => this._onData(d));
        sock.on('error', (e) => this.emit('error', e));
        sock.on('close', () => this._onClose());
        // Prompt anstoßen
        sock.write('\r\n');
        this.emit('connect');
        resolve();
      });
    });
  }

  _onData(chunk) {
    // ANSI-Sequenzen erst im Gesamtpuffer entfernen (sie können über Chunk-Grenzen gehen)
    this.buffer += stripTelnet(chunk).toString('utf8');
    if (this.buffer.length > 1 << 20) this.buffer = this.buffer.slice(-(1 << 16));
    this._tryResolve();
  }

  _tryResolve() {
    const cur = this.current;
    const clean = this.buffer.replace(ANSI_RE, '');
    if (!cur) {
      // Keine aktive Anfrage: nur den letzten Rest behalten
      if (PROMPT_RE.test(clean)) this.buffer = '';
      return;
    }
    const idx = clean.indexOf(cur.cmd);
    if (idx < 0) return;
    const rest = clean.slice(idx + cur.cmd.length);
    if (!PROMPT_RE.test(rest)) return;
    const output = rest
      .replace(PROMPT_RE, '')
      .replace(/\r/g, '')
      .trim();
    this.buffer = '';
    this._finish(null, output);
  }

  _finish(err, output) {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    if (err) cur.reject(err);
    else cur.resolve(output);
    setImmediate(() => this._next());
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    if (this.current) this._finish(new Error('Monitor-Verbindung geschlossen'));
    for (const q of this.queue.splice(0)) q.reject(new Error('Monitor-Verbindung geschlossen'));
    if (wasConnected) this.emit('close');
  }

  /**
   * Führt einen Monitor-Befehl aus.
   * @param {string} cmd
   * @param {{priority?: boolean}} opts priority=true stellt den Befehl vor Polling-Befehle
   */
  execute(cmd, { priority = false } = {}) {
    if (/[\r\n]/.test(cmd)) return Promise.reject(new Error('Ungültiger Befehl'));
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Monitor nicht verbunden'));
      const job = { cmd, resolve, reject, timer: null };
      if (priority) {
        const firstNonPrio = this.queue.findIndex((j) => !j.priority);
        job.priority = true;
        if (firstNonPrio < 0) this.queue.push(job);
        else this.queue.splice(firstNonPrio, 0, job);
      } else {
        this.queue.push(job);
      }
      this._next();
    });
  }

  /**
   * fn() (liefert ein Promise) in der Warteschlange des Monitors ausführen: läuft erst, wenn kein
   * Monitor-Befehl aktiv ist, und hält andere Befehle so lange zurück (z. B. Abfragen über den
   * Abfrage-Port von TivaSysCtl, die nicht gleichzeitig mit Monitor-Befehlen laufen sollen).
   */
  runExclusive(fn) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Monitor nicht verbunden'));
      this.queue.push({ run: fn, resolve, reject, timer: null, cmd: '(Abfrage)' });
      this._next();
    });
  }

  /** Mehrere Befehle direkt hintereinander, ohne dass andere Befehle dazwischen geraten. */
  executeAtomic(cmds) {
    return Promise.all(cmds.map((c) => this.execute(c, { priority: true })));
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  _next() {
    if (this.current || !this.connected) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.buffer = '';
    if (job.run) {
      job.timer = setTimeout(() => this._finish(new Error('Timeout bei Abfrage')), this.commandTimeoutMs);
      Promise.resolve()
        .then(job.run)
        .then(
          (out) => this.current === job && this._finish(null, out),
          (e) => this.current === job && this._finish(e),
        );
      return;
    }
    job.timer = setTimeout(() => {
      // Fallback: Prompt gesehen, aber Echo nicht erkannt
      const clean = this.buffer.replace(ANSI_RE, '');
      if (PROMPT_RE.test(clean)) {
        const out = clean.replace(PROMPT_RE, '').trim();
        this.buffer = '';
        this._finish(null, out);
      } else {
        this._finish(new Error(`Timeout bei "${job.cmd}"`));
      }
    }, this.commandTimeoutMs);
    this.socket.write(`${job.cmd}\r\n`);
  }

  close() {
    if (this.socket) this.socket.destroy();
    this._onClose();
  }
}

module.exports = { MonitorClient };
