# renode4mc-haw – TM4C1294 programmieren und simulieren

Lehrmaterial für das Mikrocontroller-Praktikum an der HAW mit dem **EK-TM4C1294XL**
(TI Tiva C, ARM Cortex-M4F).

- **Programmieren wie von TI empfohlen:** Code Composer Studio (CCS) + TI Arm Clang. Die Beispiele
  nutzen **reinen Registerzugriff** (Datenblatt, keine driverlib).
- **Zusätzlich simulieren:** Dieselbe `.out`-Datei läuft ohne Board im Simulator
  ([Renode](https://renode.io)); die LEDs erscheinen in einer HTML-Seite im Browser.
- **Web-Konsole (Docker):** `.out`-Datei im Browser hochladen und die simulierte Hardware bedienen –
  LEDs, Taster, UART-Terminal, OLED-Display, Ultraschallsensor, Keypad
  ([docs/WEBCONSOLE.md](docs/WEBCONSOLE.md)).

```
 CCS-Projekt ──Build──▶ programm.out ──┬─▶ Debug/Run ──▶ Board (USB, DEBUG-Port)
                                       ├─▶ ucsim programm.out ──▶ Renode ──▶ Browser (LEDs)
                                       └─▶ Upload ──▶ Web-Konsole (Docker: Renode + Bedienfeld im Browser)
```

## Loslegen

1. [Installation unter Linux](docs/INSTALL_LINUX.md)
2. [Lab 01 – Blinky](examples/lab01_blinky/README.md) (GPIO, Clock-Gating, Warteschleife)
3. [Lab 02 – Timer-Blink](examples/lab02_timer_blink/README.md) (Timer, Interrupt, Vektortabelle)
4. [Lab 03 – Web-Konsole](examples/lab03_webkonsole/README.md) (UART, I2C mit OLED und Ultraschallsensor,
   Keypad-Multiplexing, Taster-Interrupts) – läuft in der [Web-Konsole](webconsole/README.md)
5. [Lab 04 – Pendeldisplay](examples/lab04_pendeldisplay/README.md) (POV-Anzeige mit Einmal-Timer,
   Synchronisation auf ein externes Signal, Ultraschallsensor, UART) – Web-Konsole, Versuch 2

Kurzform, wenn alles installiert ist:

```bash
cd examples/lab01_blinky && make && ucsim lab01_blinky.out
```

Web-Konsole (nur Docker nötig, Renode ist im Container):

```bash
cd webconsole && docker compose up --build      # dann http://localhost:3000
```

## Inhalt

| Pfad | Inhalt |
|---|---|
| `examples/lab01_blinky`, `examples/lab02_timer_blink`, `examples/lab03_webkonsole`, `examples/lab04_pendeldisplay` | Beispiele mit `main.c`, CCS-`.projectspec`, `Makefile`, README |
| `common/` | Startup-Code mit vollständiger Vektortabelle, Linker-Skript (Flash/SRAM des TM4C1294) – **identisch für Board und Simulator** |
| `sim/` | Simulator: `ucsim` (Startskript), Plattform `.repl`, C#-Modelle (SYSCTL, GPIO, Timer, UART, I2C, WebSocket-Brücke, OLED, Ultraschall, Keypad, Pendeldisplay), LED-Anzeige `visualizer/ek-tm4c1294xl.html`, Versuche für die Web-Konsole `experiments/` |
| `webconsole/` | Web-Konsole: Node.js-Backend, React-Frontend, `Dockerfile`, `docker-compose.yml` |
| `tools/ccs-import.sh` | CCS-Projekt ohne Oberfläche importieren und bauen |
| `tools/check_header.py` | Simulator-Hardware, Vektortabelle und Beispiele gegen `common/tm4c1294ncpdt.h` prüfen |
| `common/tm4c1294ncpdt.h` | Registernamen und Bitkonstanten von TI (wird von allen Beispielen eingebunden) |
| `docs/` | `INSTALL_LINUX.md`, `TOOLCHAIN.md` (Konzept, CCS-Debugging des Simulators), `ROADMAP.md` (weitere Peripherie), `WEBCONSOLE.md` (Web-Konsole: Architektur, Protokolle, eigene Versuche) |

## Simulierte Hardware

| Baustein | Stand |
|---|---|
| Cortex-M4F, NVIC, 1 MB Flash, 256 KB SRAM, Bit-Banding | ✔ |
| SYSCTL: Clock-Gating (`RCGC*`/`PR*`), Warnung bei fehlendem Takt | ✔ (PLL/Takt-Umschaltung nicht; Takt fest 16 MHz) |
| GPIO A–Q: Ausgänge, Eingänge, Pull-up/-down, Interrupts | ✔ |
| Timer 0–7 (GPTM): periodisch/One-Shot, 32/16 Bit, Interrupt | ✔ (Timer 4–7 ohne NVIC-Verdrahtung) |
| UART 0–7: Senden/Empfangen, 16-Byte-Empfangs-FIFO, Interrupts | ✔ (ohne Baudraten-Timing, kein µDMA) |
| I2C 0–9 als Master; Geräte SSD1306-OLED, MaxBotix MB1242 | ✔ (Versuch 1 der Web-Konsole) |
| Keypad 4×3 mit Matrix-Elektrik, Taster-Eingabe im Browser | ✔ (Web-Konsole) |
| Pendeldisplay (8 LEDs, 10 Hz, Sync-Signal), Nachleuchtbild im Browser | ✔ (Versuch 2 der Web-Konsole) |
| ADC, SysTick-Test | geplant (`docs/ROADMAP.md`) |

## Getestet / nicht getestet

- ✔ Beide Beispiele bauen mit `make` (tiarmclang) **und** headless in CCS 20.4
  (`tools/ccs-import.sh`); beide laufen im Simulator (LED-Takt gemessen); GDB-Haltepunkt in der
  Timer-ISR im Simulator funktioniert.
- ✔ Web-Konsole ohne Docker mit Renode 1.17.0: Lab 03 (mit `arm-none-eabi-gcc` und einer
  GCC-Startdatei gebaut) besteht `webconsole/backend/test/e2e.js` (Upload, UART, LEDs, Taster,
  Keypad, Sensor, OLED) und läuft im Browser (Chromium), auch nach Neustart bei laufender Seite.
- ✔ Lab 04 (ebenso mit GCC gebaut) besteht `webconsole/backend/test/e2e_versuch2.js`: Pendelbild
  in beiden Schwungrichtungen spaltengenau, Periodenmessung, Sensor, UART.
- ✘ Noch **nicht** getestet: Flashen/Debuggen auf dem echten Board, die Klickfolgen in der
  CCS-Oberfläche, CCS-Debugger gegen den Simulator; Lab 03 und Lab 04 mit tiarmclang; Bau des Docker-Images.
