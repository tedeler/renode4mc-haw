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
2. [Example 01 – Blinky](examples/example01_blinky/README.md) (GPIO, Clock-Gating, Warteschleife)
3. [Example 02 – Timer-Blink](examples/example02_timer_blink/README.md) (Timer, Interrupt, Vektortabelle)
4. [Example 03 – Web-Konsole](examples/example03_webkonsole/README.md) (UART, I2C mit OLED und Ultraschallsensor,
   Keypad-Multiplexing, Taster-Interrupts) – läuft in der [Web-Konsole](webconsole/README.md)
5. [Example 04 – Pendeldisplay](examples/example04_pendeldisplay/README.md) (POV-Anzeige mit Einmal-Timer,
   Synchronisation auf ein externes Signal, Ultraschallsensor, UART) – Web-Konsole, Example 2
6. **Praktikumsversuche Lab 1–4** mit eigener Simulator-Umgebung, Musterlösung und strenger Prüfung
   der Register: [docs/LABORE.md](docs/LABORE.md) – Beispiele `lab01_hexkeypad_bcd`,
   `lab02_led_pendel`, `lab03_nvic_pendel`, `lab04_uart_leds`

Kurzform, wenn alles installiert ist:

```bash
cd examples/example01_blinky && make && ucsim example01_blinky.out
```

Web-Konsole (nur Docker nötig, Renode ist im Container):

```bash
cd webconsole && docker compose up --build      # dann http://localhost:3000
```

## Inhalt

| Pfad | Inhalt |
|---|---|
| `examples/example01_blinky`, `examples/example02_timer_blink`, `examples/example03_webkonsole`, `examples/example04_pendeldisplay` | Beispiele mit `main.c`, CCS-`.projectspec`, `Makefile`, README |
| `examples/lab01_hexkeypad_bcd` … `examples/lab04_uart_leds` | Musterlösungen der Praktikumsversuche Lab 1–4 ([docs/LABORE.md](docs/LABORE.md)) |
| `tools/build-solutions.sh`, `tools/gcc/` | Musterlösungen mit gcc für die Web-Konsole bauen (`sim/solutions/`) |
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
| GPIO A–Q: Ausgänge, Eingänge, Pull-up/-down, Interrupts, DEN wie im Datenblatt, Lock/Commit, Warnungen bei Fehlkonfiguration | ✔ |
| Timer 0–7 (GPTM): periodisch/One-Shot, 32/16 Bit, auf-/abwärts, Prescaler, TnR/TnV, Interrupt, Warnungen | ✔ (Timer 4–7 mit NVIC und Timer 6/7 an 0x400E0000/0x400E1000 nur in den Lab-Umgebungen; kein Capture/PWM/RTC) |
| UART 0–7: Senden/Empfangen, 16-Byte-Empfangs-FIFO, Interrupts; in den Lab-Umgebungen Pin- und Baudratenprüfung, Empfang im Leitungstakt | ✔ (kein µDMA) |
| Hex-Keypad 4×4, BCD-Anzeige, HC-SR04, LED-Pendel (HAW), printf → CCS-Konsole | ✔ (Lab-Umgebungen, [docs/LABORE.md](docs/LABORE.md)) |
| I2C 0–9 als Master; Geräte SSD1306-OLED, MaxBotix MB1242 | ✔ (Example 1 der Web-Konsole) |
| Keypad 4×3 mit Matrix-Elektrik, Taster-Eingabe im Browser | ✔ (Web-Konsole) |
| Pendeldisplay (8 LEDs, 10 Hz, Sync-Signal), Nachleuchtbild im Browser | ✔ (Example 2 der Web-Konsole) |
| ADC, SysTick-Test | geplant (`docs/ROADMAP.md`) |

## Getestet / nicht getestet

- ✔ Beide Beispiele bauen mit `make` (tiarmclang) **und** headless in CCS 20.4
  (`tools/ccs-import.sh`); beide laufen im Simulator (LED-Takt gemessen); GDB-Haltepunkt in der
  Timer-ISR im Simulator funktioniert.
- ✔ Web-Konsole ohne Docker mit Renode 1.17.0: Example 03 (mit `arm-none-eabi-gcc` und einer
  GCC-Startdatei gebaut) besteht `webconsole/backend/test/e2e.js` (Upload, UART, LEDs, Taster,
  Keypad, Sensor, OLED) und läuft im Browser (Chromium), auch nach Neustart bei laufender Seite.
- ✔ Example 04 (ebenso mit GCC gebaut) besteht `webconsole/backend/test/e2e_example2.js`: Pendelbild
  in beiden Schwungrichtungen spaltengenau, Periodenmessung, Sensor, UART.
- ✘ Noch **nicht** getestet: Flashen/Debuggen auf dem echten Board, die Klickfolgen in der
  CCS-Oberfläche, CCS-Debugger gegen den Simulator; Example 03 und Example 04 mit tiarmclang; Bau des Docker-Images.
