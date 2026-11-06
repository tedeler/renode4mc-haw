# Web-Konsole: TM4C1294-Simulation im Browser

Die Web-Konsole ist eine zweite Bedienoberfläche für den Simulator in `sim/`. Statt `ucsim` auf dem
eigenen Rechner läuft alles in **einem Docker-Container**: Studierende öffnen eine Webseite,
wählen einen Versuch, laden die von CCS gebaute `.out`-Datei hoch und bedienen die simulierte
Hardware im Browser. Dazu gehören LEDs, Taster, ein UART-Terminal, ein OLED-Display, ein
Ultraschallsensor, ein Keypad und ein Pendeldisplay.

Im Container gibt es keinen Compiler und keine IDE. Gebaut wird wie bisher mit CCS bzw. `make`
(siehe [TOOLCHAIN.md](TOOLCHAIN.md)). Der Container nimmt nur das fertige ELF entgegen. Er ist
**zustandslos**: Die Firmware liegt in `/tmp`, nichts wird dauerhaft gespeichert.

```
 CCS / make ──▶ programm.out ──Upload──▶ Web-Konsole (Docker) ──▶ Renode (sim/) ──▶ Browser-Bedienfeld
```

Kurzanleitung zum Starten: [`webconsole/README.md`](../webconsole/README.md).
Beispielprogramme: [Lab 03](../examples/lab03_webkonsole/README.md) nutzt alle Bedienelemente von
Versuch 1, [Lab 04](../examples/lab04_pendeldisplay/README.md) das Pendeldisplay von Versuch 2.

---

## 1. Architektur

Drei Schichten in einem Container:

```
┌──────────────────────────── Docker-Container ──────────────────────────────────────────────┐
│                                                                                             │
│  Node.js / Express  (Entrypoint: node server.js)                                            │
│  ├─ HTTP :3000   statische React-SPA, POST /upload, GET /api/experiments, /api/status       │
│  ├─ RenodeManager      startet/beendet Renode als Child-Prozess (cwd = sim/)                │
│  ├─ UartBridge   :3333 WebSocket  ⇄  TCP 127.0.0.1:3335  (Renode-Socket-Terminal, UART0)    │
│  └─ ControlBridge:3334 WebSocket  ⇄  TCP 127.0.0.1:1234  (Renode-Monitor, Telnet)           │
│                                   ⇠  WS  127.0.0.1:9000  (LED-Bridge, sim/models)           │
│                                                                                             │
│  Renode 1.17.0 (headless):  renode --disable-gui --port 1234                                │
│                             -e "$elf=@/tmp/app.elf; s @experiments/<versuch>.resc"          │
│  └─ sim/tm4c1294.resc + sim/platforms/tm4c1294ncpdt.repl + sim/experiments/<versuch>.repl   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
         ▲ :3000 HTTP            ▲ :3333 UART-WS              ▲ :3334 Control-WS
         └────────────────────── Browser (React, xterm.js, Canvas) ─────────────────────────────┘
```

**Warum Brücken und kein direkter WebSocket zu Renode?** Renode stellt UART, Monitor und GPIO
nicht als WebSocket bereit, sondern als TCP-Socket. Das sind `CreateServerSocketTerminal` und der
Telnet-Monitor (`--port`). Die Ausnahme ist die LED-Bridge aus `sim/models/WebSocketBridge.cs`.
Das Backend übersetzt deshalb zwischen beiden Welten. Das hat zwei Vorteile:

- Die internen Ports (1234, 3335, 9000) bleiben im Container. Exponiert sind nur 3000, 3333 und 3334.
- Der Browser kann **keine beliebigen Monitor-Befehle** senden. Er schickt nur Ereignisse wie
  „Taster SW1 gedrückt“. Das Backend baut daraus Befehle, und zwar ausschließlich mit Renode-Pfaden
  aus der Versuchs-Konfiguration. Ein Monitor-Zugang wäre sonst ein Zugang zum Container,
  denn Renode kann Python und C# ausführen.

### Ablauf beim Klick auf „Start“

1. Der Browser sendet `POST /upload` (`multipart/form-data`: `experiment_id`, `file`).
2. Das Backend prüft die Versuchs-ID (Datei `sim/experiments/<id>.resc` muss existieren) und die
   ELF-Signatur (`0x7F 'E' 'L' 'F'`).
3. Die Browser-WebSockets werden mit Code `4000` geschlossen. Das Frontend verbindet sich danach
   sofort neu.
4. Eine laufende Renode-Instanz wird beendet: SIGTERM an die Prozessgruppe, nach 4 s SIGKILL,
   danach zusätzlich `pkill -x renode` für verwaiste Prozesse.
5. Die Datei wird nach `/tmp/app.elf` verschoben, und Renode wird gestartet.
6. Das Backend wartet, bis das UART-Terminal (Port 3335) und der Monitor (Port 1234) erreichbar
   sind. Beide entstehen erst, wenn das `.resc`-Skript gelaufen ist.
7. Antwort **HTTP 200** mit der Versuchs-Konfiguration. Das Frontend baut das Bedienfeld auf.

Schlägt der Start fehl (z. B. Fehler im `.resc`), antwortet das Backend mit HTTP 500. Die letzten
Zeilen des Renode-Logs stehen dann in `log` und werden im Browser aufklappbar angezeigt.

### Woher die Anzeigen kommen

| Anzeige | Quelle | Verfahren |
|---|---|---|
| LEDs D1–D4 | `wsBridge` (`sim/models/WebSocketBridge.cs`, ws://127.0.0.1:9000) | **Push**: jede Pegeländerung (`LED<n>=<0|1>`) |
| UART0 | `CreateServerSocketTerminal 3335` | Bytestrom, unverändert durchgereicht |
| OLED | `sysbus.i2c0.oled GetFrameIfChanged` | **Polling** alle 100 ms, nur bei Änderung übertragen |
| LEDs mit `path` (andere Versuche) | `<path> State` | Polling alle 100 ms |

Befehle aus dem Browser haben Vorrang vor dem Polling: Die Monitor-Warteschlange wird vorne
eingereiht.

---

## 2. Simulierte Hardware von Versuch 1

Basis ist die Plattform `sim/platforms/tm4c1294ncpdt.repl` (Cortex-M4F, SYSCTL, GPIO A–Q, Timer,
**UART 0–7, I2C 0–9**). Darauf setzt `sim/experiments/versuch1.repl` auf.

| Baustein | Pins / Adresse | Modell | Bedienung im Browser |
|---|---|---|---|
| LEDs D1, D2, D3, D4 | PN1, PN0, PF4, PF0 | `TivaGPIOPort` → `wsBridge` | Anzeige |
| Taster USR_SW1, USR_SW2 | PJ0, PJ1 (gedrückt = LOW, Pull-up nötig) | `TivaGPIOPort` (Eingang) | Knopf: gedrückt halten = LOW |
| UART0 | PA0 RX, PA1 TX | `TivaUART` | Terminal (xterm.js), Eingaben gehen an RX |
| I2C0 | PB2 SCL, PB3 SDA | `TivaI2C` (Master) | – |
| OLED SSD1306 128×64 | I2C0, 0x3C | `SSD1306I2C` | Canvas, 4-fach vergrößert |
| Ultraschall MB1242 | I2C0, 0x70 | `MaxBotixI2C` | Schieberegler 0–400 cm |
| Keypad 4×3 | Zeilen PK0–PK3 (Ausgang), Spalten PK4–PK6 (Eingang, Pull-down) | `KeypadMatrix` | Tastenfeld |

### Die neuen Modelle (`sim/models/`)

| Datei | Kurzbeschreibung |
|---|---|
| `TivaUART.cs` | PL011-ähnlicher UART des TM4C129. DR, FR, IBRD/FBRD/LCRH, CTL, IFLS, IM/RIS/MIS/ICR, ID-Register. Empfangs-FIFO 16 Byte mit Overrun. RX-, RT-, TX- und OE-Interrupt. Clock-Gating `RCGCUART`. Senden ist sofort fertig (keine Baudraten-Zeit). |
| `TivaI2C.cs` | I2C-Master: MSA, MCS, MDR, MTPR, MIMR/MRIS/MMIS/MICR, MCR, MBMON. START/RUN/STOP/ACK, Repeated Start, Adress-NACK als `ERROR`+`ADRACK`, Master-Interrupt, Clock-Gating `RCGCI2C`. Damit Warteschleifen der Form „erst BUSY abwarten, dann nicht-BUSY“ nicht hängen, liefert der erste Lesezugriff auf MCS nach einem Befehl `BUSY=1`. |
| `SSD1306I2C.cs` | OLED-Controller: Control-Byte (Co/DC), Page-, Horizontal- und Vertical-Addressing, Spalten- und Page-Bereich, Display an/aus, Invertieren, Segment-Remap (A0/A1), COM-Scanrichtung (C0/C8). `GetFrame`/`GetFrameIfChanged` liefern das sichtbare Bild als Base64. |
| `MaxBotixI2C.cs` | Ultraschallsensor MB1242: `0x51` schreiben startet die Messung, 2 Bytes lesen liefern cm. Property `Distance` (0–765). |
| `PendulumDisplay.cs` | Pendeldisplay (Versuch 2): 8 LED-Eingänge, Sync-Ausgang (HIGH = rechts), Bewegung `sin(2·π·t/T)` in virtueller Zeit, Periode zur Laufzeit über `PeriodUs` einstellbar (0,05–100 Hz), Nachleuchtbild je Schwungrichtung. `GetFrame` liefert `PD:<Spalten>:<Periode in µs>:<Phase>:<LEDs>:<Base64>`. |
| `KeypadMatrix.cs` | Tastenmatrix mit echter Multiplex-Elektrik: Spalte = ODER über (Zeile HIGH UND Taste gedrückt). Zeilen-Scan und Interrupt-Betrieb funktionieren wie auf Hardware. `SetKey <zeile> <spalte> <true|false>`. |

**Keypad-Multiplexing.** Ein Klick auf „5“ sendet nicht „Taste 5“. Das Frontend schlägt die
Taste in seiner Matrix-Zuordnung nach und sendet die Koordinate (Zeile 1, Spalte 1). Das Modell
verbindet dann die Zeilenleitung PK1 elektrisch mit der Spaltenleitung PK5. Die Spalte wird
erst HIGH, wenn die Firmware die Zeile HIGH treibt. Die Firmware muss die Taste also wie auf
echter Hardware per Zeilen-Scan ermitteln. Ein Programm, das die Spalten liest, ohne die Zeilen
zu treiben, sieht keinen Tastendruck. Das ist didaktisch gewollt.

### Versuch 2: Pendeldisplay

`sim/experiments/versuch2.repl` ergänzt die Basisplattform um ein Pendeldisplay und den
Ultraschallsensor. LEDs D1–D4, Taster und UART0 sind dieselben wie in Versuch 1.

| Baustein | Pins / Adresse | Modell | Bedienung im Browser |
|---|---|---|---|
| Pendeldisplay, 8 LEDs | PM0–PM7 (Ausgang); stehendes Pendel, Drehpunkt unten, PM0 oben an der Spitze | `PendulumDisplay` | schwingender Stab (dunkelgrau) mit LEDs, Nachleuchtbild als Kreisbogen |
| Pendel-Signal | PL0 (Eingang): HIGH = rechts, LOW = links | `PendulumDisplay.Sync` | – |
| Ultraschall MB1242 | I2C0, 0x70 | `MaxBotixI2C` | Schieberegler 0–400 cm |

`PendulumDisplay.cs` bildet ein Pendel nach, das mit `x(t) = sin(2·π·t/T)` schwingt
(T = `periodUs`, Standard 100 000 µs = 10 Hz). Der Ausgang `Sync` ist HIGH, solange `x > 0` ist,
also steigende Flanke beim Durchgang nach rechts, fallende beim Durchgang nach links. Alle Zeiten
sind **virtuelle** Simulationszeit.

**Frequenz einstellen:** Im Browser gibt es dafür einen Schieberegler (Bereich aus
`minFrequency`/`maxFrequency` der Versuchs-JSON, in Versuch 2: 0,1–20 Hz). Das Backend setzt die
Property `PeriodUs` des Modells (0,05–100 Hz). Die neue Periode gilt ab dem nächsten Durchgang durch
die Mitte. Dort ist die Auslenkung bei jeder Frequenz null, das Pendel läuft also ohne Sprung
weiter. Intern rechnet das Modell deshalb in Phasen (Anzahl halber Schwingungen), nicht in Zeit.

Bei jedem Pegelwechsel einer LED überträgt das Modell den bisherigen LED-Zustand auf die
Winkelstücke, die das Pendel seitdem überstrichen hat. Der Schwenkbereich ist dabei in `columns`
(Standard 120) gleich breite Stücke von `x = −1` bis `x = +1` geteilt. Es gibt ein Bild pro
Schwungrichtung, jeweils vom letzten Schwung. Das Frontend zeigt beide überlagert (wie das Auge)
oder einzeln. So sieht man sofort, ob Hin- und Rückschwung übereinanderpassen.

Damit die Zeitpunkte der LED-Wechsel genau genug sind, stellt `versuch2.resc` die Zeitscheibe von
Renode auf 10 µs (`emulation SetGlobalQuantum "0.00001"`, Standard 100 µs).

### Monitor-Befehle (zum Ausprobieren ohne Browser)

Renode lässt sich auch direkt starten: `cd sim`, dann
`renode --console -e "\$elf=@../examples/lab03_webkonsole/lab03_webkonsole.out; s @experiments/versuch1.resc"`.
Danach `nc localhost 3335` für den UART. Im Monitor:

```
sysbus.gpioJ OnGPIO 0 false            # USR_SW1 drücken (LOW)
sysbus.gpioJ OnGPIO 0 true             # loslassen
sysbus.gpioK.keypad SetKey 1 1 true    # Keypad: Zeile 1, Spalte 1 ("5") drücken
sysbus.gpioK.keypad SetKey 1 1 false
sysbus.i2c0.sensor Distance 42         # Abstand 42 cm
sysbus.i2c0.oled GetFrame              # Framebuffer als Base64

# Versuch 2 (s @experiments/versuch2.resc):
sysbus.gpioM.pendel SyncLevel          # aktueller Pegel an PL0 (True = Pendel rechts)
sysbus.gpioM.pendel Leds               # aktueller LED-Zustand (Bit n = LED n)
sysbus.gpioM.pendel PeriodUs 80000     # Pendel auf 12,5 Hz (ab dem nächsten Nulldurchgang)
sysbus.gpioM.pendel GetFrame           # "PD:<Spalten>:<Periode in us>:<Phase>:<LEDs>:<Base64>"
```

---

## 3. Protokolle

### HTTP

| Methode, Pfad | Beschreibung |
|---|---|
| `GET /api/experiments` | Liste der Versuche `[{ id, title }]` (alle `sim/experiments/*.resc`) |
| `GET /api/status` | `{ running, experiment }` – stellt nach einem Neuladen der Seite das Bedienfeld wieder her |
| `POST /upload` | `multipart/form-data`: `experiment_id`, `file` (`.out`/`.elf`/`.axf`, max. 16 MB). Antwort 200 `{ status: "running", experiment }`, sonst 400/500 `{ error, log? }` |
| `POST /api/stop` | Simulation beenden |

### UART-WebSocket (`ws://<host>:3333`)

Binärframes in beide Richtungen, Bytes unverändert. Neue Clients bekommen die letzten 16 KB der
Ausgabe. Beim Neustart von Renode schließt der Server mit Code **4000**: Das Terminal wird
geleert, und das Frontend verbindet sich sofort neu.

### Control-WebSocket (`ws://<host>:3334`)

JSON-Nachrichten.

Browser → Server:

```jsonc
{ "type": "button", "id": "SW1", "pressed": true }          // id aus der Versuchs-JSON
{ "type": "keypad", "row": 1, "col": 1, "pressed": true }   // Matrix-Koordinate, nicht die Taste
{ "type": "sensor", "value": 120 }                          // cm, wird auf min..max begrenzt
{ "type": "pendulum", "frequency": 12.5 }                   // Hz, auf minFrequency..maxFrequency begrenzt
```

Server → Browser:

```jsonc
{ "type": "hello", "experiment": {…}, "renode": "running", "leds": {"D1": false, …}, "fb": {…}, "pd": {…} }
{ "type": "leds", "states": { "D1": true, "D2": false, … } }
{ "type": "fb", "width": 128, "height": 64, "on": true, "invert": false, "data": "<Base64>" }
{ "type": "pd", "columns": 120, "periodUs": 100000, "phase": 4210, "leds": 62, "data": "<Base64>" }
{ "type": "renode", "state": "stopped" }
{ "type": "error", "message": "…" }
```

`fb.data` ist der Framebuffer im SSD1306-Page-Format, wie er auf dem Display zu sehen ist:
Byte-Index = `page * width + x`, Bit `y % 8` (Bit 0 oben).

`pd.data` ist das Pendelbild: erst `columns` Bytes für den Schwung links → rechts, dann
`columns` Bytes für rechts → links. Byte `c` gehört zum Winkelstück `c` (0 = ganz links),
Bit `n` = LED `n` (Bit 0 oben an der Pendelspitze). `pd.phase` ist die Lage des Pendels in
1/10000 einer halben Schwingung (0 = Mitte nach rechts, 5000 = ganz rechts, 10000 = Mitte nach
links, 15000 = ganz links), `pd.leds` der LED-Zustand im Moment der Abfrage. Das Frontend zeichnet
daraus den schwingenden Stab und schreibt die Phase zwischen zwei Frames (10/s) fort.
Das Backend fragt das Pendel deshalb mit `GetFrame` ab, nicht mit `GetFrameIfChanged`.

### Reconnect

Alle WebSockets im Frontend nutzen `useReconnectingWebSocket`. Bricht eine Verbindung ab,
verbindet der Hook mit wachsendem Abstand neu (300 ms bis 5 s, mit Zufallsanteil). Bei Code 4000
(gewollter Neustart), beim Wechsel zurück auf den Tab und bei wiederhergestellter
Netzverbindung verbindet er sofort.

---

## 4. Eigenen Versuch anlegen

Ein Versuch besteht aus bis zu drei Dateien in `sim/experiments/`. Er erscheint automatisch in
der Auswahlliste.

| Datei | Pflicht | Inhalt |
|---|---|---|
| `<id>.resc` | ja | Startskript. Muss `$elf` verwenden und UART-Terminal Port 3335 anlegen. |
| `<id>.repl` | nein | Erweiterung der Basisplattform (zusätzliche Geräte, Verdrahtung) |
| `<id>.json` | nein | Bedienelemente der Web-Konsole |

`<id>`: Buchstaben, Ziffern, `_`, `-` (max. 64 Zeichen).

**Minimales `.resc`** (Vorlage: `versuch1.resc`):

```
$elf?=@/tmp/app.elf
include @models/MeinModell.cs                       # nur falls eigene Modelle nötig
include @tm4c1294.resc                              # Basis: Modelle, Maschine, Plattform, LoadELF
machine LoadPlatformDescription @experiments/<id>.repl
emulation CreateServerSocketTerminal 3335 "uart0term" false
connector Connect sysbus.uart0 uart0term
start
```

Alle Pfade sind relativ zu `sim/`, denn Renode läuft mit diesem Arbeitsverzeichnis.

**`<id>.json`** (alle Abschnitte optional):

```jsonc
{
  "title": "Anzeigename im Dropdown",
  "machine": "tm4c1294",                       // Maschinenname aus tm4c1294.resc
  "uart":   { "label": "UART0 – 115200 8N1" },
  "ledBridge": "ws://127.0.0.1:9000",          // LED-Bridge aus der Basisplattform
  "leds": [
    { "id": "D1", "label": "D1 (PN1)", "color": "#22c55e", "bridge": 0 },   // Eingang 0 von wsBridge
    { "id": "X",  "label": "LED X", "path": "sysbus.gpioA.ledX" }            // oder: Renode-LED, Polling
  ],
  "buttons": [
    { "id": "SW1", "label": "USR_SW1 (PJ0)", "port": "sysbus.gpioJ", "pin": 0, "activeLow": true },
    { "id": "B",   "label": "Button", "path": "sysbus.gpioA.btn" }          // oder: Miscellaneous.Button
  ],
  "oled":   { "path": "sysbus.i2c0.oled", "width": 128, "height": 64, "label": "…" },
  "sensor": { "path": "sysbus.i2c0.sensor", "min": 0, "max": 400, "unit": "cm", "label": "…" },
  "pendulum": { "path": "sysbus.gpioM.pendel", "label": "…",                    // PendulumDisplay
                "frequency": 10, "minFrequency": 0.1, "maxFrequency": 20 },    // Hz, Schieberegler
  "keypad": {
    "path": "sysbus.gpioK.keypad",
    "rowPins": ["PK0", "PK1", "PK2", "PK3"], "colPins": ["PK4", "PK5", "PK6"],
    "layout": [["1","2","3"], ["4","5","6"], ["7","8","9"], ["*","0","#"]]
  }
}
```

Das Backend prüft beim Laden alle Renode-Pfade (`sysbus.<name>.<name>…`). Ungültige Versuche
werden nicht angezeigt, und der Grund steht im Server-Log. Renode-Pfade, Ports und Pins werden
nie an den Browser geschickt.

---

## 5. Betrieb

### Docker

```bash
cd webconsole
docker compose up --build            # -> http://localhost:3000
```

oder ohne Compose (Build-Kontext ist das Repository):

```bash
docker build -f webconsole/Dockerfile -t renode4mc-webconsole .
docker run --rm --init -p 3000:3000 -p 3333:3333 -p 3334:3334 renode4mc-webconsole
```

Das Image installiert Renode **1.17.0 portable**, dieselbe Version wie in
[INSTALL_LINUX.md](INSTALL_LINUX.md), für amd64 und arm64. Es läuft als Benutzer `node` ohne
Root-Rechte.

**`/tmp` muss ausführbar sein.** Renode entpackt beim Start seine CPU-Bibliothek nach `/tmp` und
lädt sie von dort. Wer `/tmp` als tmpfs einhängt (wie die `docker-compose.yml`), braucht die Option
`exec`, also `--tmpfs /tmp:exec,mode=1777`. Docker hängt tmpfs sonst mit `noexec` ein, und Renode
bricht beim Laden der Plattform mit `failed to map segment from shared object` ab.

**Mehrere Studierende:** Ein Container simuliert genau **eine** Instanz. Ein neuer Upload beendet
die laufende Simulation. Für einen Kurs startet man deshalb einen Container pro Person bzw.
Arbeitsplatz, z. B. mit verschiedenen Host-Ports (`-p 3100:3000 -p 3433:3333 -p 3434:3334`). Das
Frontend verbindet die WebSockets dann mit `VITE_UART_WS_URL`/`VITE_CONTROL_WS_URL` (zur
Build-Zeit), sonst mit Port 3333/3334 auf demselben Host.

### Ohne Docker (Entwicklung)

Voraussetzungen: Node.js ≥ 18 und Renode (siehe [INSTALL_LINUX.md](INSTALL_LINUX.md), Schritt 6).

```bash
cd webconsole/frontend && npm install && npm run build      # oder: npm run dev (Port 5173)
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start
```

### Umgebungsvariablen (Backend)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3000 | HTTP |
| `UART_WS_PORT` / `CONTROL_WS_PORT` | 3333 / 3334 | WebSocket-Ports |
| `RENODE_BIN` | `renode` | Renode-Startprogramm |
| `RENODE_HEADLESS_FLAG` | `--disable-gui` | in Renode 1.17 gleichbedeutend mit `--disable-xwt` |
| `RENODE_MONITOR_PORT` / `RENODE_UART_PORT` | 1234 / 3335 | interne Renode-Ports (3335 muss zum `.resc` passen) |
| `RENODE_START_TIMEOUT_MS` | 60000 | Wartezeit auf Renode beim Start |
| `SIM_DIR` | `<repo>/sim` | Simulator-Verzeichnis (Arbeitsverzeichnis von Renode) |
| `EXPERIMENTS_SUBDIR` | `experiments` | Versuche relativ zu `SIM_DIR` |
| `ELF_PATH` | `/tmp/app.elf` | Ablageort der hochgeladenen Firmware |
| `PUBLIC_DIR` | `backend/public` | gebautes Frontend |
| `POLL_INTERVAL_MS` | 100 | OLED-/LED-Polling |

**Hinweis Port 3333:** `ucsim --debug` nutzt 3333 lokal für den GDB-Server. Im Container gibt es
keinen GDB-Server. Laufen `ucsim --debug` und die Web-Konsole gleichzeitig auf einem Rechner,
mappen Sie die Web-Konsole auf andere Host-Ports.

---

## 6. Test

`webconsole/backend/test/e2e.js` prüft die ganze Kette mit echter Renode-Instanz und der
Lab-03-Firmware: Upload, UART-Ausgabe und -Echo, Sensor → UART und LED D1, Keypad „5“ per Matrix,
USR_SW1 → LED D3, OLED-Frame.

```bash
cd webconsole/backend
npm start &                                                       # oder Container
node test/e2e.js ../../examples/lab03_webkonsole/lab03_webkonsole.out
node test/e2e_versuch2.js ../../examples/lab04_pendeldisplay/lab04_pendeldisplay.out
```

`test/e2e_versuch2.js` prüft Versuch 2 mit der Lab-04-Firmware: Startmeldung, gemessene
Pendelperiode (100,0 ms), Sensor → UART und das Pendelbild. Für 42, 123 und 7 cm muss jede der
40 Bildspalten in **beiden** Schwungrichtungen an der richtigen Stelle das richtige Muster zeigen.
Danach wird die Pendelfrequenz auf 15, 4, 25 und 10 Hz gestellt: Das Modell muss sie übernehmen,
die Firmware muss die neue Periode melden, und das Bild muss weiter spaltengenau stimmen.

## 7. Bekannte Einschränkungen

- **Eine Simulation pro Container**, keine Benutzerverwaltung, keine Authentifizierung. Für den
  Betrieb im Netz gehört der Container hinter einen Reverse-Proxy mit Anmeldung.
- **Timing:** Renode ist nicht zyklengenau (siehe [ROADMAP.md](ROADMAP.md)). UART und I2C senden
  ohne Baudraten- bzw. Busverzögerung. Die Ultraschall-Messung ist sofort fertig.
- **OLED:** Scrolling, Kontrast und Display-Offset (`D3`) sind nicht modelliert. Die Anzeige wird
  mit 10 Bildern/s aktualisiert.
- **Pendeldisplay:** ideale Sinusschwingung mit fester Amplitude, ohne Dämpfung; die Periode
  ändert sich nur, wenn man sie einstellt (sprunghaft am nächsten Nulldurchgang).
  LEDs leuchten ohne Nachglühen, die Anzeige zeigt je Richtung nur den letzten Schwung.
- **Taster ohne Prellen;** Entprell-Code lässt sich im Simulator nicht prüfen.
- **I2C:** nur Master-Betrieb, kein FIFO/µDMA/Burst. Empfangene Bytes werden einzeln vom Gerät
  gelesen.
- Getestet mit Renode 1.17.0 (portable, Linux x64), Chromium und Node.js 22: `test/e2e.js`,
  `test/e2e_versuch2.js` und die
  Bedienung im Browser, auch mit dem Verzeichnis-Layout des Images (`/opt/renode`,
  `SIM_DIR=/opt/renode4mc/sim`, Benutzer ohne Root-Rechte). Das Docker-Image selbst konnte in der
  Entwicklungsumgebung **nicht gebaut** werden (kein Zugriff auf Docker Hub) – beim ersten
  `docker compose up --build` bitte prüfen.
