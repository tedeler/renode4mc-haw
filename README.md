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

**➜ [Anleitung: Installation, Betrieb und neue Versuche](docs/ANLEITUNG.md)** – der Einstieg
Schritt für Schritt (Web-Konsole mit Docker, lokale Installation, Bedienung, eigene Versuche anlegen).

1. [Installation unter Linux](docs/INSTALL_LINUX.md) (CCS, Renode, `ucsim`, Board)
2. [Example 01 – Blinky](examples/example01_blinky/README.md) (GPIO, Clock-Gating, Warteschleife)
3. [Example 02 – Timer-Blink](examples/example02_timer_blink/README.md) (Timer, Interrupt, Vektortabelle)
4. [Example 03 – Web-Konsole](examples/example03_webkonsole/README.md) (UART, I2C mit OLED und Ultraschallsensor,
   Keypad-Multiplexing, Taster-Interrupts) – läuft in der [Web-Konsole](webconsole/README.md) mit
   einem Versuch mit OLED, MB1242 und Keypad ([Anleitung, Abschnitt 3](docs/ANLEITUNG.md#3-neuen-versuch-hinzufügen))
5. [Example 04 – Pendeldisplay](examples/example04_pendeldisplay/README.md) (POV-Anzeige mit Einmal-Timer,
   Synchronisation auf ein externes Signal, Ultraschallsensor, UART) – Web-Konsole, Example 2
6. [Example 05 – Timer mit CCP-Pins](examples/example05_timer_ccp/README.md) (PWM und Puls im
   16-Bit-Compare-Mode, Tastendauer per Capture, UART, Oszilloskop) – Web-Konsole, Example 3
7. **Praktikumsversuche Lab 1–4** mit eigener Simulator-Umgebung, Musterlösung und strenger Prüfung
   der Register: [docs/LABORE.md](docs/LABORE.md). Die Musterlösungen `lab01_hexkeypad_bcd` …
   `lab04_uart_leds` liegen als fertige ELF-Dateien bei (Knopf „Musterlösung“), ihre Quellen nur im
   privaten Submodul `solutions/` ([Musterlösungen](docs/LABORE.md#musterlösungen))

Kurzform, wenn alles installiert ist:

```bash
cd examples/example01_blinky && make && ucsim example01_blinky.out
```

Web-Konsole (nur Docker nötig, Renode ist im Container):

```bash
./StartDocker.sh            # Linux/macOS – Windows: StartDocker.bat (Doppelklick); öffnet http://localhost:3000
./StartDocker.sh stop       # anhalten
```

## Inhalt

| Pfad | Inhalt |
|---|---|
| `examples/example01_blinky` … `examples/example05_timer_ccp` | Beispiele mit `main.c`, CCS-`.projectspec`, `Makefile`, README |
| `solutions/` | privates Submodul [haw-mc-labsolutions](https://github.com/tedeler/haw-mc-labsolutions): Quellen der Musterlösungen Lab 1–4 und Laborbeschreibungen, nur für Lehrende; ohne Zugriff leer ([docs/LABORE.md](docs/LABORE.md#musterlösungen)) |
| `sim/solutions/` | Musterlösungen als fertige ELF-Dateien für die Web-Konsole (Lab 1–4 eingecheckt, Example 05 wird gebaut) |
| `tools/build-solutions.sh`, `tools/gcc/` | Musterlösungen mit gcc für die Web-Konsole bauen (`sim/solutions/`); Labor-Lösungen nur, wenn `solutions/` ausgecheckt ist |
| `tools/tm4c.mk` | gemeinsame `make`-Regeln: sucht TI Arm Clang (CCS), sonst arm-none-eabi-gcc; `make toolchain` zeigt das Ergebnis |
| `common/` | Startup-Code mit vollständiger Vektortabelle, Linker-Skript (Flash/SRAM des TM4C1294) – **identisch für Board und Simulator** |
| `sim/` | Simulator: `ucsim` (Startskript), Plattform `.repl`, C#-Modelle (SYSCTL, GPIO, Timer, UART, I2C, WebSocket-Brücke, OLED, Ultraschall, Keypad, Pendeldisplay), LED-Anzeige `visualizer/ek-tm4c1294xl.html`, Versuche für die Web-Konsole `experiments/` (je eine JSON-Datei mit Bedienelementen und Pins, [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)) |
| `webconsole/` | Web-Konsole: Node.js-Backend, React-Frontend, `Dockerfile`, `docker-compose.yml` |
| `tools/ccs-import.sh` | CCS-Projekt ohne Oberfläche importieren und bauen |
| `tools/check_header.py` | Simulator-Hardware, Vektortabelle und Beispiele gegen `common/tm4c1294ncpdt.h` prüfen |
| `tools/check_experiment.js` | Versuchsdateien `sim/experiments/*.json` prüfen (Pins, Belegung, Felder) und erzeugte Renode-Plattform zeigen |
| `common/tm4c1294ncpdt.h` | Registernamen und Bitkonstanten von TI (wird von allen Beispielen eingebunden) |
| `docs/` | `ANLEITUNG.md` (Einstieg: Installation, Betrieb, neue Versuche), `INSTALL_LINUX.md`, `TOOLCHAIN.md` (Konzept, CCS-Debugging des Simulators), `ROADMAP.md` (weitere Peripherie), `WEBCONSOLE.md` (Web-Konsole: Architektur, Protokolle, Betrieb, Tests), `EXPERIMENTS.md` (Format der Versuchsdateien), `LABORE.md` (Lab 1–4) |

## Simulierte Hardware

| Baustein | Stand |
|---|---|
| Cortex-M4F, NVIC, 1 MB Flash, 256 KB SRAM, Bit-Banding | ✔ |
| SYSCTL: Clock-Gating (`RCGC*`/`PR*`), Warnung bei fehlendem Takt | ✔ (Systemtakt wird aus RSCLKCFG/PLLFREQ berechnet, z. B. für die UART-Baudrate; PLL rastet sofort ein; die CPU selbst rechnet Befehle, keine Takte. Nach Reset 16 MHz) |
| GPIO A–Q: Ausgänge, Eingänge, Pull-up/-down, Interrupts, DEN wie im Datenblatt, Lock/Commit, Warnungen bei Fehlkonfiguration | ✔ |
| Timer 0–7 (GPTM): periodisch/One-Shot, 32/16 Bit, auf-/abwärts, Prescaler, TnR/TnV, Interrupt, Warnungen; Compare-Action (TCACT), PWM und Input Edge-Time an den CCP-Pins | ✔ (Timer 6/7 an 0x400E0000/0x400E1000; Match-Ereignis TnMIE/TnMRIS in One-Shot/Periodic; kein Edge-Count/RTC) |
| UART 0–7: Senden/Empfangen als Flanken mit Baudraten-Timing, FIFOs, Fehlerbits, Interrupts; IBRD/FBRD erst mit LCRH wirksam, Warnung bei falscher Baudrate/Format | ✔ (kein µDMA; UART0 mit Pin-Prüfung und PC-Terminal) |
| Hex-Keypad 4×4, BCD-Anzeige, HC-SR04, LED-Pendel (HAW), printf → CCS-Konsole | ✔ (Lab-Umgebungen, [docs/LABORE.md](docs/LABORE.md)) |
| I2C 0–9 als Master; Geräte SSD1306-OLED, MaxBotix MB1242 | ✔ (Elementtypen `oled`, `mb1242` in Versuchsdateien; MB1242 in Example 2) |
| Keypad 4×3 mit Matrix-Elektrik, Taster-Eingabe im Browser | ✔ (Web-Konsole) |
| Pendeldisplay (8 LEDs, 10 Hz, Sync-Signal), Nachleuchtbild im Browser | ✔ (Example 2 der Web-Konsole) |
| ADC, SysTick-Test | geplant (`docs/ROADMAP.md`) |

## Getestet / nicht getestet

- ✔ Example 01 und 02 bauen mit `make` (tiarmclang) **und** headless in CCS 20.4
  (`tools/ccs-import.sh`); beide laufen im Simulator (LED-Takt gemessen); GDB-Haltepunkt in der
  Timer-ISR im Simulator funktioniert.
- ✔ Web-Konsole ohne Docker mit Renode 1.17.0: Example 03 (mit `arm-none-eabi-gcc` und einer
  GCC-Startdatei gebaut) bestand `webconsole/backend/test/e2e.js` (Upload, UART, LEDs, Taster,
  Keypad, Sensor, OLED) und lief im Browser (Chromium), auch nach Neustart bei laufender Seite –
  getestet mit dem früheren Ausbau von Versuch `example1` (mit OLED, MB1242, Keypad; heute
  „Simple Elemente“, siehe [WEBCONSOLE.md, Abschnitt 6](docs/WEBCONSOLE.md#6-test)).
- ✔ Example 04 (ebenso mit GCC gebaut) besteht `webconsole/backend/test/e2e_example2.js`: Pendelbild
  in beiden Schwungrichtungen spaltengenau, Periodenmessung, Sensor, UART.
- ✔ `example01_blinky.out` mit OpenOCD auf ein echtes Board geflasht und gestartet
  ([INSTALL_LINUX.md, Abschnitt 9](docs/INSTALL_LINUX.md#9-eine-out-datei-manuell-auf-das-board-laden-ohne-ccs)).
- ✘ Noch **nicht** getestet: Debuggen auf dem echten Board, die Klickfolgen in der
  CCS-Oberfläche, CCS-Debugger gegen den Simulator; Example 03 und Example 04 mit tiarmclang; Bau des Docker-Images.
