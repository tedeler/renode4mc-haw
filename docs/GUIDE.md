# Guide: installing, using and extending renode4mc-haw

This guide takes you step by step through the three most common tasks:

1. [Installation](#1-installation): the web console with Docker, or everything installed locally
2. [Using the simulator](#2-using-the-simulator): build firmware, simulate it in the web console, solve problems
3. [Adding a new experiment](#3-adding-a-new-experiment): your own controls and pins for a lab session

The details are in the specialised documents that are linked in each section:
[INSTALL_LINUX.md](INSTALL_LINUX.md) (CCS, Renode, board), [WEBCONSOLE.md](WEBCONSOLE.md)
(architecture, protocols, operation), [EXPERIMENTS.md](EXPERIMENTS.md) (format of the experiment files),
[LABS.md](LABS.md) (Lab 1–4).

**A few terms used throughout:**

| Term | Meaning |
|---|---|
| **Firmware** | the program that runs on the microcontroller. CCS and `make` produce it as an `.out` file (an ELF file: machine code plus symbol names). |
| **Simulator** | a program on the PC that behaves like the microcontroller and its peripherals. Here this is [Renode](https://renode.io) with our own models of the TM4C1294 peripherals. |
| **Web console** | a web page that shows the simulated board: LEDs, push buttons, terminal, displays, sensors, oscilloscope. |
| **Experiment** | one hardware set-up for the web console (which devices are connected to which pins), described by a JSON file. |
| **Docker** | a tool that runs a ready-made software package (a "container") with everything already installed. |

---

## Overview: what do I need for what?

| I want to … | I need | Section |
|---|---|---|
| simulate a finished program (`.out`) in the browser | only **Docker** | [1.1](#11-web-console-with-docker-recommended) |
| write and build programs | **Code Composer Studio (CCS)** or `make` with TI Arm Clang | [1.3](#13-building-programs-and-loading-them-onto-the-board-ccs) |
| test on the real board | CCS or OpenOCD, a udev rule, the EK-TM4C1294XL board | [1.3](#13-building-programs-and-loading-them-onto-the-board-ccs) |
| develop the web console itself | Node.js ≥ 18 and Renode 1.17.0 | [1.2](#12-web-console-without-docker-for-development) |

```
 CCS / make ──▶ program.out ──┬─▶ board (USB, DEBUG port)
                              ├─▶ ucsim  ──▶ Renode ──▶ LED page in the browser      (simple simulator)
                              └─▶ upload ──▶ web console (Docker: Renode + control panel in the browser)
```

---

## 1. Installation

### 1.1 Web console with Docker (recommended)

The container contains Renode, the simulation models from `sim/`, the user interface and the
built reference solutions. You do not need a compiler for this.

**Step 1 – install Docker.**
Linux: Docker Engine with the Compose plugin (<https://docs.docker.com/engine/install/>), then
add your user to the group `docker` (`sudo usermod -aG docker $USER`, then log out and in again).
Windows/macOS: Docker Desktop. Check:

```bash
docker compose version          # must print a version number
```

**Step 2 – get the repository.**

```bash
mkdir -p ~/lab && cd ~/lab
git clone https://github.com/tedeler/renode4mc-haw.git
cd renode4mc-haw
```

**Step 3 – build and start the container.** In the main folder of the repository:

```bash
./StartDocker.sh          # Linux and macOS
StartDocker.bat           # Windows (or double-click it in the Explorer)
```

The script checks whether Docker is running, builds the image (afterwards only what changed), starts
the container in the background, waits until the user interface answers and opens the browser.
Further commands: `stop` (stop), `logs` (show the output), `status`. By hand it works like this:
`cd webconsole && docker compose up --build`.

The first build takes a few minutes: it downloads the Node image and Renode and builds the user
interface and the reference solutions. After that, the backend compiles the C# models once (about
10 s; the log shows "ready: … models compiled"). From then on, every experiment starts in less than
a second.

**Step 4 – open the browser:** <http://localhost:3000>. You see the header bar with the
experiment selection. Continue with [2.2](#22-using-the-web-console).

**Stop:** `./StartDocker.sh stop` or `StartDocker.bat stop` (by hand: `Ctrl+C` in the terminal,
or `docker compose down`). Otherwise the container keeps running in the background, also after a reboot.
**Update:**

```bash
cd ~/lab/renode4mc-haw && git pull
./StartDocker.sh                  # rebuilds and starts
```

The About dialog (click on the logo at the top left) shows the Git version; `StartDocker` passes it
automatically, by hand it works like this:

```bash
GIT_COMMIT=$(git rev-parse HEAD) GIT_DATE=$(git log -1 --format=%cI) docker compose up --build
```

### 1.2 Web console without Docker (for development)

Requirements: Node.js ≥ 18 and Renode 1.17.0 in `~/renode`
([INSTALL_LINUX.md](INSTALL_LINUX.md), step 6).

```bash
cd ~/lab/renode4mc-haw/webconsole/frontend && npm install && npm run build
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start      # -> http://localhost:3000
```

The reference solutions of the labs (button "Reference solution") are ready-made in `sim/solutions/`.
For the demo of Example 05 you also need `arm-none-eabi-gcc` (Debian/Ubuntu:
`sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi`); then run `tools/build-solutions.sh`
once in the repository. Without it the button stays greyed out for that experiment.

With `npm run dev` in the frontend folder, Vite runs with hot reload on port 5173 and forwards
`/upload` and `/api` to the backend. All environment variables: [WEBCONSOLE.md, section 5](WEBCONSOLE.md#5-operation).

### 1.3 Building programs and loading them onto the board (CCS)

[INSTALL_LINUX.md](INSTALL_LINUX.md) sets up Code Composer Studio, TI Arm Clang, the udev rule for
the board, Renode and the start script `ucsim` step by step (about 1 hour). The examples need
**no TivaWare**: they access the registers directly through the TI header file
`common/tm4c1294ncpdt.h`.

Quick test when everything is installed:

```bash
cd ~/lab/renode4mc-haw/examples/example01_blinky
make                              # builds example01_blinky.out with tiarmclang from CCS
make toolchain                    # shows which compiler was found (without TI: gcc -> .elf)
ucsim example01_blinky.out        # simple simulator: D1/D2 blink in the browser
```

---

## 2. Using the simulator

### 2.1 Building the firmware

The web console accepts any ELF file for the TM4C1294:

- **CCS:** build the project; the file is in `Debug/<project>.out`.
- **make:** `make` in the folder of the example creates `<example>.out` with TI Arm Clang.
  `tools/tm4c.mk` searches for the compiler itself (PATH, `~/ti`, `~/tmp/ti`, `/opt/ti`, `/Applications/ti`);
  without TI it uses `arm-none-eabi-gcc` and creates `<example>.elf`. `make toolchain` shows what
  was found, `make TOOLCHAIN=gcc` forces gcc.
- **gcc:** start-up file `common/startup_tm4c1294.c`, linker script `tools/gcc/link.ld`,
  `tools/gcc/crt.c` and `tools/gcc/cio_gcc.c` (printf), see `tools/tm4c.mk`.

The same file runs in the simulator and on the board.

### 2.2 Using the web console

1. **Choose an experiment.** The controls appear immediately as a preview ("Preview · no
   firmware"). You can already adjust sliders, oscilloscope channels and the terminal settings.
2. **Choose the firmware:** your `.out` file.
3. **Start.** The control panel connects to the simulation; output of UART0 appears in the
   terminal. Clicking again ("Restart") reloads the firmware.
4. **Reference solution** (only for experiments that have one): starts the finished program instead
   of your own file. This way you can see how the solution is supposed to behave.
5. **Stop** ends the simulation; the experiment stays visible as a preview.

The header bar also contains:

| Element | Effect |
|---|---|
| **Reset** | like the reset button of the board: the MCU restarts, the firmware and the devices outside the chip stay as they are |
| **Simulation** | shows the simulation panel: CPU state, simulated time and speed, debugger (pause, single step, continue), CPU registers with disassembly, memory, peripheral registers, Renode messages |
| **〰 Scope** | oscilloscope with 4 channels for the pins of the experiment (trigger, time base) |
| **↺ Default layout** | rearranges the panels; otherwise you can collapse panels, move them by their title bar and change the column widths (saved per experiment in the browser) |

Below the terminal you set the baud rate and frame format of the "PC terminal". If the setting
does not match the firmware, wrong characters or no characters at all arrive – just like on real
hardware – and the Diagnostics panel tells you why.

**Diagnostics:** configuration errors (access without clock, pin not switched to its function,
wrong baud rate, fault handler …) appear in the Diagnostics panel. On the board the program would
simply not work in these cases; the simulator also tells you the reason.

### 2.3 The experiments that come with the repository

| Experiment (selection list) | File in `sim/experiments/` | Matching firmware |
|---|---|---|
| Simple elements | `example1.json` | LEDs D1–D4, USR_SW1/2 (with pull-up on the board), UART0, HC-SR04 on PD0/PD1 – for your own exercises, e.g. `example01_blinky`, `example02_timer_blink` |
| Example 2 – pendulum display | `example2.json` | `examples/example04_pendeldisplay` |
| Example 3 – Timer: PWM, pulse, capture | `example3.json` | `examples/example05_timer_ccp` (also as reference solution) |
| Lab 1 – GPIO: hex keypad and BCD display | `lab1_gpio.json` | reference solution `lab01_hexkeypad_bcd` |
| Lab 2 – LED pendulum with HC-SR04 | `lab2_pendel.json` | reference solution `lab02_led_pendel` |
| Lab 3 – NVIC | `lab3_nvic.json` | reference solution `lab03_nvic_pendel` |
| Lab 4 – UART | `lab4_uart.json` | reference solution `lab04_uart_leds` (terminal 9600 7N1) |

`examples/example03_webkonsole` needs an OLED, an MB1242 and a keypad. None of the experiments in
the repository has this combination at the moment; the example in [section 3](#3-adding-a-new-experiment)
shows how to create it.

### 2.4 Several workstations

One container simulates exactly **one** instance; a new start stops the running simulation.
For a course, start one container per person with their own host ports, e.g.

```bash
docker run -d --init --name seat1 --tmpfs /tmp:exec,mode=1777 \
  -p 3100:3000 -p 3433:3333 -p 3434:3334 renode4mc-webconsole:latest
```

The frontend must then know where the WebSockets are (`VITE_UART_WS_URL`/`VITE_CONTROL_WS_URL`
at build time, see [WEBCONSOLE.md, section 5](WEBCONSOLE.md#5-operation)). The container has no
login: on a network it belongs behind a reverse proxy with authentication.

### 2.5 Common problems

| Problem | Solution |
|---|---|
| `failed to map segment from shared object` | `/tmp` in the container is `noexec`. `docker compose` already sets `exec`; with `docker run` add `--tmpfs /tmp:exec,mode=1777` |
| port 3000/3333/3334 in use | stop the other program (e.g. `ucsim --debug` uses 3333) or choose other host ports |
| a new experiment does not appear | run the check tool (3.2) and reload the page; with Docker rebuild the image or mount the folder (3.3) |
| button "Reference solution" greyed out | the reference solution is not built: `tools/build-solutions.sh` (local) or rebuild the image |
| the terminal shows garbage or nothing | the terminal settings below the terminal do not match the firmware (read the Diagnostics panel) |
| speed clearly below 1× | the firmware reads registers all the time (polling); every access costs computing time in Renode. The simulated time is still exact |
| local tests: "port in use" | a Renode instance is left over: `pkill -9 -f renode` |

More problems with CCS and the board: [INSTALL_LINUX.md, "Common problems"](INSTALL_LINUX.md#common-problems).

---

## 3. Adding a new experiment

An experiment is **one JSON file** in `sim/experiments/`. It lists the controls and devices (LEDs,
push buttons, keypad, displays, sensors …) and defines which pins they are connected to. The
backend generates the Renode platform and start script from it by itself – you do not write any
Renode code and you do not change anything in the frontend.

### 3.1 Creating the file

File name = experiment ID (letters, digits, `_`, `-`), e.g. `sim/experiments/webkonsole.json`.
The quickest way is to copy the existing experiment that is most similar to yours.

Example: the experiment for `examples/example03_webkonsole` with the board LEDs, push buttons, UART
terminal, OLED and ultrasonic sensor on I2C0, and a 4×3 keypad on port K:

```json
{
  "title": "Complete web console: LEDs, push buttons, UART, OLED, ultrasonic sensor, keypad",
  "description": "For examples/example03_webkonsole",
  "uart": { "baud": 115200, "format": "8N1" },
  "elements": [
    { "type": "led", "id": "D1", "label": "D1 (PN1)", "pin": "PN1" },
    { "type": "led", "id": "D2", "label": "D2 (PN0)", "pin": "PN0" },
    { "type": "led", "id": "D3", "label": "D3 (PF4)", "pin": "PF4" },
    { "type": "led", "id": "D4", "label": "D4 (PF0)", "pin": "PF0" },
    { "type": "button", "id": "SW1", "label": "USR_SW1 (PJ0)", "pin": "PJ0" },
    { "type": "button", "id": "SW2", "label": "USR_SW2 (PJ1)", "pin": "PJ1" },
    { "type": "oled", "label": "SSD1306 on I2C0 (PB2/PB3), 0x3C", "address": "0x3C" },
    { "type": "mb1242", "label": "MB1242 on I2C0, 0x70", "address": "0x70", "min": 0, "max": 400, "unit": "cm" },
    { "type": "keypad",
      "pins": { "R0": "PK0", "R1": "PK1", "R2": "PK2", "R3": "PK3", "C0": "PK4", "C1": "PK5", "C2": "PK6" } }
  ]
}
```

The most important points about the format (complete description in [EXPERIMENTS.md](EXPERIMENTS.md)):

- `title` and `elements` are **required**. Every element has a `type`; pins are written as in
  the data sheet (`"PK0"`).
- **Element types:** `led`, `button`, `bcd`, `hexkeypad`, `keypad`, `pendulum`, `hcsr04`, `mb1242`,
  `oled`, `cio` (printf console as in CCS). List with all fields:
  `node tools/check_experiment.js --types`.
- **Always present**, without an entry: UART terminal (default UART0 on PA0/PA1), reset, simulation
  panel, debugger, oscilloscope.
- **Optional:** `uart` (pins, baud rate and format of the terminal), `scope` (initial oscilloscope
  channels), `quantumUs` (time slice of Renode; 10 for precise timing as with the pendulum), `solution`
  (reference solution, see 3.5).
- Fields that start with `_` are comments (`"_pins": "LED0 is at the top"`).
- Push buttons: `activeLow` (default `true`) and `pull` (`"up"`/`"down"`) for a resistor on the
  board. Without `pull` the firmware must switch on the internal pull-up, otherwise the
  Diagnostics panel warns you – just like USR_SW1/2 on the real board.

### 3.2 Checking

```bash
cd ~/lab/renode4mc-haw
node tools/check_experiment.js webkonsole                 # one experiment (ID or path)
node tools/check_experiment.js                            # all experiments
node tools/check_experiment.js --repl --resc webkonsole   # show what is generated for Renode
```

The tool checks exactly like the backend: does the pin exist on the chip, is it used twice or
reserved (JTAG, UART pins, I2C0 on PB2/PB3), do RX and TX belong to the same UART, are field names
misspelt? Exit code 0 = valid (notes are allowed), 1 = errors. An invalid experiment does not
appear in the web console; the reason is in the server log.

### 3.3 Making it visible in the web console

The list is read again every time the page is loaded.

- **Without Docker** (1.2): reload the page – done.
- **Docker, permanently:** the image contains a copy of `sim/`. Rebuild it:
  `cd webconsole && docker compose up --build`.
- **Docker, for trying it out without rebuilding:** mount the folder with the experiments into the
  container (run this in the repository root; the image must have been built once):

  ```bash
  docker run --rm --init --tmpfs /tmp:exec,mode=1777 \
    -p 3000:3000 -p 3333:3333 -p 3334:3334 \
    -v "$PWD/sim/experiments:/opt/renode4mc/sim/experiments:ro" \
    renode4mc-webconsole:latest
  ```

  After that, reloading the page is enough after every change to a JSON file.

### 3.4 Trying it out

Choose the experiment, check that all controls appear in the preview, then start it with a
matching firmware. Watch the Diagnostics panel: messages such as "access … without clock" or
"… is not configured as …" usually mean that the experiment and the firmware expect different
pins. With the oscilloscope you can see whether anything actually happens at the pins.

### 3.5 Adding a reference solution (optional)

1. Public reference solution (demo): create a folder `examples/<name>/` with `main.c` (and further
   `.c` files), copy the `.projectspec` and the `Makefile` of an existing example for CCS and `make`
   and rename them, and add `<name>` to the list `EXAMPLES` in `tools/build-solutions.sh`.
   Secret reference solution (lab): create it in the private submodule `solutions/labs/<name>/code/`
   (template: an existing lab); `tools/build-solutions.sh` finds it there by itself. Commit the
   generated `sim/solutions/<name>.elf` together with the new submodule state
   ([LABS.md](LABS.md#reference-solutions)).
2. The script builds with gcc into `sim/solutions/<name>.elf`; the Docker image runs it itself
   while it is built.
3. In the experiment file:

   ```json
   "solution": { "example": "<name>", "label": "Reference solution (interrupt version)" }
   ```

4. Locally, run `tools/build-solutions.sh` once (or `CC=/path/arm-none-eabi-gcc tools/build-solutions.sh`);
   with Docker, rebuild the image. `check_experiment.js` shows a note as long as the `.elf` is missing.

### 3.6 Committing

```bash
git add sim/experiments/webkonsole.json            # and, if needed, examples/<name>/ and tools/build-solutions.sh
git commit -m "Experiment webkonsole: OLED, MB1242, keypad"
git push
```

### 3.7 If a device type is missing

A new type (e.g. a different sensor) needs a C# model in `sim/models/`, an entry in the catalogue
`TYPES` in `webconsole/backend/lib/experimentSpec.js` and, if it has its own widget, commands in
`lib/controlBridge.js` and a component in the frontend. This is described in
[EXPERIMENTS.md, "Adding a new device type"](EXPERIMENTS.md#adding-a-new-device-type).
