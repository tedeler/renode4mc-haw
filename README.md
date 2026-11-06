# renode4mc-haw – TM4C1294 programmieren und simulieren

Lehrmaterial für das Mikrocontroller-Praktikum an der HAW mit dem **EK-TM4C1294XL**
(TI Tiva C, ARM Cortex-M4F).

- **Programmieren wie von TI empfohlen:** Code Composer Studio (CCS) + TI Arm Clang. Die Beispiele
  nutzen **reinen Registerzugriff** (Datenblatt, keine driverlib).
- **Zusätzlich simulieren:** Dieselbe `.out`-Datei läuft ohne Board im Simulator
  ([Renode](https://renode.io)); die LEDs erscheinen in einer HTML-Seite im Browser.

```
 CCS-Projekt ──Build──▶ programm.out ──┬─▶ Debug/Run ──▶ Board (USB, DEBUG-Port)
                                       └─▶ ucsim programm.out ──▶ Renode ──▶ Browser (LEDs)
```

## Loslegen

1. [Installation unter Linux](docs/INSTALL_LINUX.md)
2. [Lab 01 – Blinky](examples/lab01_blinky/README.md) (GPIO, Clock-Gating, Warteschleife)
3. [Lab 02 – Timer-Blink](examples/lab02_timer_blink/README.md) (Timer, Interrupt, Vektortabelle)

Kurzform, wenn alles installiert ist:

```bash
cd examples/lab01_blinky && make && ucsim lab01_blinky.out
```

## Inhalt

| Pfad | Inhalt |
|---|---|
| `examples/lab01_blinky`, `examples/lab02_timer_blink` | Beispiele mit `main.c`, CCS-`.projectspec`, `Makefile`, README |
| `common/` | Startup-Code mit vollständiger Vektortabelle, Linker-Skript (Flash/SRAM des TM4C1294) – **identisch für Board und Simulator** |
| `sim/` | Simulator: `ucsim` (Startskript), Plattform `.repl`, C#-Modelle (SYSCTL, GPIO, Timer, WebSocket-Brücke), LED-Anzeige `visualizer/ek-tm4c1294xl.html` |
| `tools/ccs-import.sh` | CCS-Projekt ohne Oberfläche importieren und bauen |
| `docs/` | `INSTALL_LINUX.md`, `TOOLCHAIN.md` (Konzept, CCS-Debugging des Simulators), `ROADMAP.md` (weitere Peripherie) |

## Simulierte Hardware

| Baustein | Stand |
|---|---|
| Cortex-M4F, NVIC, 1 MB Flash, 256 KB SRAM, Bit-Banding | ✔ |
| SYSCTL: Clock-Gating (`RCGC*`/`PR*`), Warnung bei fehlendem Takt | ✔ (PLL/Takt-Umschaltung nicht; Takt fest 16 MHz) |
| GPIO A–Q: Ausgänge, Eingänge, Pull-up/-down, Interrupts | ✔ |
| Timer 0–7 (GPTM): periodisch/One-Shot, 32/16 Bit, Interrupt | ✔ (Timer 4–7 ohne NVIC-Verdrahtung) |
| UART, ADC, SysTick-Test, Taster-Eingabe im Browser | geplant (`docs/ROADMAP.md`) |

## Getestet / nicht getestet

- ✔ Beide Beispiele bauen mit `make` (tiarmclang) **und** headless in CCS 20.4
  (`tools/ccs-import.sh`); beide laufen im Simulator (LED-Takt gemessen); GDB-Haltepunkt in der
  Timer-ISR im Simulator funktioniert.
- ✘ Noch **nicht** getestet: Flashen/Debuggen auf dem echten Board, die Klickfolgen in der
  CCS-Oberfläche, CCS-Debugger gegen den Simulator.
