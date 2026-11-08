'use strict';

const net = require('net');

/**
 * Client für den Abfrage-Port von TivaSysCtl (ServeQueries, Standard 1235): eine Zeile Anfrage
 * (Base64 der Befehlsliste), eine Zeile Antwort ("Z:<Base64 von gzip>"). Ersetzt für die
 * regelmäßigen Abfragen den Telnet-Monitor, der Antworten Zeichen für Zeichen sendet.
 * Anfragen strikt nacheinander (das Backend reiht sie in die Monitor-Warteschlange ein).
 */
class QueryClient {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.buffer = '';
    this.pending = null;
  }

  get connected() {
    return !!this.sock;
  }

  /** Verbindet (mit Retries); wirft, wenn der Port nicht erreichbar ist */
  async connect(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        this.sock = await new Promise((resolve, reject) => {
          const s = net.connect({ host: this.host, port: this.port });
          s.once('error', reject);
          s.once('connect', () => {
            s.removeListener('error', reject);
            resolve(s);
          });
        });
        this.sock.setNoDelay(true);
        this.sock.on('data', (d) => this._onData(d));
        this.sock.on('error', () => {});
        this.sock.on('close', () => {
          this.sock = null;
          if (this.pending) this.pending.reject(new Error('Abfrage-Port geschlossen'));
          this.pending = null;
        });
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`Abfrage-Port ${this.port} nicht erreichbar: ${lastErr ? lastErr.message : 'Timeout'}`);
  }

  _onData(d) {
    this.buffer += d.toString('latin1');
    const nl = this.buffer.indexOf('\n');
    if (nl < 0 || !this.pending) return;
    const line = this.buffer.slice(0, nl);
    this.buffer = this.buffer.slice(nl + 1);
    const p = this.pending;
    this.pending = null;
    p.resolve(line);
  }

  /** Eine Anfrage (Base64 der Befehlsliste) -> Antwortzeile */
  request(b64) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('Abfrage-Port nicht verbunden'));
      if (this.pending) return reject(new Error('Abfrage läuft schon'));
      this.pending = { resolve, reject };
      this.sock.write(`${b64}\n`);
    });
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

module.exports = { QueryClient };
