# Describing experiments (`sim/experiments/<id>.json`)

An experiment of the web console is **one JSON file** in `sim/experiments/`. It lists the controls
and devices (LEDs, push buttons, keypad, displays, sensors …) and defines for each of them **which
pins** of the TM4C1294 it is connected to. Nothing more is needed: put the file there and the
experiment appears in the selection list of the web console (after reloading the page). The file
name without `.json` is the experiment ID (letters, digits, `_`, `-`).

When the experiment is started, the backend generates the Renode platform (`.repl`: devices and
wiring) and the start script (`.resc`) from the file. Both are only stored in a temporary directory
(`GENERATED_DIR`, default `/tmp/renode4mc-experiments`) and are not edited by hand.

## Checking

```bash
node tools/check_experiment.js                       # all experiments in sim/experiments/
node tools/check_experiment.js my_experiment.json    # one file, also outside the repository
node tools/check_experiment.js --types               # element types, fields and terminals
node tools/check_experiment.js --repl --resc lab1_gpio   # show what is generated
```

The tool performs the same check as the backend (code: `webconsole/backend/lib/experimentSpec.js`)
and in addition: do the device models exist in `sim/models/`, and does the example of the reference
solution exist in `examples/`? Exit code 0 = valid (notes allowed), 1 = errors. An invalid experiment
does not appear in the web console; the reason is then in the server log.

Among other things, it checks:

| Error | Example |
|---|---|
| the pin does not exist on the chip | `PN7` (port N only has PN0–PN5), `PZ1` |
| the pin is used twice | `EN_R` and `D0` both on `PK0` |
| the pin is reserved | RX/TX of the terminal UART (default PA0/PA1), PC0–PC3 (JTAG), PB2/PB3 as soon as there is an I2C0 device |
| UART pin not possible | `"rx": "PK2"` (not a UxRx pin), `"rx": "PA4", "tx": "PA1"` (U3Rx and U0Tx – different UARTs) |
| terminal missing or unknown | `"EN"` instead of `"EN_L"` for the BCD display |
| unknown field, typo | `"colour"` instead of `"color"`, type `"pendel"` instead of `"pendulum"` |
| widget more than once | two sensors (the web console has one keypad, one 7-segment display, one pendulum, one OLED, one sensor) |
| I2C address used twice | two devices on `i2c0` with `0x70` |
| too many LEDs | more than 8 (the LED bridge has 8 inputs) |

Notes (not errors): the pin is already connected to an LED/push button on the board, PD7 is
protected (GPIOLOCK needed), the polarity of a push button does not fit its pull resistor, an
oscilloscope channel is on an unused pin.

## Structure

```jsonc
{
  "title": "My experiment",                // required: name in the selection list
  "description": "…",                      // optional
  "quantumUs": 10,                         // Renode time slice in µs (default 10; 100 = Renode default)
  "uart": {                                // PC terminal, optional (default: UART0 on PA0/PA1)
    "rx": "PA0", "tx": "PA1",             // pins of the UART, see "UART pins" below
    "baud": 115200, "format": "8N1",      // default settings of the terminal
    "label": "…", "localEcho": false, "crlf": false
  },
  "solution": { "example": "lab01_hexkeypad_bcd", "label": "Reference solution (…)" },   // optional
  "elements": [ … ],                       // required: controls and devices, see below
  "scope": {                               // oscilloscope, optional
    "channels": ["PM0", "PM4", "PL0", "PL1"],  // initial channels CH1..CH4 (default: the first 4 signals)
    "trigger": { "source": "PM0", "edge": "falling" },
    "timebaseUs": 20000,                   // initial time base in µs/div (1-2-5 sequence, 1 … 1000000; default 1000)
    "signals": [ { "pin": "PB0", "label": "my own name" } ]  // change/add labels
  }
}
```

Fields that start with `_` are comments and are ignored everywhere
(`"_pins": "LED0 is the topmost LED"`).

Always present (do not describe them): one UART with PC terminal (see "UART pins"), reset button,
simulation panel, debugger, oscilloscope. The oscilloscope group "Signals of this experiment" is
built from the pins of the elements; with `"labels": { "<terminal>": "text" }` in an element or with
`scope.signals` you can change the labels.

## Elements

Every element has a `"type"`. Elements with one pin have `"pin"`, elements with several terminals have
`"pins": { "<terminal>": "<pin>" }`. Pins are written as in the data sheet: `"PK0"`, `"PL1"`.

| Type | Device | Terminals | Fields (besides `type`, `pin(s)`, `labels`) |
|---|---|---|---|
| `led` | LED, HIGH = on (several allowed) | `pin` | `id` (required), `label`, `color` (`"#22c55e"`) |
| `button` | push button (several allowed) | `pin` | `id` (required), `label`, `activeLow` (default `true`: pressed = GND), `pull` (`"up"`, `"down"`, `"none"`) |
| `bcd` | 7-segment display with BCD inputs (HAW, Lab 1) | `D0`–`D7`, `EN_R`, `EN_L` | `label` |
| `hexkeypad` | HAW hex keypad 4×4 (active LOW, Lab 1) | `X1`–`X4` (columns, MCU outputs), `Y1`–`Y4` (rows, MCU inputs) | `title`, `label`, `layout`, `riseTimeUs` (default 20) |
| `keypad` | key matrix, active HIGH | `R0`… (rows, MCU outputs), `C0`… (columns, MCU inputs); number depends on `layout` | `title`, `label`, `layout` (default 4×3 telephone layout) |
| `pendulum` | LED pendulum / pendulum display | `LED0`–`LED7` (`LED0` = topmost LED at the tip), `SYNC` (MCU input) | `label`, `frequency`, `minFrequency`, `maxFrequency` (Hz, slider), `afterglowMs`, `syncMode` (`"position"`: HIGH = right; `"direction"`: HAW pendulum, HIGH = swing to the right), `periodUs`, `columns` |
| `hcsr04` | ultrasonic sensor HC-SR04 (Lab 2/3) | `TRIG` (MCU output), `ECHO` (MCU input) | `initial` (cm), `min`, `max`, `unit`, `title`, `label` |
| `mb1242` | ultrasonic sensor MaxBotix MB1242, I2C | – | `bus` (default `"i2c0"`), `address` (default `"0x70"`), `initial`, `min`, `max`, `unit`, `title`, `label` |
| `oled` | OLED SSD1306, I2C | – | `bus` (default `"i2c0"`), `address` (default `"0x3C"`), `width`, `height`, `label` |
| `cio` | printf() console as in CCS | – | `label` |

### UART pins

The PC terminal is connected to the UART that `uart.rx` and `uart.tx` belong to. Which pins a UART
can use is defined by the chip (data sheet table 10-2, GPIOPCTL function 1 for all of them):

| UART | RX | TX |
|---|---|---|
| UART0 | PA0 | PA1 |
| UART1 | PB0, PQ4 | PB1 |
| UART2 | PA6, PD4 | PA7, PD5 |
| UART3 | PA4, PJ0 | PA5, PJ1 |
| UART4 | PA2, PK0 | PA3, PK1 |
| UART5 | PC6 | PC7 |
| UART6 | PP0 | PP1 |
| UART7 | PC4 | PC5 |

RX and TX must belong to the same UART, but may be on different ports (e.g. UART2:
RX PA6, TX PD5). The firmware must configure exactly these pins (GPIOAFSEL, GPIODEN, GPIOPCTL = 1)
and enable the clock of the UART; otherwise nothing arrives, as on the board, and the Diagnostics
panel reports it. On the EK-TM4C1294XL only UART0 (PA0/PA1) is connected to the virtual COM port –
for a different UART, real hardware needs a USB-to-serial adapter (the check tool gives a note).
In the simulator: `sysbus.uart3 SetPins "PJ1" "PJ0"` (TX, RX), query with `sysbus.uart3 Pins`.

```json
"uart": { "rx": "PJ0", "tx": "PJ1", "baud": 9600, "format": "8N1" }
```

### Timer pins (CCP)

A timer can drive a pin itself (compare action, PWM) or measure edges on it (capture).
No special element is needed for this: an `led` or a `button` on a CCP pin is enough; the
firmware switches the pin to the timer with GPIOAFSEL = 1, GPIODEN = 1 and GPIOPCTL = 3. Possible pins
(data sheet table 13-2):

| Timer | CCP0 (timer A) | CCP1 (timer B) |
|---|---|---|
| Timer 0 | PD0, PA0, PL4 | PD1, PA1, PL5 |
| Timer 1 | PD2, PA2, PL6 | PD3, PA3, PL7 |
| Timer 2 | PA4, PM0 | PA5, PM1 |
| Timer 3 | PA6, PM2, PD4 | PA7, PM3, PD5 |
| Timer 4 | PM4, PB0, PD6 | PM5, PB1, PD7 |
| Timer 5 | PM6, PB2 | PM7, PB3 |

Timers 6/7 have no CCP pins in the 128-pin package. The web console shows an LED on a PWM pin
dimmed (average brightness as seen by the eye). Example: `example3` with `examples/example05_timer_ccp`.
In the monitor: `sysbus.timer0 CcpPins` shows which pins a timer currently uses and their level.

### Pull resistors

`"pull": "up"` for a push button means a resistor **on the board**: when released, the pin reads
HIGH even if the firmware does not set GPIOPUR, and there is no warning "floating input". Without
`pull` (like USR_SW1/2 on the EK-TM4C1294XL) the firmware must switch on the internal pull-up –
otherwise the simulator reports it. A pull resistor set by the firmware in the opposite direction
takes precedence. In the model: `TivaGPIOPort.ExternalPullUp` / `ExternalPullDown` (bit mask per port).

The pull resistors of the keypads (`hexkeypad`: pull-up of the rows, `keypad`: pull-down of the
columns) are part of the device model and are not specified.

## Example

```json
{
  "title": "My experiment: counter on the 7-segment display",
  "quantumUs": 10,
  "uart": { "baud": 115200, "format": "8N1" },
  "elements": [
    { "type": "bcd", "label": "D0–D7 = PK0–PK7, EN right = PL0, EN left = PL1",
      "pins": { "D0": "PK0", "D1": "PK1", "D2": "PK2", "D3": "PK3",
                "D4": "PK4", "D5": "PK5", "D6": "PK6", "D7": "PK7",
                "EN_R": "PL0", "EN_L": "PL1" } },
    { "type": "button", "id": "T1", "label": "Count (PE1)", "pin": "PE1", "pull": "up" },
    { "type": "led", "id": "L1", "label": "Overflow (PE0)", "color": "#ef4444", "pin": "PE0" },
    { "type": "cio" }
  ],
  "scope": { "channels": ["PE1", "PL0", "PK0", "PE0"], "trigger": { "source": "PE1", "edge": "falling" } }
}
```

The existing experiments (`example1` … `example3`, `lab1_gpio` … `lab4_uart`) are also good templates.
The board LEDs D1–D4 (PN1, PN0, PF4, PF0) and push buttons USR_SW1/2 (PJ0, PJ1) are normal `led` and
`button` elements; an experiment without them does not show them.

## Starting without the web console

```bash
node tools/check_experiment.js --out /tmp/v lab1_gpio
cd sim && renode --console -e "\$elf=@../sim/solutions/lab01_hexkeypad_bcd.elf; s @/tmp/v/lab1_gpio.resc"
```

## Adding a new device type

A new type needs a C# model (`sim/models/`), an entry in the catalogue `TYPES` in
`webconsole/backend/lib/experimentSpec.js` (terminals with direction and index, constructor
parameters, widget settings) and – for a new widget – a query/command in `lib/controlBridge.js` and
the component in the frontend (`ControlPanel.jsx`). The check tool then knows the new type
automatically.
