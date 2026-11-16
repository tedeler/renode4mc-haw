# Anleitung: renode4mc-haw installieren, betreiben und um Versuche erweitern

Diese Anleitung führt Schritt für Schritt durch die drei häufigsten Aufgaben:

1. [Installieren](#1-installieren): die Web-Konsole mit Docker, oder alles lokal
2. [Betreiben](#2-betreiben): Firmware bauen, in der Web-Konsole simulieren, Probleme lösen
3. [Neuen Versuch hinzufügen](#3-neuen-versuch-hinzufügen): eigene Bedienelemente und Pins für ein Praktikum

Die Details stehen in den Fachdokumenten, auf die jeweils verwiesen wird:
[INSTALL_LINUX.md](INSTALL_LINUX.md) (CCS, Renode, Board), [WEBCONSOLE.md](WEBCONSOLE.md)
(Architektur, Protokolle, Betrieb), [EXPERIMENTS.md](EXPERIMENTS.md) (Format der Versuchsdateien),
[LABORE.md](LABORE.md) (Lab 1–4).

---

## Überblick: Was brauche ich wofür?

| Ich möchte … | Ich brauche | Abschnitt |
|---|---|---|
| ein fertiges Programm (`.out`) im Browser simulieren | nur **Docker** | [1.1](#11-web-konsole-mit-docker-empfohlen) |
| Programme schreiben und bauen | **Code Composer Studio (CCS)** oder `make` mit TI Arm Clang | [1.3](#13-programme-bauen-und-aufs-board-laden-ccs) |
| auf dem echten Board testen | CCS bzw. OpenOCD, udev-Regel, EK-TM4C1294XL | [1.3](#13-programme-bauen-und-aufs-board-laden-ccs) |
| an der Web-Konsole selbst entwickeln | Node.js ≥ 18 und Renode 1.17.0 | [1.2](#12-web-konsole-ohne-docker-für-die-entwicklung) |

```
 CCS / make ──▶ programm.out ──┬─▶ Board (USB, Port DEBUG)
                               ├─▶ ucsim  ──▶ Renode ──▶ LED-Seite im Browser       (einfacher Simulator)
                               └─▶ Upload ──▶ Web-Konsole (Docker: Renode + Bedienfeld im Browser)
```

---

## 1. Installieren

### 1.1 Web-Konsole mit Docker (empfohlen)

Im Container stecken Renode, die Simulationsmodelle aus `sim/`, die Oberfläche und die gebauten
Musterlösungen. Einen Compiler brauchen Sie dafür nicht.

**Schritt 1 – Docker installieren.**
Linux: Docker Engine mit dem Compose-Plugin (<https://docs.docker.com/engine/install/>), danach
den eigenen Benutzer in die Gruppe `docker` aufnehmen (`sudo usermod -aG docker $USER`, neu anmelden).
Windows/macOS: Docker Desktop. Kontrolle:

```bash
docker compose version          # muss eine Versionsnummer ausgeben
```

**Schritt 2 – Repository holen.**

```bash
mkdir -p ~/praktikum && cd ~/praktikum
git clone https://github.com/tedeler/renode4mc-haw.git
cd renode4mc-haw
```

**Schritt 3 – Container bauen und starten.**

```bash
cd webconsole
docker compose up --build
```

Der erste Bau dauert einige Minuten: Er lädt das Node-Image und Renode und baut Oberfläche und
Musterlösungen. Danach übersetzt das Backend einmalig die C#-Modelle (ca. 10 s, im Log steht
„bereit: … Modelle übersetzt“). Ab dann startet jeder Versuch in unter einer Sekunde.

**Schritt 4 – Browser öffnen:** <http://localhost:3000>. Es erscheint die Kopfzeile mit der
Versuchsauswahl. Weiter mit [2.2](#22-die-web-konsole-bedienen).

**Beenden:** `Strg+C` im Terminal bzw. `docker compose down`.
**Im Hintergrund laufen lassen:** `docker compose up --build -d`, Log mit `docker compose logs -f`.
**Aktualisieren:**

```bash
cd ~/praktikum/renode4mc-haw && git pull
cd webconsole && docker compose up --build
```

Optional zeigt der Über-Dialog (Klick auf das Logo oben links) den Git-Stand an, wenn Sie ihn beim
Bauen mitgeben:

```bash
GIT_COMMIT=$(git rev-parse HEAD) GIT_DATE=$(git log -1 --format=%cI) docker compose up --build
```

### 1.2 Web-Konsole ohne Docker (für die Entwicklung)

Voraussetzungen: Node.js ≥ 18 und Renode 1.17.0 unter `~/renode`
([INSTALL_LINUX.md](INSTALL_LINUX.md), Schritt 6).

```bash
cd ~/praktikum/renode4mc-haw/webconsole/frontend && npm install && npm run build
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start      # -> http://localhost:3000
```

Für die Musterlösungen (Knopf „Musterlösung“) braucht es zusätzlich `arm-none-eabi-gcc`
(Debian/Ubuntu: `sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi`), dann einmal
`tools/build-solutions.sh` im Repository aufrufen. Ohne sie bleibt der Knopf ausgegraut.

Mit `npm run dev` im Frontend läuft Vite mit Hot-Reload auf Port 5173 und leitet `/upload` und
`/api` an das Backend weiter. Alle Umgebungsvariablen: [WEBCONSOLE.md, Abschnitt 5](WEBCONSOLE.md#5-betrieb).

### 1.3 Programme bauen und aufs Board laden (CCS)

Code Composer Studio, TI Arm Clang, die udev-Regel für das Board, Renode und das Startskript
`ucsim` richtet [INSTALL_LINUX.md](INSTALL_LINUX.md) Schritt für Schritt ein (ca. 1 h). Die
Beispiele brauchen **keine TivaWare**: Sie greifen über die TI-Headerdatei
`common/tm4c1294ncpdt.h` direkt auf die Register zu.

Kurzprobe, wenn alles installiert ist:

```bash
cd ~/praktikum/renode4mc-haw/examples/example01_blinky
make                              # baut example01_blinky.out mit tiarmclang aus CCS
ucsim example01_blinky.out        # einfacher Simulator: D1/D2 blinken im Browser
```

---

## 2. Betreiben

### 2.1 Firmware bauen

Die Web-Konsole nimmt jede ELF-Datei für den TM4C1294 an:

- **CCS:** Projekt bauen, die Datei liegt in `Debug/<projekt>.out`.
- **make:** `make` im Ordner des Beispiels erzeugt `<beispiel>.out`.
- **gcc:** möglich, siehe `tools/build-solutions.sh` (Startdatei `common/startup_tm4c1294.c`,
  Linker-Skript `tools/gcc/link.ld`, `tools/gcc/crt.c`).

Dieselbe Datei läuft im Simulator und auf dem Board.

### 2.2 Die Web-Konsole bedienen

1. **Versuch wählen.** Die Bedienelemente erscheinen sofort als Vorschau („Vorschau · keine
   Firmware“). Regler, Oszilloskop-Kanäle und Terminal-Einstellung lassen sich schon einstellen.
2. **Firmware wählen:** die `.out`-Datei.
3. **Start.** Das Bedienfeld verbindet sich mit der Simulation; Ausgaben von UART0 erscheinen im
   Terminal. Erneutes Klicken („Neu starten“) lädt die Firmware neu.
4. **Musterlösung** (nur bei Versuchen mit Musterlösung): startet statt der eigenen Datei das fertige
   Programm. So sehen Sie, wie sich die Lösung verhalten soll.
5. **Stop** beendet die Simulation; der Versuch bleibt als Vorschau stehen.

In der Kopfzeile außerdem:

| Element | Wirkung |
|---|---|
| **Reset** | wie der Reset-Taster des Boards: die MCU startet neu, Firmware und Geräte außerhalb des Chips bleiben |
| **Simulation** | blendet das Simulations-Panel ein: CPU-Zustand, Simulationszeit und Tempo, Debugger (Pause, Einzelschritt, Weiter), CPU-Register mit Disassembly, Speicher, Peripherie-Register, Renode-Meldungen |
| **〰 Oszi** | Oszilloskop mit 4 Kanälen für die Pins des Versuchs (Trigger, Zeitbasis) |
| **↺ Standardlayout** | ordnet die Panels wieder an; Panels lassen sich sonst einklappen, an der Kopfzeile verschieben und in der Breite ziehen (gespeichert je Versuch im Browser) |

Unter dem Terminal stellen Sie Baudrate und Format des „PC-Terminals“ ein. Passt die Einstellung nicht
zur Firmware, kommen wie auf echter Hardware falsche oder gar keine Zeichen an, und das
Diagnose-Panel nennt den Grund.

**Diagnose:** Fehlkonfigurationen (Zugriff ohne Takt, Pin nicht auf die Funktion geschaltet,
falsche Baudrate, Fault-Handler …) erscheinen oben im Diagnose-Panel. Auf dem Board würde das
Programm in diesen Fällen einfach nicht funktionieren, im Simulator steht dabei, warum.

### 2.3 Die mitgelieferten Versuche

| Versuch (Auswahlliste) | Datei `sim/experiments/` | passende Firmware |
|---|---|---|
| Simple Elemente | `example1.json` | LEDs D1–D4, USR_SW1/2 (mit Pull-up auf der Platine), UART0, HC-SR04 an PD0/PD1 – für eigene Übungen, z. B. `example01_blinky`, `example02_timer_blink` |
| Example 2 – Pendeldisplay | `example2.json` | `examples/example04_pendeldisplay` |
| Example 3 – Timer: PWM, Puls, Capture | `example3.json` | `examples/example05_timer_ccp` (auch als Musterlösung) |
| Lab 1 – GPIO: Hex-Keypad und BCD-Anzeige | `lab1_gpio.json` | Musterlösung `lab01_hexkeypad_bcd` |
| Lab 2 – LED-Pendel mit HC-SR04 | `lab2_pendel.json` | Musterlösung `lab02_led_pendel` |
| Lab 3 – NVIC | `lab3_nvic.json` | Musterlösung `lab03_nvic_pendel` |
| Lab 4 – UART | `lab4_uart.json` | Musterlösung `lab04_uart_leds` (Terminal 9600 7N1) |

`examples/example03_webkonsole` braucht OLED, MB1242 und Keypad. Diese Kombination hat derzeit kein
mitgelieferter Versuch; wie Sie ihn anlegen, zeigt das Beispiel in [Abschnitt 3](#3-neuen-versuch-hinzufügen).

### 2.4 Mehrere Arbeitsplätze

Ein Container simuliert genau **eine** Instanz; ein neuer Start beendet die laufende Simulation.
Für einen Kurs startet man einen Container pro Person mit eigenen Host-Ports, z. B.

```bash
docker run -d --init --name platz1 --tmpfs /tmp:exec,mode=1777 \
  -p 3100:3000 -p 3433:3333 -p 3434:3334 renode4mc-webconsole:latest
```

Dabei muss das Frontend wissen, wo die WebSockets liegen (`VITE_UART_WS_URL`/`VITE_CONTROL_WS_URL`
beim Bauen, siehe [WEBCONSOLE.md, Abschnitt 5](WEBCONSOLE.md#5-betrieb)). Der Container hat keine
Anmeldung: Im Netz gehört er hinter einen Reverse-Proxy mit Authentifizierung.

### 2.5 Häufige Probleme

| Problem | Lösung |
|---|---|
| `failed to map segment from shared object` | `/tmp` im Container ist `noexec`. `docker compose` setzt `exec` bereits; bei `docker run` `--tmpfs /tmp:exec,mode=1777` angeben |
| Port 3000/3333/3334 belegt | anderes Programm (z. B. `ucsim --debug` nutzt 3333) beenden oder andere Host-Ports wählen |
| neuer Versuch erscheint nicht | Prüfwerkzeug laufen lassen (3.2), Seite neu laden; im Docker-Betrieb neu bauen oder Ordner einbinden (3.3) |
| Knopf „Musterlösung“ ausgegraut | Musterlösung nicht gebaut: `tools/build-solutions.sh` (lokal) bzw. Image neu bauen |
| Terminal zeigt Zeichensalat oder nichts | Terminal-Einstellung unter dem Terminal passt nicht zur Firmware (Diagnose-Panel lesen) |
| Tempo deutlich unter 1× | Firmware fragt ununterbrochen Register ab (Polling); jeder Zugriff kostet in Renode Rechenzeit. Die Simulationszeit bleibt trotzdem exakt |
| Lokale Tests: „Port belegt“ | übrig gebliebene Renode-Instanz: `pkill -9 -f renode` |

Weitere Probleme bei CCS und Board: [INSTALL_LINUX.md, „Häufige Probleme“](INSTALL_LINUX.md#häufige-probleme).

---

## 3. Neuen Versuch hinzufügen

Ein Versuch ist **eine JSON-Datei** in `sim/experiments/`. Sie zählt die Bedienelemente auf (LEDs,
Taster, Keypad, Anzeigen, Sensoren …) und legt fest, an welchen Pins sie hängen. Renode-Plattform
und Startskript erzeugt das Backend daraus selbst – Sie schreiben keinen Renode-Code und ändern
nichts am Frontend.

### 3.1 Datei anlegen

Dateiname = Versuchs-ID (Buchstaben, Ziffern, `_`, `-`), z. B. `sim/experiments/webkonsole.json`.
Am schnellsten kopieren Sie einen vorhandenen Versuch, der Ihrem am ähnlichsten ist.

Beispiel: der Versuch für `examples/example03_webkonsole` mit Board-LEDs, Tastern, UART-Terminal,
OLED und Ultraschallsensor an I2C0 sowie einem 4×3-Keypad an Port K:

```json
{
  "title": "Web-Konsole komplett: LEDs, Taster, UART, OLED, Ultraschall, Keypad",
  "description": "Für examples/example03_webkonsole",
  "uart": { "baud": 115200, "format": "8N1" },
  "elements": [
    { "type": "led", "id": "D1", "label": "D1 (PN1)", "pin": "PN1" },
    { "type": "led", "id": "D2", "label": "D2 (PN0)", "pin": "PN0" },
    { "type": "led", "id": "D3", "label": "D3 (PF4)", "pin": "PF4" },
    { "type": "led", "id": "D4", "label": "D4 (PF0)", "pin": "PF0" },
    { "type": "button", "id": "SW1", "label": "USR_SW1 (PJ0)", "pin": "PJ0" },
    { "type": "button", "id": "SW2", "label": "USR_SW2 (PJ1)", "pin": "PJ1" },
    { "type": "oled", "label": "SSD1306 an I2C0 (PB2/PB3), 0x3C", "address": "0x3C" },
    { "type": "mb1242", "label": "MB1242 an I2C0, 0x70", "address": "0x70", "min": 0, "max": 400, "unit": "cm" },
    { "type": "keypad",
      "pins": { "R0": "PK0", "R1": "PK1", "R2": "PK2", "R3": "PK3", "C0": "PK4", "C1": "PK5", "C2": "PK6" } }
  ]
}
```

Das Wichtigste zum Format (vollständig in [EXPERIMENTS.md](EXPERIMENTS.md)):

- **Pflicht** sind `title` und `elements`. Jedes Element hat `type`; Pins schreibt man wie im
  Datenblatt (`"PK0"`).
- **Elementtypen:** `led`, `button`, `bcd`, `hexkeypad`, `keypad`, `pendulum`, `hcsr04`, `mb1242`,
  `oled`, `cio` (printf-Konsole wie in CCS). Liste mit allen Feldern:
  `node tools/check_experiment.js --types`.
- **Immer vorhanden**, ohne Eintrag: UART-Terminal (Standard UART0 an PA0/PA1), Reset, Simulations-Panel,
  Debugger, Oszilloskop.
- **Optional:** `uart` (Pins, Baudrate, Format des Terminals), `scope` (Startbelegung des Oszilloskops),
  `quantumUs` (Zeitscheibe von Renode; 10 für genaue Zeitpunkte wie beim Pendel), `solution`
  (Musterlösung, siehe 3.5).
- Felder, die mit `_` beginnen, sind Kommentare (`"_pins": "LED0 ist oben"`).
- Taster: `activeLow` (Standard `true`) und `pull` (`"up"`/`"down"`) für einen Widerstand auf der
  Platine. Ohne `pull` muss die Firmware den internen Pull-up einschalten, sonst warnt die Diagnose –
  wie bei USR_SW1/2 auf dem echten Board.

### 3.2 Prüfen

```bash
cd ~/praktikum/renode4mc-haw
node tools/check_experiment.js webkonsole                 # ein Versuch (ID oder Pfad)
node tools/check_experiment.js                            # alle Versuche
node tools/check_experiment.js --repl --resc webkonsole   # zeigen, was für Renode erzeugt wird
```

Das Werkzeug prüft genau wie das Backend: Gibt es den Pin auf dem Chip, ist er doppelt oder fest
belegt (JTAG, UART-Pins, I2C0 an PB2/PB3), passen RX/TX zum selben UART, sind Felder falsch
geschrieben? Exit-Code 0 = gültig (Hinweise sind erlaubt), 1 = Fehler. Ein ungültiger Versuch
erscheint in der Web-Konsole nicht; der Grund steht im Server-Log.

### 3.3 In der Web-Konsole sichtbar machen

Die Liste wird bei jedem Laden der Seite neu eingelesen.

- **Ohne Docker** (1.2): Seite neu laden – fertig.
- **Docker, dauerhaft:** Das Image enthält eine Kopie von `sim/`. Neu bauen:
  `cd webconsole && docker compose up --build`.
- **Docker, zum Ausprobieren ohne Neubau:** den Ordner mit den Versuchen in den Container einbinden
  (im Repository-Wurzelverzeichnis aufrufen; das Image muss einmal gebaut sein):

  ```bash
  docker run --rm --init --tmpfs /tmp:exec,mode=1777 \
    -p 3000:3000 -p 3333:3333 -p 3334:3334 \
    -v "$PWD/sim/experiments:/opt/renode4mc/sim/experiments:ro" \
    renode4mc-webconsole:latest
  ```

  Danach genügt nach jeder Änderung an einer JSON-Datei das Neuladen der Seite.

### 3.4 Ausprobieren

Versuch wählen, prüfen, ob alle Bedienelemente in der Vorschau erscheinen, dann mit einer passenden
Firmware starten. Achten Sie auf das Diagnose-Panel: Meldungen wie „Zugriff ohne Takt“ oder „Pin nicht
als … geschaltet“ zeigen meist, dass Versuch und Firmware unterschiedliche Pins erwarten. Mit dem
Oszilloskop sehen Sie, ob an den Pins tatsächlich etwas passiert.

### 3.5 Musterlösung hinzufügen (optional)

1. Ordner `examples/<name>/` mit `main.c` (und weiteren `.c`-Dateien) anlegen. Für CCS und `make`
   die `.projectspec` und das `Makefile` eines vorhandenen Beispiels kopieren und umbenennen.
2. `<name>` in die Liste `SOLUTIONS` in `tools/build-solutions.sh` eintragen. Das Skript baut alle
   `.c`-Dateien des Ordners mit gcc nach `sim/solutions/<name>.elf`; das Docker-Image ruft es beim
   Bauen selbst auf.
3. In der Versuchsdatei:

   ```json
   "solution": { "example": "<name>", "label": "Musterlösung (Interrupt-Variante)" }
   ```

4. Lokal einmal `tools/build-solutions.sh` (bzw. `CC=/pfad/arm-none-eabi-gcc tools/build-solutions.sh`)
   ausführen, im Docker-Betrieb das Image neu bauen. `check_experiment.js` meldet einen Hinweis,
   solange die `.elf` fehlt.

### 3.6 Einchecken

```bash
git add sim/experiments/webkonsole.json            # ggf. examples/<name>/ und tools/build-solutions.sh
git commit -m "Versuch webkonsole: OLED, MB1242, Keypad"
git push
```

### 3.7 Wenn ein Gerätetyp fehlt

Ein neuer Typ (z. B. ein anderer Sensor) braucht ein C#-Modell in `sim/models/`, einen Eintrag im
Katalog `TYPES` in `webconsole/backend/lib/experimentSpec.js` und, falls er ein eigenes Widget hat,
Befehle in `lib/controlBridge.js` sowie eine Komponente im Frontend. Das beschreibt
[EXPERIMENTS.md, „Neuen Gerätetyp hinzufügen“](EXPERIMENTS.md#neuen-gerätetyp-hinzufügen).
