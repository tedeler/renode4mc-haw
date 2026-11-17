# Web console (Docker)

With the web console you simulate the TM4C1294 in the browser. You upload the `.out` file built
by CCS and operate the hardware on a web page: depending on the experiment LEDs, push buttons,
UART terminal, OLED display, ultrasonic sensors, keypads, 7-segment display and pendulum display.
Renode, the models from `sim/` and the user interface run together in one container. There is no
compiler in it.

Step-by-step introduction (installation, operation, your own experiments): **[docs/GUIDE.md](../docs/GUIDE.md)**
Detailed description (architecture, protocols, operation, tests): **[docs/WEBCONSOLE.md](../docs/WEBCONSOLE.md)**

## Starting

```bash
cd webconsole
docker compose up --build
```

Then open **http://localhost:3000** in the browser.

1. Choose an **experiment** (e.g. "Simple elements"). The controls appear immediately as a preview.
2. Choose the **firmware**: the `.out` file from CCS (`Debug/<project>.out`) or from `make`.
3. Click **Start**. The control panel connects to the simulation (in less than 1 s; after the
   container has started, once about 10 s to compile the models), and the output of UART0 appears
   in the terminal.

To try it out: [Example 04 – Pendulum display](../examples/example04_pendeldisplay/README.md) with
experiment "Example 2", [Example 05 – Timer with CCP pins](../examples/example05_timer_ccp/README.md) with
"Example 3", the reference solutions of the labs with "Lab 1" … "Lab 4" (button **Reference solution**).
[Example 03 – Web console](../examples/example03_webkonsole/README.md) needs an OLED, an MB1242 and a keypad;
[docs/GUIDE.md, section 3](../docs/GUIDE.md#3-adding-a-new-experiment) shows the matching experiment.

| Control | Effect in the simulation |
|---|---|
| push buttons (e.g. USR_SW1/USR_SW2) | keep pressed → pin = LOW (with `activeLow`) |
| keypad | connects row and column of the matrix like the real wiring |
| slider | measured value of the ultrasonic sensor (HC-SR04 or MB1242) in cm |
| Reset | reset button of the board: the microcontroller restarts, the firmware and the devices outside the chip stay as they are |
| Simulation | shows the simulation panel: firmware, CPU state, simulated time and speed, UART settings; debugger (pause, single step, continue), CPU registers with disassembly, memory (address or symbol), peripheral registers with names from tm4c1294ncpdt.h, messages from Renode |
| terminal | keyboard input goes to UART0 RX, output of UART0 TX appears here. Below it the terminal settings (baud, data bits, parity, stop bits) as in Tera Term – if they do not match the firmware, wrong characters appear |
| LEDs, OLED | show the level of the LED pins (e.g. D1–D4 = PN1/PN0/PF4/PF0) or the image of the SSD1306 |
| oscilloscope | 〰 Scope: levels of up to 4 pins of the experiment with trigger and time base |
| pendulum display (Example 2) | swinging rod (pivot at the bottom) with the 8 LEDs on PM0–PM7 and their fading light trail; sliders for the pendulum frequency (0.1–20 Hz) and afterglow time (1 ms – 1 s); choice: both swings, one direction or still image |

## Folders

```
webconsole/
├── Dockerfile            multi-stage: build frontend, backend packages, Renode 1.17.0, runtime
├── docker-compose.yml    build context = repository (sim/ is copied into the image)
├── backend/              Node.js/Express (entry point server.js)
│   ├── server.js         HTTP: SPA, POST /upload, /api/*
│   ├── lib/
│   │   ├── config.js         environment variables
│   │   ├── experiments.js    load experiments (sim/experiments/<id>.json), store .repl/.resc
│   │   ├── experimentSpec.js check experiment files, generate Renode platform and start script
│   │   ├── renodeManager.js  start/stop the Renode child process, forward its log
│   │   ├── monitorClient.js  Telnet client for the Renode monitor (command queue)
│   │   ├── uartBridge.js     UART TCP ⇄ WebSocket :3333
│   │   └── controlBridge.js  monitor/LED bridge ⇄ WebSocket :3334 (JSON)
│   └── test/             e2e*.js against a real Renode (overview: docs/WEBCONSOLE.md, section 6)
└── frontend/             React (Vite)
    └── src/
        ├── hooks/useReconnectingWebSocket.js
        ├── context/ControlSocket.jsx
        ├── layout/          Workspace (column layout: collapse, move, width),
        │                    ScaleBox (displays adapt to the panel size)
        └── components/  SetupBar, ControlPanel, UartMonitor (xterm.js), Led, PushButton,
                         OledDisplay (canvas), DistanceSensor, Keypad (matrix mapping),
                         PendulumDisplay (canvas, afterglow image)
```

## Ports

| Port | Service |
|---|---|
| 3000 | web interface, upload |
| 3333 | UART WebSocket |
| 3334 | control WebSocket |

Internal, i.e. not exposed: 1234 (Renode monitor), 1235 (query port), 3335 (UART TCP), 9000 (LED bridge).

## Development without Docker

```bash
cd webconsole/frontend && npm install && npm run build
cd ../backend && npm install
RENODE_BIN=~/renode/renode PUBLIC_DIR=../frontend/dist npm start
# test (second terminal):
node test/e2e_example2.js ../../examples/example04_pendeldisplay/example04_pendeldisplay.out
```

All tests and their requirements: [docs/WEBCONSOLE.md, section 6](../docs/WEBCONSOLE.md#6-tests).

With `npm run dev` in the frontend folder, Vite runs on port 5173 and forwards `/upload` and `/api`
to port 3000.
