# Web-Konsole (Docker)

Mit der Web-Konsole simulieren Sie den TM4C1294 im Browser. Sie laden die von CCS gebaute
`.out`-Datei hoch und bedienen die Hardware auf einer Webseite: je nach Versuch LEDs, Taster,
UART-Terminal, OLED-Display, Ultraschallsensoren, Keypads, 7-Segment-Anzeige und Pendeldisplay.
Renode, die Modelle aus `sim/` und die Oberfläche laufen zusammen in einem Container. Einen
Compiler gibt es dort nicht.

Einstieg Schritt für Schritt (Installation, Bedienung, eigene Versuche): **[docs/ANLEITUNG.md](../docs/ANLEITUNG.md)**
Ausführliche Beschreibung (Architektur, Protokolle, Betrieb, Tests): **[docs/WEBCONSOLE.md](../docs/WEBCONSOLE.md)**

## Starten

```bash
cd webconsole
docker compose up --build
```

Dann im Browser **http://localhost:3000** öffnen.

1. **Versuch** wählen (z. B. „Simple Elemente“). Die Bedienelemente erscheinen sofort als Vorschau.
2. **Firmware** wählen: die `.out`-Datei aus CCS (`Debug/<projekt>.out`) oder aus `make`.
3. **Start** klicken. Das Bedienfeld verbindet sich mit der Simulation (unter 1 s, nach dem
   Container-Start einmalig ca. 10 s zum Übersetzen der Modelle), und die Ausgabe von UART0 läuft
   im Terminal.

Zum Ausprobieren: [Example 04 – Pendeldisplay](../examples/example04_pendeldisplay/README.md) mit
Versuch „Example 2“, [Example 05 – Timer mit CCP-Pins](../examples/example05_timer_ccp/README.md) mit
„Example 3“, die Musterlösungen der Labs mit „Lab 1“ … „Lab 4“ (Knopf **Musterlösung**).
[Example 03 – Web-Konsole](../examples/example03_webkonsole/README.md) braucht OLED, MB1242 und Keypad;
den passenden Versuch zeigt [docs/ANLEITUNG.md, Abschnitt 3](../docs/ANLEITUNG.md#3-neuen-versuch-hinzufügen).

| Bedienelement | Wirkung in der Simulation |
|---|---|
| Taster (z. B. USR_SW1/USR_SW2) | gedrückt halten → Pin = LOW (bei `activeLow`) |
| Keypad | verbindet Zeile und Spalte der Matrix wie die echte Elektrik |
| Schieberegler | Messwert des Ultraschallsensors (HC-SR04 oder MB1242) in cm |
| Reset | Reset-Taster des Boards: der Mikrocontroller startet neu, Firmware und Geräte außerhalb des Chips bleiben |
| Simulation | blendet die Simulations-Anzeige ein: Firmware, CPU-Zustand, Simulationszeit und Tempo, UART-Einstellungen; Debugger (Pause, Einzelschritt, Weiter), CPU-Register mit Disassembly, Speicher (Adresse oder Symbol), Peripherie-Register mit Namen aus tm4c1294ncpdt.h, Meldungen von Renode |
| Terminal | Tastatureingaben gehen an UART0 RX, Ausgaben von UART0 TX erscheinen hier. Darunter die Einstellung des Terminals (Baud, Datenbits, Parität, Stoppbits) wie in Tera Term – passt sie nicht zur Firmware, erscheinen falsche Zeichen |
| LEDs, OLED | zeigen den Pegel der LED-Pins (z. B. D1–D4 = PN1/PN0/PF4/PF0) bzw. das Bild des SSD1306 |
| Oszilloskop | 〰 Oszi: Pegel von bis zu 4 Pins des Versuchs mit Trigger und Zeitbasis |
| Pendeldisplay (Example 2) | schwingender Stab (Drehpunkt unten) mit den 8 LEDs an PM0–PM7 und ihrer abklingenden Leuchtspur; Regler für Pendelfrequenz (0,1–20 Hz) und Nachleuchtdauer (1 ms – 1 s); Auswahl: beide Schwünge, eine Richtung oder Standbild |

## Ordner

```
webconsole/
├── Dockerfile            mehrstufig: Frontend bauen, Backend-Pakete, Renode 1.17.0, Runtime
├── docker-compose.yml    Build-Kontext = Repository (sim/ wird ins Image kopiert)
├── backend/              Node.js/Express (Entrypoint server.js)
│   ├── server.js         HTTP: SPA, POST /upload, /api/*
│   ├── lib/
│   │   ├── config.js         Umgebungsvariablen
│   │   ├── experiments.js    Versuche (sim/experiments/<id>.json) laden, .repl/.resc ablegen
│   │   ├── experimentSpec.js Versuchsdatei prüfen, Renode-Plattform und Startskript erzeugen
│   │   ├── renodeManager.js  Renode-Child-Prozess starten/beenden, Log weiterleiten
│   │   ├── monitorClient.js  Telnet-Client für den Renode-Monitor (Befehlswarteschlange)
│   │   ├── uartBridge.js     UART-TCP ⇄ WebSocket :3333
│   │   └── controlBridge.js  Monitor/LED-Bridge ⇄ WebSocket :3334 (JSON)
│   └── test/             e2e*.js gegen echtes Renode (Übersicht: docs/WEBCONSOLE.md, Abschnitt 6)
└── frontend/             React (Vite)
    └── src/
        ├── hooks/useReconnectingWebSocket.js
        ├── context/ControlSocket.jsx
        ├── layout/          Workspace (Spalten-Layout: einklappen, verschieben, Breite),
        │                    ScaleBox (Anzeigen passen sich der Panelgröße an)
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

Intern, also nicht exponiert: 1234 (Renode-Monitor), 1235 (Abfrage-Port), 3335 (UART-TCP), 9000 (LED-Bridge).

## Entwicklung ohne Docker

```bash
cd webconsole/frontend && npm install && npm run build
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start
# Test (zweites Terminal):
node test/e2e_example2.js ../../examples/example04_pendeldisplay/example04_pendeldisplay.out
```

Alle Tests und ihre Voraussetzungen: [docs/WEBCONSOLE.md, Abschnitt 6](../docs/WEBCONSOLE.md#6-test).

Mit `npm run dev` im Frontend läuft Vite auf Port 5173 und leitet `/upload` und `/api` an
Port 3000 weiter.
