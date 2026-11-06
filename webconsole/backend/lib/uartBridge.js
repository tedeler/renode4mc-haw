'use strict';

const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Brücke: Renode-UART (CreateServerSocketTerminal, TCP) <-> WebSocket (Binärframes).
 * Mehrere Browser-Clients teilen sich eine TCP-Verbindung zu Renode.
 */
class UartBridge {
  constructor({ wsPort, renodeHost, renodePort }) {
    this.renodeHost = renodeHost;
    this.renodePort = renodePort;
    this.sock = null;
    this.history = []; // kleiner Puffer für spät verbundene Clients
    this.historyBytes = 0;

    this.wss = new WebSocketServer({ port: wsPort });
    this.wss.on('connection', (ws) => {
      for (const chunk of this.history) ws.send(chunk, { binary: true });
      ws.on('message', (data) => {
        if (this.sock && !this.sock.destroyed) this.sock.write(Buffer.from(data));
      });
    });
    console.log(`[uart] WebSocket auf Port ${wsPort}`);
  }

  _remember(chunk) {
    this.history.push(chunk);
    this.historyBytes += chunk.length;
    while (this.historyBytes > 16 * 1024 && this.history.length > 1) {
      this.historyBytes -= this.history.shift().length;
    }
  }

  _broadcast(chunk) {
    this._remember(chunk);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    }
  }

  /** Verbindet mit dem Renode-UART-Socket (mit Retries). */
  async attach(timeoutMs, isAlive = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive()) throw new Error('Renode-Prozess wurde beendet');
      try {
        this.sock = await new Promise((resolve, reject) => {
          const s = net.connect({ host: this.renodeHost, port: this.renodePort });
          s.once('error', reject);
          s.once('connect', () => {
            s.removeListener('error', reject);
            resolve(s);
          });
        });
        this.sock.setNoDelay(true);
        this.sock.on('data', (d) => this._broadcast(d));
        this.sock.on('error', () => {});
        this.sock.on('close', () => {
          this.sock = null;
        });
        console.log('[uart] mit Renode verbunden');
        return;
      } catch {
        await sleep(300);
      }
    }
    throw new Error('Renode-UART-Socket nicht erreichbar');
  }

  /** Trennt Renode und zwingt alle Browser zum Reconnect (Code 4000 = Neustart). */
  detach(reason = 'renode-restart') {
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this.history = [];
    this.historyBytes = 0;
    for (const ws of this.wss.clients) ws.close(4000, reason);
  }

  close() {
    this.detach('shutdown');
    this.wss.close();
  }
}

module.exports = { UartBridge };
