# renode4mc-haw – programming and simulating the TM4C1294

Teaching material for the microcontroller lab at HAW Hamburg with the **EK-TM4C1294XL**
(TI Tiva C, ARM Cortex-M4F).

- **Program the way TI recommends:** Code Composer Studio (CCS) + TI Arm Clang. The examples
  use **direct register access** (data sheet, no driverlib).
- **Simulate as well:** the same `.out` file runs without a board in the simulator
  ([Renode](https://renode.io)); the LEDs appear on an HTML page in the browser.
- **Web console (Docker):** upload the `.out` file in the browser and operate the simulated hardware –
  LEDs, push buttons, UART terminal, OLED display, ultrasonic sensor, keypad
  ([docs/WEBCONSOLE.md](docs/WEBCONSOLE.md)).

```
 CCS project ──build──▶ program.out ──┬─▶ Debug/Run ──▶ board (USB, DEBUG port)
                                      ├─▶ ucsim program.out ──▶ Renode ──▶ browser (LEDs)
                                      └─▶ upload ──▶ web console (Docker: Renode + control panel in the browser)
```

## Getting started

**➜ [Guide: installation, operation and new experiments](docs/GUIDE.md)** – the step-by-step
introduction (web console with Docker, local installation, how to use it, creating your own experiments).

1. [Installation on Linux](docs/INSTALL_LINUX.md) (CCS, Renode, `ucsim`, board)
2. [Example 01 – Blinky](examples/example01_blinky/README.md) (GPIO, clock gating, busy-wait loop)
3. [Example 02 – Timer blink](examples/example02_timer_blink/README.md) (timer, interrupt, vector table)
4. [Example 03 – Web console](examples/example03_webkonsole/README.md) (UART, I2C with OLED and ultrasonic sensor,
   keypad multiplexing, push-button interrupts) – runs in the [web console](webconsole/README.md) with
   an experiment that has an OLED, an MB1242 and a keypad ([guide, section 3](docs/GUIDE.md#3-adding-a-new-experiment))
5. [Example 04 – Pendulum display](examples/example04_pendeldisplay/README.md) (POV display with a one-shot timer,
   synchronisation to an external signal, ultrasonic sensor, UART) – web console, Example 2
6. [Example 05 – Timer with CCP pins](examples/example05_timer_ccp/README.md) (PWM and pulse in
   16-bit compare mode, key press duration via capture, UART, oscilloscope) – web console, Example 3
7. **Lab sessions Lab 1–4** with their own simulator environment, reference solution and strict checking
   of the registers: [docs/LABS.md](docs/LABS.md). The reference solutions `lab01_hexkeypad_bcd` …
   `lab04_uart_leds` are included as ready-made ELF files (button "Reference solution"); their sources
   are only in the private submodule `solutions/` ([reference solutions](docs/LABS.md#reference-solutions))

Short version when everything is installed:

```bash
cd examples/example01_blinky && make && ucsim example01_blinky.out
```

Web console (only Docker needed, Renode is inside the container):

```bash
./StartDocker.sh            # Linux/macOS – Windows: StartDocker.bat (double-click); opens http://localhost:3000
                            # runs in the terminal, Ctrl+C stops it
```

## Contents

| Path | Contents |
|---|---|
| `examples/example01_blinky` … `examples/example05_timer_ccp` | examples with `main.c`, CCS `.projectspec`, `Makefile`, README |
| `solutions/` | private submodule [haw-mc-labsolutions](https://github.com/tedeler/haw-mc-labsolutions): sources of the reference solutions Lab 1–4 and lab instructions, for teaching staff only; empty without access ([docs/LABS.md](docs/LABS.md#reference-solutions)) |
| `sim/solutions/` | reference solutions as ready-made ELF files for the web console (Lab 1–4 checked in, Example 05 is built) |
| `tools/build-solutions.sh`, `tools/gcc/` | build the reference solutions with gcc for the web console (`sim/solutions/`); the lab solutions only if `solutions/` is checked out |
| `tools/tm4c.mk` | common `make` rules: looks for TI Arm Clang (CCS), otherwise arm-none-eabi-gcc; `make toolchain` shows the result |
| `StartDocker.sh`, `StartDocker.bat` | start/stop the web console with Docker (Linux/macOS, Windows) |
| `common/` | start-up code with the complete vector table, linker script (flash/SRAM of the TM4C1294) – **identical for board and simulator** |
| `sim/` | simulator: `ucsim` (start script), platform `.repl`, C# models (SYSCTL, GPIO, timer, UART, I2C, WebSocket bridge, OLED, ultrasonic sensor, keypad, pendulum display), LED page `visualizer/ek-tm4c1294xl.html`, experiments for the web console `experiments/` (one JSON file each with controls and pins, [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)) |
| `webconsole/` | web console: Node.js backend, React frontend, `Dockerfile`, `docker-compose.yml` |
| `tools/ccs-import.sh` | import and build a CCS project without the graphical user interface |
| `tools/check_header.py` | check the simulator hardware, vector table and examples against `common/tm4c1294ncpdt.h` |
| `tools/check_experiment.js` | check experiment files `sim/experiments/*.json` (pins, usage, fields) and show the generated Renode platform |
| `common/tm4c1294ncpdt.h` | register names and bit constants from TI (included by all examples) |
| `docs/` | `GUIDE.md` (start here: installation, operation, new experiments), `INSTALL_LINUX.md`, `TOOLCHAIN.md` (concept, debugging the simulator from CCS), `ROADMAP.md` (further peripherals), `WEBCONSOLE.md` (web console: architecture, protocols, operation, tests), `EXPERIMENTS.md` (format of the experiment files), `LABS.md` (Lab 1–4) |

## Simulated hardware

| Component | Status |
|---|---|
| Cortex-M4F, NVIC, 1 MB flash, 256 KB SRAM, bit-banding | ✔ |
| SYSCTL: clock gating (`RCGC*`/`PR*`), warning if the clock is missing | ✔ (the system clock is computed from RSCLKCFG/PLLFREQ, e.g. for the UART baud rate; the PLL locks immediately; the CPU itself counts instructions, not clock cycles. 16 MHz after reset) |
| GPIO A–Q: outputs, inputs, pull-up/-down, interrupts, DEN as in the data sheet, lock/commit, warnings on misconfiguration | ✔ |
| Timer 0–7 (GPTM): periodic/one-shot, 32/16 bit, counting up/down, prescaler, TnR/TnV, interrupt, warnings; compare action (TCACT), PWM and input edge-time on the CCP pins | ✔ (timers 6/7 at 0x400E0000/0x400E1000; match event TnMIE/TnMRIS in one-shot/periodic; no edge-count/RTC) |
| UART 0–7: transmit/receive as signal edges with correct baud-rate timing, FIFOs, error bits, interrupts; IBRD/FBRD only take effect with LCRH, warning on wrong baud rate/format | ✔ (no µDMA; UART0 with pin check and PC terminal) |
| hex keypad 4×4, BCD display, HC-SR04, LED pendulum (HAW), printf → CCS console | ✔ (lab environments, [docs/LABS.md](docs/LABS.md)) |
| I2C 0–9 as master; devices SSD1306 OLED, MaxBotix MB1242 | ✔ (element types `oled`, `mb1242` in experiment files; MB1242 in Example 2) |
| keypad 4×3 with matrix wiring, key input in the browser | ✔ (web console) |
| pendulum display (8 LEDs, 10 Hz, sync signal), afterglow image in the browser | ✔ (Example 2 of the web console) |
| ADC, SysTick test | planned (`docs/ROADMAP.md`) |

## Tested / not tested

- ✔ Examples 01 and 02 build with `make` (tiarmclang) **and** headless in CCS 20.4
  (`tools/ccs-import.sh`); both run in the simulator (LED timing measured); a GDB breakpoint in the
  timer ISR works in the simulator.
- ✔ Web console without Docker with Renode 1.17.0: Example 03 (built with `arm-none-eabi-gcc` and a
  GCC start-up file) passed `webconsole/backend/test/e2e.js` (upload, UART, LEDs, push buttons,
  keypad, sensor, OLED) and ran in the browser (Chromium), also after a restart while the page was
  open – tested with the earlier version of experiment `example1` (with OLED, MB1242, keypad; today
  "Simple elements", see [WEBCONSOLE.md, section 6](docs/WEBCONSOLE.md#6-tests)).
- ✔ Example 04 (also built with GCC) passes `webconsole/backend/test/e2e_example2.js`: pendulum image
  correct to the column in both swing directions, period measurement, sensor, UART.
- ✔ `example01_blinky.out` flashed onto a real board with OpenOCD and started
  ([INSTALL_LINUX.md, section 9](docs/INSTALL_LINUX.md#9-loading-an-out-file-onto-the-board-manually-without-ccs)).
- ✘ **Not** tested yet: debugging on the real board, the click sequences in the CCS user interface,
  the CCS debugger against the simulator; Example 03 and Example 04 with tiarmclang; building the Docker image.
