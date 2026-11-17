# Web console: TM4C1294 simulation in the browser

The web console is a second user interface for the simulator in `sim/`. Instead of running `ucsim`
on your own computer, everything runs in **one Docker container**: students open a web page,
choose an experiment, upload the `.out` file built by CCS and operate the simulated hardware in
the browser. The experiment defines which controls are available: LEDs, push buttons, a UART
terminal, OLED display, ultrasonic sensors, keypads, 7-segment display, pendulum display.

The container has no compiler and no IDE. You build the firmware as before with CCS or `make`
(see [TOOLCHAIN.md](TOOLCHAIN.md)). The container only accepts the finished ELF file. It is
**stateless**: the firmware is stored in `/tmp`, nothing is stored permanently.

```
 CCS / make ──▶ program.out ──upload──▶ web console (Docker) ──▶ Renode (sim/) ──▶ control panel in the browser
```

Step-by-step introduction: [GUIDE.md](GUIDE.md); short guide for starting:
[`webconsole/README.md`](../webconsole/README.md).
Example programs: [Example 04](../examples/example04_pendeldisplay/README.md) uses the pendulum display
of Example 2, [Example 05](../examples/example05_timer_ccp/README.md) the timer pins of Example 3.
[Example 03](../examples/example03_webkonsole/README.md) needs an OLED, an MB1242 and a keypad, which no
experiment in the repository contains today (experiment file for it: [GUIDE.md, section 3](GUIDE.md#3-adding-a-new-experiment)).

---

## 1. Architecture

Three layers in one container:

```
┌──────────────────────────── Docker container ──────────────────────────────────────────────┐
│                                                                                             │
│  Node.js / Express  (entry point: node server.js)                                           │
│  ├─ HTTP :3000   static React SPA, POST /upload, GET /api/experiments, /api/status          │
│  ├─ RenodeManager      starts/stops Renode as a child process (cwd = sim/)                  │
│  ├─ UartBridge   :3333 WebSocket  ⇄  TCP 127.0.0.1:3335  (UartHostTerminal.ServeTcp, UART0) │
│  └─ ControlBridge:3334 WebSocket  ⇄  TCP 127.0.0.1:1234  (Renode monitor, Telnet)           │
│                                   ⇄  TCP 127.0.0.1:1235  (query port, TivaSysCtl)           │
│                                   ⇠  WS  127.0.0.1:9000  (LED bridge, sim/models)           │
│                                                                                             │
│  Renode 1.17.0 (headless):  renode --disable-gui --port 1234                                │
│                             -e "$elf=@/tmp/app.elf; s @/tmp/renode4mc-experiments/<id>.resc"│
│  └─ sim/tm4c1294.resc + sim/platforms/tm4c1294ncpdt.repl + generated <id>.repl              │
│     (.resc/.repl generated from sim/experiments/<id>.json, see EXPERIMENTS.md)              │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
         ▲ :3000 HTTP            ▲ :3333 UART WS              ▲ :3334 control WS
         └────────────────────── browser (React, xterm.js, canvas) ─────────────────────────────┘
```

**Why bridges and not a direct WebSocket to Renode?** Renode does not provide UART, monitor and GPIO
as WebSockets but as TCP sockets. These are the UART terminal (`UartHostTerminal.ServeTcp`,
port 3335), the Telnet monitor (`--port`, 1234) and the query port (`TivaSysCtl.ServeQueries`, 1235).
The exception is the LED bridge from `sim/models/WebSocketBridge.cs`.
The backend therefore translates between the two worlds. This has two advantages:

- The internal ports (1234, 1235, 3335, 9000) stay inside the container. Only 3000, 3333 and 3334 are exposed.
- The browser **cannot send arbitrary monitor commands**. It only sends events such as
  "push button SW1 pressed". The backend builds commands from them, using only Renode paths from
  the experiment configuration. Monitor access would otherwise be access to the container,
  because Renode can execute Python and C#.

### Preview after selecting an experiment

As soon as an experiment is selected, the web console shows its controls – even without firmware
(`GET /api/experiments/<id>`). In this **preview** (badge "Preview · no firmware" in the header bar)
there is no WebSocket connection: LEDs and displays stay dark, push buttons and keypad report
"No firmware loaded". Sliders (distance, pendulum frequency), oscilloscope channels and the
terminal settings can already be set (`POST /api/terminal`); after the start, the same widgets
connect to the simulation and take over these values. If another experiment is still running in
the backend, the header bar shows this; Start stops it, selecting it again shows it live.
After **Stop**, the experiment stays visible as a preview.

### What happens when you click "Start"

1. The browser sends `POST /upload` (`multipart/form-data`: `experiment_id`, `file`).
2. The backend checks the experiment ID (the file `sim/experiments/<id>.json` must exist and be
   valid) and the ELF signature (`0x7F 'E' 'L' 'F'`). It generates `.repl` and `.resc` in
   `GENERATED_DIR` from the experiment file.
3. The browser WebSockets are closed with code `4000`. The frontend reconnects immediately.
4. The file is moved to `/tmp/app.elf`. Renode runs permanently (see below): via the monitor the
   backend resets machine and emulation with `Clear`, sets `$elf`, `$queryPort` and, if needed,
   `$uartBaud`/`$uartFormat`, and runs `include @<id>.resc`.
5. The backend waits until the UART terminal (port 3335) and the monitor (port 1234) are reachable.
   The UART terminal only exists after the `.resc` script has run.
6. Response **HTTP 200** with the experiment configuration. The frontend builds the control panel.

**Renode in permanent operation** (default): the backend starts Renode already when it starts
itself and compiles all C# models from `sim/models` (~10 s, log "ready: … models compiled"). After
that a start takes ~0.3–0.5 s instead of ~11 s (measured 12 Nov 2026: ~1.6 s .NET start, ~6.3 s
compiling the models, ~1 s machine, ~0.7 s stopping the old process). Renode skips files that have
already been compiled ("has already been compiled"), so the generated `.resc` runs unchanged.
`Clear` instead of `mach rem`, because otherwise the virtual time of the new machine would continue
from that of the old one and the `start` in the `.resc` would be ignored. "Stop" only removes the
machine. Renode is restarted when a model file has changed (modification time), when the process
is no longer running or when loading fails (retried once). Models with their own ports release
them in `Dispose()` (`TivaSysCtl` query port, `UartHostTerminal`, `WebSocketBridge` – the latter is
not attached to the bus and registers for `MachineRemoved` instead).
`RENODE_PERSISTENT=0` restores the earlier behaviour (a new Renode process for every start).

If the start fails (e.g. an error in the `.resc`), the backend answers with HTTP 500. The last
lines of the Renode log are then in `log` and are shown in the browser in an expandable section.

### Where the displayed values come from

| Display | Source | Method |
|---|---|---|
| LEDs D1–D4 | `wsBridge` (`sim/models/WebSocketBridge.cs`, ws://127.0.0.1:9000) | **push**: every level change (`LED<n>=<0|1>`), with PWM also the averaged brightness (`LEDB<n>=<per mille>`, `LEDB<n>=-` = plain on/off again) |
| UART0 | `sysbus.uart0.host` (PC terminal) → `ServeTcp 3335` | byte stream, passed through unchanged; the PC terminal decodes the line with its own settings (section "UART line as signal edges") |
| simulation panel | `sysbus.sysctl GetStatus`, `sysbus.uart0 LineBaudRate/FrameFormat`, Renode log | **polling** every 500 ms, only while the panel is open |
| lines (oscilloscope) | `sysbus.uart0 GetEdges` | **polling** every 100 ms, only while a browser has subscribed to the line |
| OLED | `sysbus.i2c0.oled GetFrameIfChanged` | **polling** every 100 ms, only transferred on change |
| LEDs with `path` (other experiments) | `<path> State` | polling every 100 ms |

Commands from the browser have priority over polling: they are put at the front of the monitor queue.

### User interface (layout)

- **Desktop** (window of at least 760 × 520 px): everything fits on one page, the page never scrolls.
  The panels are arranged in columns (default: displays | UART/printf | board, sensor, diagnostics;
  below 1280 px width two columns) and share the height. Pendulum, OLED, keypad and 7-segment
  display scale with it.
  - Click the title bar of a panel (or ▾): collapse/expand – the other panels get the space.
    Collapsed panels keep running (terminal, displays, WebSockets).
  - Drag the title bar: move the panel; drag it to the left/right edge or onto the divider between
    two columns = new column at this position (blue vertical line; at most 6 columns and as many as
    fit with a width of at least 240 px).
  - Drag the divider between columns: change the width; double-click: make both equally wide.
  - Click the HAW logo at the top left: About dialog with version number, Git commit (link to
    GitHub) and link to the repository.
  - Right side of the header bar: show/hide 〰 Scope, ⊟/⊞ collapse/expand all, **↺ Default layout**
    (back to the default arrangement, everything visible; on mobile at the end of the jump bar).
- **Phone / small window**: one column in layout order, the page scrolls. The bar below the header
  jumps to each panel (collapsed ones dashed, Diagnostics coloured when there are messages); the
  setup (experiment, firmware, start/stop) can be collapsed and is collapsed after the start; change
  the order with the grip ⠿.
- Position, width and collapsed state of the panels are saved per experiment in the browser
  (`localStorage`, key `renode4mc.layout.v1.<experiment>`) and restored the next time this experiment
  is started. When a new diagnostic message arrives, the Diagnostics panel expands.
- Code: `webconsole/frontend/src/layout/Workspace.jsx` (panels are rendered via a portal into stable
  DOM nodes and only re-attached when they are moved), panel list with default column/height share
  in `components/ControlPanel.jsx`.

---

## 2. Simulated hardware

The basis is the platform `sim/platforms/tm4c1294ncpdt.repl` (Cortex-M4F, SYSCTL, GPIO A–Q, timers,
**UART 0–7, I2C 0–9**). Which devices are connected in addition is described by the experiment file
`sim/experiments/<id>.json` ([EXPERIMENTS.md](EXPERIMENTS.md)).

### Example 1 ("Simple elements")

`sim/experiments/example1.json`:

| Component | Pins / address | Model | Operation in the browser |
|---|---|---|---|
| LEDs D1, D2, D3, D4 | PN1, PN0, PF4, PF0 | `TivaGPIOPort` → `wsBridge` | display |
| push buttons USR_SW1, USR_SW2 | PJ0, PJ1 (pressed = LOW, pull-up on the board: `"pull": "up"`) | `TivaGPIOPort` (input) | button: keep pressed = LOW |
| UART0 | PA0 RX, PA1 TX | `TivaUART` | terminal (xterm.js), input goes to RX; baud rate/format of the terminal selectable |
| PC terminal | on UART0, 115200 8N1 | `UartHostTerminal` | settings below the terminal (baud, data, parity, stop) |
| ultrasonic HC-SR04 | trigger PD0 (output), echo PD1 (input) | `HcSr04` | slider 0–350 cm (start 65 cm; outside 3–300 cm no echo) |

Further devices for your own experiments (element types in [EXPERIMENTS.md](EXPERIMENTS.md)):

| Component | Pins / address (default) | Model | Operation in the browser |
|---|---|---|---|
| I2C master | I2C0: PB2 SCL, PB3 SDA | `TivaI2C` | – |
| OLED SSD1306 128×64 (`oled`) | I2C0, 0x3C | `SSD1306I2C` | canvas, 4× magnified |
| ultrasonic MB1242 (`mb1242`) | I2C0, 0x70 | `MaxBotixI2C` | slider 0–400 cm |
| keypad 4×3 (`keypad`) | rows = MCU outputs, columns = MCU inputs (pull-down in the model) | `KeypadMatrix` | keypad |

### The models (`sim/models/`)

| File | Short description |
|---|---|
| `TivaUART.cs` | PL011-like UART of the TM4C129. DR (with FE/PE/BE/OE), RSR, FR, IBRD/FBRD/LCRH (also BRK), CTL (HSE, EOT, LBE), CC, IFLS, IM/RIS/MIS/ICR, ID registers. Transmit and receive FIFO with 16 characters, overrun. RX, RT, TX, FE, PE, BE and OE interrupts. Clock gating `RCGCUART`. Transmits signal edges with baud-rate timing (TXFF/TXFE/BUSY with correct timing), receives by sampling the edges in the middle of each bit. Checks whether PA0/PA1 are configured as U0RX/U0TX via AFSEL/DEN/PCTL. |
| `UartLine.cs` | Common parts of the UART line: format and bit duration, encoder (byte → edges), decoder (edges → characters, framing/parity errors, break), edge buffer `SignalRecorder` for the oscilloscope, timer in ns. |
| `UartHostTerminal.cs` | PC with a terminal program at the other end of UART0. Decodes the edges with `TerminalBaudRate`/`Format` and passes the bytes to the socket terminal; keyboard input becomes edges on U0RX. |
| `TivaI2C.cs` | I2C master: MSA, MCS, MDR, MTPR, MIMR/MRIS/MMIS/MICR, MCR, MBMON. START/RUN/STOP/ACK, repeated start, address NACK as `ERROR`+`ADRACK`, master interrupt, clock gating `RCGCI2C`. So that wait loops of the form "first wait for BUSY, then for not-BUSY" do not hang, the first read of MCS after a command returns `BUSY=1`. |
| `SSD1306I2C.cs` | OLED controller: control byte (Co/DC), page, horizontal and vertical addressing, column and page range, display on/off, invert, segment remap (A0/A1), COM scan direction (C0/C8). `GetFrame`/`GetFrameIfChanged` return the visible image as Base64. |
| `MaxBotixI2C.cs` | Ultrasonic sensor MB1242: writing `0x51` starts the measurement, reading 2 bytes returns cm. Property `Distance` (0–765). |
| `PendulumDisplay.cs` | Pendulum display (Example 2): 8 LED inputs, sync output (HIGH = right), movement `sin(2·π·t/T)` in virtual time, period adjustable at run time via `PeriodUs` (0.05–100 Hz), afterglow image per swing direction. `GetFrame` returns `PD:<columns>:<period in µs>:<phase>:<LEDs>:<Base64>`. |
| `Oscilloscope.cs` | Oscilloscope of the web console (in the base platform as `sysbus.scope`): records the level changes of selected pins in virtual time (resolution 1 µs). `Probe "PD0,PD1"` selects the pins, `GetEvents` returns `SC:<now ns>:<pins>:<levels>:<i,dt ns,level;…>:<dropped>`. The pin level is measured like with a probe (`TivaGPIOPort.PadLevel`): driven output, input driven from outside, pull-up/-down or floating. UART pins (PA0/PA1 when configured as U0RX/U0TX) show the same edges as the UART line: TX with the baud rate and format of the firmware, RX with the settings of the PC terminal. |
| `KeypadMatrix.cs` | Key matrix with real multiplexing behaviour: column = OR over (row HIGH AND key pressed). Row scanning and interrupt operation work as on hardware. `SetKey <row> <column> <true|false>`. |

**Keypad multiplexing.** Clicking "5" does not send "key 5". The frontend looks the key up in its
matrix mapping and sends the coordinate (row 1, column 1). The model then connects the row line
PK1 electrically to the column line PK5. The column only becomes HIGH when the firmware drives the
row HIGH. So the firmware has to find the key by scanning the rows, just as on real hardware. A
program that reads the columns without driving the rows does not see a key press. This is
intended for teaching purposes.

### Example 2: pendulum display

`sim/experiments/example2.json` adds a pendulum display and the ultrasonic sensor MB1242 to the base
platform. LEDs D1–D4 and UART0 are the same as in Example 1; Example 2 has no push buttons.

| Component | Pins / address | Model | Operation in the browser |
|---|---|---|---|
| pendulum display, 8 LEDs | PM0–PM7 (outputs); upright pendulum, pivot at the bottom, PM0 at the top at the tip | `PendulumDisplay` | swinging rod (dark grey) with LEDs and a fading light trail (afterglow time adjustable) |
| pendulum signal | PL0 (input): HIGH = right, LOW = left | `PendulumDisplay.Sync` | – |
| ultrasonic MB1242 | I2C0, 0x70 | `MaxBotixI2C` | slider 0–400 cm |

`PendulumDisplay.cs` models a pendulum that swings with `x(t) = sin(2·π·t/T)`
(T = `periodUs`, default 100 000 µs = 10 Hz). The output `Sync` is HIGH as long as `x > 0`,
i.e. a rising edge when passing the centre to the right, a falling edge when passing to the left.
All times are **virtual** simulated time.

**Setting the frequency:** the browser has a slider for this (range from `minFrequency`/`maxFrequency`
of the experiment JSON, in Example 2: 0.1–20 Hz). The backend sets the property `PeriodUs` of the
model (0.05–100 Hz). The new period takes effect from the next pass through the centre. There the
deflection is zero at every frequency, so the pendulum continues without a jump. That is why the
model computes internally in phases (number of half oscillations), not in time.

On every level change of an LED, the model transfers the previous LED state to the angle segments
that the pendulum has swept since then. The swing range is divided into `columns` (default 120)
equally wide segments from `x = −1` to `x = +1`. There is one image per swing direction, each from
the last swing. The frontend shows both overlaid (like the eye) or separately. This way you
immediately see whether the swings in both directions match.

So that the times of the LED changes are precise enough, Example 2 sets Renode's time slice to
10 µs (`"quantumUs": 10`, generates `emulation SetGlobalQuantum "0.00001"`; Renode default 100 µs).

### Monitor commands (for trying things out without a browser)

You can also start Renode directly: `node tools/check_experiment.js --out /tmp/v example1`, then `cd sim` and
`renode --console -e "\$elf=@../examples/example01_blinky/example01_blinky.out; s @/tmp/v/example1.resc"`.
Then `nc localhost 3335` for the UART. In the monitor:

```
sysbus.gpioJ OnGPIO 0 false            # press USR_SW1 (LOW)
sysbus.gpioJ OnGPIO 0 true             # release it
sysbus.gpioD.hcsr04 Distance 42        # HC-SR04: distance 42 cm

# experiment with OLED, MB1242 and keypad (e.g. webkonsole from GUIDE.md, section 3):
sysbus.gpioK.keypad SetKey 1 1 true    # keypad: press row 1, column 1 ("5")
sysbus.gpioK.keypad SetKey 1 1 false
sysbus.i2c0.sensor Distance 42         # MB1242: distance 42 cm
sysbus.i2c0.oled GetFrame              # frame buffer as Base64

# Example 2 (s @/tmp/v/example2.resc):
sysbus.gpioM.pendel SyncLevel          # current level on PL0 (True = pendulum right)
sysbus.gpioM.pendel Leds               # current LED state (bit n = LED n)
sysbus.gpioM.pendel PeriodUs 80000     # pendulum at 12.5 Hz (from the next zero crossing)
sysbus.gpioM.pendel GetFrame           # "PD:<columns>:<period in us>:<phase>:<LEDs>:<Base64>"
sysbus.gpioM.pendel GetEvents          # "EV:<t>:<phase>:<LEDs>:<period>:<t,phase,LEDs,period;…>" (LED changes since the last call)
```

---

## 3. Protocols

### HTTP

| Method, path | Description |
|---|---|
| `GET /api/experiments` | list of experiments `[{ id, title, solution }]` (all valid `sim/experiments/*.json`; `solution` = `{ label, available }` or `null`) |
| `GET /api/experiments/<id>` | configuration of an experiment without starting it (preview): `{ experiment, terminal: { baud, format } }`; 404 unknown, 500 invalid experiment file |
| `POST /api/terminal` | `{ experiment_id, baud, format }` – remember the terminal settings of an experiment that is not running (used at the start); 400 for invalid values or if the experiment is running |
| `GET /api/status` | `{ running, experiment, solution }` – restores the control panel after the page is reloaded |
| `POST /api/solution` | JSON `{ experiment_id }`: start the reference solution of the experiment (`sim/solutions/<example>.elf`), response as for `/upload` with `solution: true` ([LABS.md](LABS.md)) |
| `POST /upload` | `multipart/form-data`: `experiment_id`, `file` (`.out`/`.elf`/`.axf`, max. 16 MB). Response 200 `{ status: "running", experiment }`, otherwise 400/500 `{ error, log? }` |
| `POST /api/stop` | stop the simulation |

### UART WebSocket (`ws://<host>:3333`)

Binary frames in both directions, bytes unchanged. New clients receive the last 16 KB of the
output. When Renode restarts, the server closes with code **4000**: the terminal is cleared and
the frontend reconnects immediately.

### Control WebSocket (`ws://<host>:3334`)

JSON messages.

Browser → server:

```jsonc
{ "type": "button", "id": "SW1", "pressed": true }          // id from the experiment JSON
{ "type": "keypad", "row": 1, "col": 1, "pressed": true }   // matrix coordinate, not the key
{ "type": "sensor", "value": 120 }                          // cm, limited to min..max
{ "type": "pendulum", "frequency": 12.5 }                   // Hz, limited to minFrequency..maxFrequency
{ "type": "uartconfig", "baud": 9600, "format": "7N1" }     // PC terminal; also valid after restarts
{ "type": "subscribe", "signals": ["uart0.tx", "uart0.rx"] } // subscribe to edges (oscilloscope)
{ "type": "unsubscribe", "signals": ["uart0.tx"] }
{ "type": "reset" }                                         // reset button: only the microcontroller
{ "type": "watch", "sim": true,                             // simulation panel on (false = off)
  "memory": { "addr": "ticks", "count": 128 },              //   optional: memory (hex address or symbol)
  "periph": "UART0" }                                       //   optional: module from "simmeta"
{ "type": "cpuStatsReset" }                                 // restart the CPU statistics
{ "type": "pause" }                                         // pause execution (time stands still)
{ "type": "continue" }                                      // continue
{ "type": "step", "count": 1 }                              // execute count instructions (1–10000), then pause;
                                                            //   if the CPU is sleeping (WFI): until the next interrupt
{ "type": "clearDiagnostics" }                              // clear the diagnostics list
{ "type": "scope", "sources": ["PD0", "PL0"] }               // oscilloscope: pins of this browser (max. 5, [] = off)
```

Push buttons: pressed = pin connected to GND (`activeLow`) or VCC, **released = pin open**
(`<port> ReleaseInput <pin>`). Without a pull-up in the firmware the pin then reads 0, and the
Diagnostics panel reports the floating input.

Server → browser:

```jsonc
{ "type": "hello", "experiment": {…}, "renode": "running", "leds": {"D1": false, …}, "fb": {…}, "pd": {…} }
{ "type": "leds", "states": { "D1": true, "D2": false, … }, "levels": { "LED1": 0.25 } }   // levels: only LEDs with PWM (0..1)
{ "type": "fb", "width": 128, "height": 64, "on": true, "invert": false, "data": "<Base64>" }
{ "type": "pd", "columns": 120, "periodUs": 100000, "phase": 4210, "leds": 62, "data": "<Base64>" }
{ "type": "pdev", "now": [t, phi, leds, periodUs], "ev": [[t, phi, leds, periodUs], …], "frozen": false }
{ "type": "uartconfig", "baud": 9600, "format": "7N1" }     // to everyone, after every change
{ "type": "signals", "signals": [{ "name": "uart0.tx", "label": "U0TX (PA1)", "idle": 1,
                                   "protocol": { "kind": "uart", "baud": 115107.914, "format": "8N1" } }, …] }
{ "type": "edges", "name": "uart0.tx", "now": 1100000, "level": 1,
  "edges": [[1000000, 0], [1008687, 1], …], "lost": 0 }        // lost only if > 0
{ "type": "reset" }                                        // a reset was triggered (to everyone)
{ "type": "sim",                                           // every 500 ms to clients with watch
  "experiment": { "id", "title" },
  "firmware": { "name": "TestUartCom.out", "size": 12596, "sha256": "2ae16a99b4cc9b4c", "loadedAt": 1794075220000 },
  "renode": { "version": "1.17.0", "startedAt": … },
  "time": { "virtualNs": 425424000, "wallMs": 6000, "speed": 0.98 },        // speed = simulated time / real time
  "cpu": { "state": "Running", "halted": false, "pc": "0x00000272", "symbol": "main", "sysclk": 16000000 },
  "resets": { "count": 1, "lastNs": 437400000 },
  "uart": { "mcu": { "baud": 9599.5, "format": "7N1" }, "terminal": { "baud": 9600, "format": "7N1" } },
  "warnings": [{ "level": "warning", "text": "uart0.host: Terminal: framing error …", "count": 3, "last": … }],
  "stopped": false,                                        // pause, single step, or a step waiting for an interrupt
  "frozen": false,                                         // simulated time stands still (pause, single step)
  "cpuStats": { "total": { "ns", "instr", "sleepNs", "isrNs", "normalNs", "isrCount", "wakes" },
                "recent": { … since the previous message … },
                "vectors": [{ "vector": 35, "name": "INT_TIMER0A", "count", "instr", "ns" }, …],
                "sleeping", "isrDepth", "nsPerInstr" },
  "regs": [{ "name": "R0", "value": 0 }, …, { "name": "xPSR", … }],    // core registers
  "disasm": [{ "addr": 2314, "bytes": "e672", "text": "b #-796" }, …], // only while paused
  "memory": { "request": "ticks", "symbol": "ticks", "addr": 536870916, "data": "0E000000…" },  // per client
  "periph": { "module": "UART0", "noClock": false, "regs": [{ "name": "UART0_FR_R", "addr": …, "value": 144 }, …] } }
{ "type": "simmeta", "modules": ["SYSCTL", "NVIC", "SysTick", "GPIO A", …, "I2C9"] }   // after watch
{ "type": "bcd", "digits": "--29", "enable": "01", "data": "29" }     // BCD display (Lab 1)
{ "type": "cio", "data": "<Base64>" }                                  // printf output (CCS console)
{ "type": "diag", "level": "warning", "message": "…", "count": 1 }    // warning/error from Renode
{ "type": "diagReset" }
{ "type": "scope", "now": 1234567000, "pins": ["PD0", "PL0"], "levels": [0, 1], "ev": [0, 1000, 1, …], "dropped": 0 }
{ "type": "renode", "state": "stopped" }
{ "type": "error", "message": "…" }
```

`hello` also contains `uartConfig: { baud, format }`, the current settings of the PC terminal.
`hello` also contains `bcd`, `cio` (printf output so far, Base64) and `diagnostics` (list). The
diagnostics collect every Renode log line with `[WARNING]`/`[ERROR]` of the running experiment;
identical messages are counted, at most 100.

`fb.data` is the frame buffer in SSD1306 page format, as it is seen on the display:
byte index = `page * width + x`, bit `y % 8` (bit 0 at the top).

`pd.data` is the pendulum image: first `columns` bytes for the swing left → right, then
`columns` bytes for right → left. Byte `c` belongs to angle segment `c` (0 = far left),
bit `n` = LED `n` (bit 0 at the top at the tip of the pendulum). `pd.phase` is the position of the
pendulum in 1/10000 of a half oscillation (0 = centre moving right, 5000 = far right, 10000 = centre
moving left, 15000 = far left), `pd.leds` is the LED state at the time of the query.

`pdev` contains every LED change since the last call with virtual time `t` (µs since start)
and phase `phi` (1/10000 half oscillation, continuous), plus the current state `now`. The model
remembers the changes (`GetEvents`), the backend fetches them with every poll (10/s). The frontend
uses them to replay rod, LEDs and light trail **delayed by about 300 ms, but exactly in time**:
between two data points the phase advances at `2/period`, and the LED state is valid until the
next change.

Renode advances the virtual time unevenly (measured: per 100 ms of wall-clock time between 0.3 and
150 ms; under load on average only 13–18 % of real time, in bursts). That is why the replay has its
own steady clock: a regression line of virtual time over wall-clock time of the last 3 s → base
speed; the distance to the target (behind the line, at least 300 ms of wall-clock time or 1.5 × the
largest lag of a burst) is smoothly compensated over ~1 s (at most ±25 %), speed changes are
smoothed over 150 ms, and shortly before the end of the data the replay slows down instead of
stopping. If the speed of the simulation differs from real time by more than 10 % (without load,
Renode often runs slightly faster), "Simulation: xx % of real time" is shown below the pendulum – the
pendulum on the screen then swings correspondingly slower or faster, but the timing inside the
firmware is still correct.
(Previously the time offset was adjusted abruptly with every message: at 2 Hz you saw jerky speed
changes; under load the rod mostly stood still and jumped, sometimes even backwards.) The image is
made only of the light trail: every LED that is on draws the arc it sweeps, and the trail fades
exponentially, so that it is below 5 % after the set **afterglow time** (slider 1 ms – 1 s, default
**1 s**, adjustable per experiment with `"afterglowMs"` in the experiment JSON; the time is virtual
time). With the default, a complete image is shown immediately, even if the simulation runs slower
than real time. With 10 ms you only see a short piece of trail behind the rod at any frequency; a
stationary image like for the eye appears at 10 Hz from about 50–100 ms. The view "Still image"
instead shows the image from `pd.data` (last swing per direction, without fading). The mapping of
virtual time → wall-clock time is updated continuously; if Renode restarts (time starts at 0), the
timeline is discarded.

### UART line as signal edges (signal stream)

UART0 does not transfer bytes but level changes with time stamps in **nanoseconds of virtual time**
(`sim/models/UartLine.cs`). The transmitter (`TivaUART`) computes the edge times from IBRD, FBRD,
LCRH, CTL.HSE and the UART clock (system clock from RSCLKCFG/PLLFREQ or PIOSC); every edge time is
rounded separately, so the bit spacing is correct to 1 ns. The receiver samples in the middle of
the bit, measured from the falling edge of the start bit and with **its own** baud rate:

- Microcontroller → PC: `UartHostTerminal` (settings in the UART monitor) decodes U0TX.
- PC → microcontroller: keyboard input is turned into edges on U0RX with the terminal settings;
  `TivaUART` decodes them with the settings of the firmware and reports FE/PE/BE in DR and RIS.

If the settings do not match, wrong characters appear as on real hardware (e.g. 7N1 firmware,
terminal 8N1: 0xC8/0x86 instead of "H"). Note, this is also realistic: if you change the settings
while the firmware is transmitting **without gaps**, the receiver can lock onto a wrong falling edge
and stay there (with "H" in 7N1 you then get invisible 0x06). The remedy is the same as in the lab:
restart the firmware. The terminal settings are set before the start (`$uartBaud`, `$uartFormat`
in the `.resc`), so the first characters arrive correctly.

**For the oscilloscope:** the backend only queries `GetEdges` while a browser has subscribed to a
line. Every `edges` message contains all level changes since the previous one; up to the time `now`
the line is completely known (constant `level` in between). Times are integers, strictly
increasing, every edge changes the level. On the first subscription old edges are discarded.
The model buffers up to 200 000 edges per line; how many of them were lost is given in `lost`.
Edge format at the Renode monitor: `SE:<name>:<now>:<level>:<baud>:<format>:<lost>:<t0>,<l>;<dt>,<l>;…`
(first time absolute, further ones relative). Lines are entered in the experiment JSON under `signals`.

### Reset button and simulation panel

The **Reset** button in the status bar corresponds to the reset button of the board:
`sysbus.sysctl ResetMcu` resets the CPU and all peripherals on the chip (everything that is directly
attached to the system bus). The firmware in flash stays, the CPU restarts via the vector table.
Devices outside the chip keep their state: PC terminal with its settings, sensor value, OLED,
pendulum, keypad, levels on GPIO inputs. A character that the UART is currently sending is aborted.
This also lets you resynchronise a receiver that has locked onto the wrong edge in a gap-less
character stream.

The **Simulation** button shows the simulation panel (off by default): loaded firmware (name, size,
SHA-256, time), CPU state with PC and function from the ELF file (note if the CPU is stuck in an
endless loop of the start-up code, e.g. `IntDefaultHandler`), system clock, number of resets,
simulated time, real time and speed (simulated time per real time), Renode version, UART0 settings
of firmware and terminal with the error. Below there are tabs:

- **CPU registers:** R0–R12, SP, LR, PC, xPSR (flags N Z C V, number of the running exception),
  PRIMASK, FAULTMASK, BASEPRI, CONTROL, inactive SP; changed values in yellow. While the simulation
  is paused, the next instructions from PC are shown next to it (disassembly from Renode).
- **Memory:** hex dump from an address or a symbol of the ELF file (e.g. `ticks`), only flash and
  SRAM; changed bytes in yellow.
- **Peripherals:** all registers of a module (SYSCTL, NVIC, SysTick, GPIO A–Q, UART0–7, TIMER0–7,
  I2C0–9) with the names from `tm4c1294ncpdt.h`, value in hex and binary. They are read **without
  side effects** (`sysbus.sysctl PeekRegisters`): UARTDR does not take a character from the FIFO,
  I2CMCS does not use up a BUSY, and a module without clock is shown instead of producing a warning.
- **Messages:** warnings and errors from the Renode log (e.g. framing errors, pin not configured as
  UART), identical messages are counted.

**Debugger** (at the top of the panel): **Pause** stops the whole simulation (simulated time stands
still), **Step** executes 1, 10, 100 or 1000 instructions and then pauses (`sysbus.sysctl StepCpu n`,
time advances meanwhile), **Continue** resumes. If the CPU sleeps with WFI, a step ends – as on the
board – only with the next interrupt: the whole simulation (timers, UART, pendulum, oscilloscope …)
keeps running until then; afterwards the CPU stands before the first instruction of the interrupt
routine. If this takes longer than about 1.5 s of wall-clock time, the panel shows "stepping until
the next interrupt" (state `Wake`); Pause and Continue abort it. Renode's own `cpu Step` only
advances one instruction time (≈ 91 ns) per step when the CPU is sleeping – more than 10 000 steps
would be needed to reach a 1 ms timer.
**CPU time** (overview and its own tab): share of the simulated time spent sleeping (WFI), in
interrupt routines and in normal operation – since start/reset and for the last query interval,
plus per interrupt the calls, time, share and instructions per call (`sysbus.sysctl GetCpuStats`,
names `INT_xxx` from the header). Renode counts a fixed instruction time per instruction
(1/`PerformanceInMips`, ≈ 91 ns): awake time = instructions × instruction time, sleep = the rest;
ISR = instructions from entry to return (for nested interrupts, each vector without the inner ones).
Register stacking on entry and flash wait states are not modelled – the values show ratios, not the
exact times of the board. A reset of the MCU or "Restart statistics" resets them.
Pause stops the pendulum immediately where it is currently shown (the display runs ~0.3 s behind
the CPU – no jump to the CPU time). The first single step then shows exactly the time of the CPU
(`pdev.frozen`), and so does every further one; after Continue the replay starts again from where
it stands. Reset while paused restarts the firmware and continues running.

### Oscilloscope

With the button **"〰 Scope"** at the top right of the header bar (on mobile: in the jump bar) an
oscilloscope is added as a panel – at the top of the display column, or as its own column if there
are no displays; like every panel it can be moved and collapsed (and hidden again; the state and all
settings are saved in the browser, the settings per experiment). It shows the digital signals at the
pins as 3.3 V logic with the usual grid (10 × 8 divisions, centre axes with fine divisions):

- **4 channels**: source via drop-down (first the named signals of the experiment, then all pins
  PA0…PQ4 by port), V/div (0.5–5 V), position. The mark on the left = 0 V line of the channel.
- **Time base** 1 µs/div to 1 s/div (1-2-5), the **trigger position** can be moved horizontally.
- **Trigger** on CH1–CH4 or an **external input** (any pin, not drawn),
  **level** 0–3.3 V, **rising/falling edge**, mode auto/normal/single, run/stop.
- A floating (high-impedance) pin appears dashed at half height.

How it works: the browser reports its sources (`scope`), the backend sets the union of the sources
of all browsers in Renode (`sysbus.scope Probe`) and fetches the level changes with every poll.
`ev` is flat `[i, dt, level, …]`: `i` = index in `pins`, `dt` = ns since the previous change
(for the first one: since start), level 0 = LOW, 1 = HIGH, 2 = floating. Triggering and drawing
happen in the browser on the virtual time; auto runs freely if there is no edge for 250 ms (virtual)
or two screen widths. At most 10 000 changes are transferred per query; if there are more (e.g. an
endless loop that toggles a pin, about 400 000 changes/s), the oldest ones are missing and the
oscilloscope reports "edges lost". Ports without a probe do not track levels – without the
oscilloscope the model costs no computing time (with a probe on a 400 kHz signal about 7 %).

Named signals per experiment in the experiment JSON:

```jsonc
"scope": {
  "signals": [ { "pin": "PD0", "label": "HC-SR04 trigger" }, … ],   // drop-down entries at the top
  "channels": ["PL0", "PM7", "PD0", "PD1"],                         // initial channels CH1..CH4
  "trigger": { "source": "PL0", "edge": "rising" }                  // channel pin or external pin
}
```

### Reconnect

All WebSockets in the frontend use `useReconnectingWebSocket`. If a connection breaks, the hook
reconnects with increasing intervals (300 ms to 5 s, with a random component). With code 4000
(intended restart), when you return to the tab, and when the network connection is restored, it
reconnects immediately.

---

## 4. Creating your own experiment

An experiment is **one file** `sim/experiments/<id>.json`. It lists the controls and devices and
defines the pins for each of them; the backend generates the Renode platform (`.repl`) and start
script (`.resc`) from it itself (`lib/experimentSpec.js`, stored in `GENERATED_DIR`). Put the file
there → the experiment appears in the selection list.

```bash
node tools/check_experiment.js my_experiment.json  # check (like the backend), exit code 1 on errors
node tools/check_experiment.js --types             # element types and terminals
```

Format, element types, check rules and an example: [EXPERIMENTS.md](EXPERIMENTS.md). The whole
procedure step by step (also with Docker and with a reference solution): [GUIDE.md, section 3](GUIDE.md#3-adding-a-new-experiment).

Invalid experiments are not shown, and the reason is in the server log. Renode paths, ports and
pins of the push buttons are never sent to the browser.

---

## 5. Operation

### Docker

```bash
cd webconsole
docker compose up --build            # -> http://localhost:3000
```

Pass the Git version for the About dialog (click on the HAW logo) – `.git` is not in the build
context; without these values the dialog shows "unknown":

```bash
GIT_COMMIT=$(git rev-parse HEAD) GIT_DATE=$(git log -1 --format=%cI) docker compose up --build
```

When building locally (`npm run build`/`npm run dev`), Vite reads the version directly from the
repository; uncommitted changes are shown as "+ local changes". The version number comes from
`webconsole/frontend/package.json`.

Or without Compose (the build context is the repository):

```bash
docker build -f webconsole/Dockerfile -t renode4mc-webconsole \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_DATE=$(git log -1 --format=%cI) .
docker run --rm --init -p 3000:3000 -p 3333:3333 -p 3334:3334 renode4mc-webconsole
```

The image installs Renode **1.17.0 portable**, the same version as in
[INSTALL_LINUX.md](INSTALL_LINUX.md), for amd64 and arm64. It runs as user `node` without root rights.

**`/tmp` must be executable.** On start-up Renode unpacks its CPU library to `/tmp` and loads it
from there. If you mount `/tmp` as tmpfs (as `docker-compose.yml` does), you need the option `exec`,
i.e. `--tmpfs /tmp:exec,mode=1777`. Otherwise Docker mounts tmpfs with `noexec`, and Renode aborts
while loading the platform with `failed to map segment from shared object`.

**Several students:** one container simulates exactly **one** instance. A new upload stops the
running simulation. For a course you therefore start one container per person or workstation,
e.g. with different host ports (`-p 3100:3000 -p 3433:3333 -p 3434:3334`). The frontend then
connects the WebSockets using `VITE_UART_WS_URL`/`VITE_CONTROL_WS_URL` (at build time), otherwise
using ports 3333/3334 on the same host.

### Without Docker (development)

Requirements: Node.js ≥ 18 and Renode (see [INSTALL_LINUX.md](INSTALL_LINUX.md), step 6).

```bash
cd webconsole/frontend && npm install && npm run build      # or: npm run dev (port 5173)
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start
```

### Environment variables (backend)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP |
| `UART_WS_PORT` / `CONTROL_WS_PORT` | 3333 / 3334 | WebSocket ports |
| `RENODE_BIN` | `renode` | Renode start program |
| `RENODE_HEADLESS_FLAG` | `--disable-gui` | in Renode 1.17 equivalent to `--disable-xwt` |
| `RENODE_MONITOR_PORT` / `RENODE_UART_PORT` | 1234 / 3335 | internal Renode ports (3335 is fixed in the generated `.resc`) |
| `RENODE_QUERY_PORT` | 1235 | query port (`TivaSysCtl.ServeQueries`, passed as `$queryPort`) |
| `RENODE_START_TIMEOUT_MS` | 60000 | time to wait for Renode at start |
| `RENODE_PERSISTENT` | `1` | `0`: a new Renode process for every start instead of permanent operation |
| `SIM_DIR` | `<repo>/sim` | simulator directory (working directory of Renode) |
| `EXPERIMENTS_SUBDIR` | `experiments` | experiments (`<id>.json`) relative to `SIM_DIR` |
| `GENERATED_DIR` | `<tmp>/renode4mc-experiments` | the backend stores the generated `.repl`/`.resc` here (writable) |
| `ELF_PATH` | `/tmp/app.elf` | where the uploaded firmware is stored |
| `PUBLIC_DIR` | `backend/public` | built frontend |
| `POLL_INTERVAL_MS` | 100 | OLED/LED polling |

**Note on port 3333:** `ucsim --debug` uses 3333 locally for the GDB server. There is no GDB server
in the container. If `ucsim --debug` and the web console run on the same computer at the same time,
map the web console to other host ports.

---

## 6. Tests

`webconsole/backend/test/e2e.js` checks the whole chain with a real Renode instance and the
Example 03 firmware: upload, UART output and echo, sensor → UART and LED D1, keypad "5" via the
matrix, USR_SW1 → LED D3, OLED frame.

> **Caution:** `e2e.js` loads experiment `example1` and checks OLED, MB1242 and keypad on port K – the
> earlier version. Since `example1` became "Simple elements" (section 2), these devices are missing
> there; the test only fits again when it loads an experiment with these devices (e.g. `webkonsole`
> from [GUIDE.md](GUIDE.md#31-creating-the-file)). `e2e_signals.js` also starts `example1` with the
> Example 03 firmware, but only checks UART edges.

```bash
cd webconsole/backend
npm start &                                                       # or the container
node test/e2e.js ../../examples/example03_webkonsole/example03_webkonsole.out
node test/e2e_example2.js ../../examples/example04_pendeldisplay/example04_pendeldisplay.out
node test/e2e_signals.js ../../examples/example03_webkonsole/example03_webkonsole.out
node test/e2e_scope.js ../../sim/solutions
node test/e2e_timer.js                                           # example3 + sim/solutions/example05_timer_ccp.elf
node test/e2e_labs.js <directory with lab01.out … lab04.out>
node test/e2e_step.js <schlaf_takt.elf>                           # test/firmware/schlaf_takt.c
node test/e2e_cpustats.js <schlaf_takt.elf> <schlaf_takt_ohne_wfi.elf>   # the second one with -DOHNE_WFI
node test/unit_pendulum_timeline.mjs                              # without backend/Renode
```

`test/e2e_step.js` checks pause and single step with a sleeping CPU (firmware
`test/firmware/schlaf_takt.c`: timer IRQ every 1 ms, a UART character every 10 ms, sync IRQ of the
pendulum, `main` only WFI): while paused everything stands still (time, variables, timer counter,
pendulum, oscilloscope, UART edges, terminal, key press). A step out of WFI stops at the entry of
the timer ISR (TAV freshly reloaded), interrupts in step mode exactly 1 ms apart, `Step 3` = exactly
3 instructions. Over ~120 ms in steps, timer ISR, D1 edges, UART characters (firmware = terminal),
sync ISR, PL0 edges on the oscilloscope and the pendulum phase must match the CPU time. Long sleep
(timer off, pendulum 0.1 Hz): state `Wake`, stop directly after the sync edge; pause during `Wake`,
and Continue does not stop again afterwards. `test/e2e_cpustats.js` checks the CPU statistics:
sleep + ISR + normal = period, calls per vector = counter of the firmware (timer, pendulum sync),
timer once per ms, ISR time = instructions × instruction time, > 99 % sleep with WFI, without WFI no
sleep and > 98 % normal operation, the statistics stand still while paused, a step in the ISR counts
exactly one instruction time as ISR, a reset of the MCU restarts them.
`test/unit_pendulum_timeline.mjs` checks the replay clock of the pendulum: pause immediately shows
the CPU time, steps are exact, after Continue no slow motion and no jump.

`test/e2e_signals.js` checks the signal stream: `signals` with the baud rate of the firmware, edges
strictly increasing and on the bit grid (8687.5 ns at 16 MHz, IBRD 8, FBRD 44), an independent
decoder in the test reads the same texts from them as the terminal, a key press as edges on
`uart0.rx`, terminal at 9600 → garbage, back at 115200 → readable.

`test/e2e_scope.js` checks the oscilloscope with the reference solutions (`sim/solutions`): pendulum
signal PL0 (period 120.000 ms), HC-SR04 trigger and echo (3790 µs at 65 cm, 450 µs after the edge),
floating pin, union of the sources of two browsers, UART frame `'#'` 9600 7N1 after SW1.

`test/e2e_timer.js` checks experiment `example3` with the demo `example05_timer_ccp` (timer compare
action, edge-time capture): on the oscilloscope LED1/PL4 with 25 % (8.333/25.000 ms) and 50 %
(16.666/16.667 ms), no edges at 0 %/100 %, LED2/PL6 100 ms HIGH every 1 s, dimmed brightness of
LED1 (average about 0.25) and a hard pulse of LED2, step LEDs, duration of key 0 via capture =
duration on the oscilloscope (also above 1.05 s with an overflow of the 24-bit counter), no diagnostics.

`test/e2e_labs.js` checks the four lab environments with their reference solutions, the diagnostics
and `POST /api/solution` (see [LABS.md](LABS.md)).

`test/e2e_example2.js` checks Example 2 with the Example 04 firmware: start message, measured
pendulum period (100.0 ms), sensor → UART and the pendulum image. For 42, 123 and 7 cm, each of the
40 image columns must show the right pattern at the right place in **both** swing directions.
Then the pendulum frequency is set to 15, 4, 25 and 10 Hz: the model must take it over,
the firmware must report the new period, and the image must still be correct to the column.

## Speed of the simulation

Renode keeps the simulation at most at real time (`AdvanceImmediately` off): pendulum and LEDs run
as fast as on the board. It becomes slower than real time when Renode needs more computing time
than is available (the CPU thread and the time source each occupy almost one core with a 10 µs
time slice). Measured (2 cores, test program `schlaf_takt` with a timer IRQ every ms, simulation
panel, oscilloscope and UART edges active): previously 0.16 × real time, now ≈ 1.0 ×. The bottlenecks
and what replaced them:

| Bottleneck (measured) | Replacement |
|---|---|
| Renode's `CreateServerSocketTerminal`: the read thread uses ~100 % CPU permanently while a client is connected | `UartHostTerminal.ServeTcp`: blocking reads, sending from its own thread, output before the connection is collected |
| the Telnet monitor writes answers character by character (one `sendto` each, ~14 000/s, ~70 % of a core) and every command costs ~10 ms | query port `TivaSysCtl.ServeQueries`: all queries of one round in one line, answer gzip+Base64 in one write; fallback `BatchZ` via the monitor or individual commands |
| the LED bridge wrote every level change into the socket in the CPU thread (1 kHz LED = 1000 writes/s) | sending collected every 20 ms from its own thread; short blinks stay visible (both changes) |

The queries still go through the monitor queue (never at the same time as monitor commands).
Programs that read peripheral registers all the time (polling) remain slower: every access costs
0.6–1 µs of computing time in Renode (measured: timer counter in a loop 0.4 ×, UART transmit 0.4 ×,
GPIO read 0.7 ×). A coarser time slice would gain about +25 % there, but would change the accuracy
(pendulum image, interrupt times) – so it was not implemented.

Measuring: `node test/perf_tempo.js <firmware.elf> [0|1 panel] [seconds] [experiment]` (backend running).

## 7. Known limitations

- **One simulation per container**, no user management, no authentication. For use on a network the
  container belongs behind a reverse proxy with login.
- **Timing:** Renode is not cycle-accurate (see [ROADMAP.md](ROADMAP.md)). UART0 transmits with
  baud-rate timing (edges correct to 1 ns), I2C without bus delay. The ultrasonic measurement is
  finished immediately. The RX time-out interrupt (RT) is simplified ("data available"), µDMA is missing.
- **Speed with wait loops on registers:** every register access costs some µs of computing time in
  Renode. A firmware that, for example, polls `UARTFR.TXFF` all the time at 9600 baud therefore runs
  slower than real time (display "Speed", about 0.2×). The simulated time stays exact.
- **HC-SR04** (Lab 2/3) has the timing behaviour of the real module; the measurement of the MB1242
  (I2C) is finished immediately.
- **OLED:** scrolling, contrast and display offset (`D3`) are not modelled. The display is updated
  10 times per second.
- **Pendulum display:** ideal sine oscillation with a fixed amplitude, without damping; the period
  only changes when you set it (abruptly at the next zero crossing).
  LEDs light up without afterglow, the display only shows the last swing per direction.
- **Oscilloscope:** only digital levels (0 V/3.3 V or floating), no rise times or analogue voltages;
  resolution 1 µs. UART pins show the edges of the UART line (correct to the ns, rounded to 1 µs).
  I2C pins show no bus activity (the I2C model does not drive any pins).
- **Push buttons do not bounce;** debouncing code cannot be tested in the simulator.
- **I2C:** master mode only, no FIFO/µDMA/burst. Received bytes are read from the device one by one.
- Tested with Renode 1.17.0 (portable, Linux x64), Chromium and Node.js 22: `test/e2e.js` (with the
  earlier version of `example1`), `test/e2e_example2.js` and operation in the browser, also with the
  directory layout of the image (`/opt/renode`, `SIM_DIR=/opt/renode4mc/sim`, user without root
  rights). The Docker image itself could **not be built** in the development environment (no access
  to Docker Hub) – please check this on the first `docker compose up --build`.
