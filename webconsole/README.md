# Web-Konsole (Docker)

Mit der Web-Konsole simulieren Sie den TM4C1294 im Browser. Sie laden die von CCS gebaute
`.out`-Datei hoch und bedienen die Hardware auf einer Webseite: LEDs, Taster, UART-Terminal,
OLED-Display, Ultraschallsensor und Keypad. Renode, die Modelle aus `sim/` und die Oberfläche
laufen zusammen in einem Container. Einen Compiler gibt es dort nicht.

Ausführliche Beschreibung (Architektur, Protokolle, eigene Versuche): **[docs/WEBCONSOLE.md](../docs/WEBCONSOLE.md)**

## Starten

```bash
cd webconsole
docker compose up --build
```

Dann im Browser **http://localhost:3000** öffnen.

1. **Versuch** wählen (z. B. „Versuch 1 – EK-TM4C1294XL …“).
2. **Firmware** wählen: die `.out`-Datei aus CCS (`Debug/<projekt>.out`) oder aus `make`.
3. **Start** klicken. Nach wenigen Sekunden erscheint das Bedienfeld, und die Ausgabe von UART0
   läuft im Terminal.

Zum Ausprobieren: [Lab 03 – Web-Konsole](../examples/lab03_webkonsole/README.md) nutzt alle
Bedienelemente von Versuch 1, [Lab 04 – Pendeldisplay](../examples/lab04_pendeldisplay/README.md)
das Pendeldisplay von Versuch 2.

| Bedienelement | Wirkung in der Simulation |
|---|---|
| Taster USR_SW1/USR_SW2 | gedrückt halten → PJ0/PJ1 = LOW |
| Keypad | verbindet Zeile und Spalte der Matrix (PK0–PK3 × PK4–PK6) |
| Schieberegler | Messwert des Ultraschallsensors (I2C0, 0x70) in cm |
| Reset | Reset-Taster des Boards: der Mikrocontroller startet neu, Firmware und Geräte außerhalb des Chips bleiben |
| Simulation | blendet die Simulations-Anzeige ein: Firmware, CPU-Zustand, Simulationszeit und Tempo, UART-Einstellungen; Debugger (Pause, Einzelschritt, Weiter), CPU-Register mit Disassembly, Speicher (Adresse oder Symbol), Peripherie-Register mit Namen aus tm4c1294ncpdt.h, Meldungen von Renode |
| Terminal | Tastatureingaben gehen an UART0 RX, Ausgaben von UART0 TX erscheinen hier. Darunter die Einstellung des Terminals (Baud, Datenbits, Parität, Stoppbits) wie in Tera Term – passt sie nicht zur Firmware, erscheinen falsche Zeichen |
| LEDs, OLED | zeigen den Zustand von PN1/PN0/PF4/PF0 bzw. des SSD1306 (I2C0, 0x3C) |
| Pendeldisplay (Versuch 2) | schwingender Stab (Drehpunkt unten) mit den 8 LEDs an PM0–PM7 und ihrer abklingenden Leuchtspur; Regler für Pendelfrequenz (0,1–20 Hz) und Nachleuchtdauer (1 ms – 1 s); Auswahl: beide Schwünge, eine Richtung oder Standbild |

## Ordner

```
webconsole/
├── Dockerfile            mehrstufig: Frontend bauen, Backend-Pakete, Renode 1.17.0, Runtime
├── docker-compose.yml    Build-Kontext = Repository (sim/ wird ins Image kopiert)
├── backend/              Node.js/Express (Entrypoint server.js)
│   ├── server.js         HTTP: SPA, POST /upload, /api/*
│   ├── lib/
│   │   ├── config.js         Umgebungsvariablen
│   │   ├── experiments.js    Versuche aus sim/experiments laden und prüfen
│   │   ├── renodeManager.js  Renode-Child-Prozess starten/beenden, Log weiterleiten
│   │   ├── monitorClient.js  Telnet-Client für den Renode-Monitor (Befehlswarteschlange)
│   │   ├── uartBridge.js     UART-TCP ⇄ WebSocket :3333
│   │   └── controlBridge.js  Monitor/LED-Bridge ⇄ WebSocket :3334 (JSON)
│   └── test/             e2e.js (Versuch 1, Lab 03), e2e_versuch2.js (Versuch 2, Lab 04)
└── frontend/             React (Vite)
    └── src/
        ├── hooks/useReconnectingWebSocket.js
        ├── context/ControlSocket.jsx
        └── components/  SetupBar, ControlPanel, UartMonitor (xterm.js), Led, PushButton,
                         OledDisplay (Canvas), DistanceSensor, Keypad (Matrix-Zuordnung),
                         PendulumDisplay (Canvas, Nachleuchtbild)
```

## Ports

| Port | Dienst |
|---|---|
| 3000 | Web-Oberfläche, Upload |
| 3333 | UART-WebSocket |
| 3334 | Control-WebSocket |

Intern, also nicht exponiert: 1234 (Renode-Monitor), 3335 (UART-TCP), 9000 (LED-Bridge).

## Entwicklung ohne Docker

```bash
cd webconsole/frontend && npm install && npm run build
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start
# Test (zweites Terminal):
node test/e2e.js ../../examples/lab03_webkonsole/lab03_webkonsole.out
node test/e2e_versuch2.js ../../examples/lab04_pendeldisplay/lab04_pendeldisplay.out
```

Mit `npm run dev` im Frontend läuft Vite auf Port 5173 und leitet `/upload` und `/api` an
Port 3000 weiter.
