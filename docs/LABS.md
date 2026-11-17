# Lab sessions in the simulator (Lab 1–4)

For every lab session of the microcontroller lab, the [web console](WEBCONSOLE.md) has its own
environment with the peripherals from the lab instructions. Each comes with a reference solution
for comparison. The other experiments of the web console (`example1`–`example3`) and the examples
`example01`–`example05` are independent of this.

| Environment (`sim/experiments/`) | Lab instructions | Peripherals | Reference solution |
|---|---|---|---|
| `lab1_gpio` | MCL Lab Session 1 (CCS, GPIO) | hex keypad 4×4, 7-segment/BCD display, LEDs, push buttons | `lab01_hexkeypad_bcd` |
| `lab2_pendel` | Exercise 6 "LED pendulum with ultrasonic module" | LED pendulum (HAW), HC-SR04 | `lab02_led_pendel` (polling) |
| `lab3_nvic` | "Nested Vectored Interrupt Controller" | as Lab 2, all timer interrupts | `lab03_nvic_pendel` (interrupts only, several files) |
| `lab4_uart` | "Controlling a microcontroller with the PC via UART" | UART0 terminal 9600 7N1, LEDs D1–D4, USR_SW1 | `lab04_uart_leds` |

Every environment also has:

- **CCS console (printf):** `printf()`/`puts()` appear as in Code Composer Studio. For this, the
  TI run-time library writes a message into `_CIOBUF_` and passes the label `C$$IO$$`.
  On the board, the debugger stops there; in the simulator, `sim/models/TiCioConsole.cs` handles
  it via a Renode hook. For `printf()` the project needs a heap (`--heap_size=2048`, as described
  in Lab 4).
- **Diagnostics:** every warning of the models appears in the web console, as does every warning
  and error from Renode. This mainly concerns register misconfigurations (see below).
  On the board the program would simply not work in these cases. The simulator also tells you why.
- **Starting the reference solution:** a button in the header bar loads the reference solution
  instead of your own `.out`. This way students can see how the finished program is supposed to
  behave. Next to the experiment title the badge "Reference solution" is shown.

## The environments in detail

The pins are one possible wiring according to the figures in the lab instructions. If you wire
differently, you only change the pins in the experiment file `sim/experiments/<id>.json`
([EXPERIMENTS.md](EXPERIMENTS.md)) and check them with `node tools/check_experiment.js`.

### Lab 1 – hex keypad and BCD display

| Component | Pins | Model |
|---|---|---|
| hex keypad 4×4 (keys 0–F, layout as in figure 1) | columns X1–X4 = PM0–PM3 (outputs), rows Y1–Y4 = PM4–PM7 (inputs) | `HexKeypad` |
| 7-segment display, 2 modules × 2 digits (8421 BCD) | D0–D7 = PK0–PK7, EN right (digits 1/0) = PL0, EN left (digits 3/2) = PL1 | `BcdDisplay` |

- **Keypad:** the firmware sets one column after the other to 0. A pressed key then pulls its
  row to 0; otherwise the 100 kΩ pull-up of the keypad keeps the row at 1 (figure 2).
  **Propagation delay:** the change 0 → 1 of a row takes `riseTimeUs` = 20 µs, because only the
  weak pull-up charges the line. If the firmware reads immediately after switching, without `wait()`,
  it still sees the level of the previous column. Then wrong keys or several keys appear, just as
  on the board.
- **BCD display:** as long as EN = 1, the module takes over D0–D7. With EN = 0 it holds the value
  (figure 4). It shows A–F like a hex decoder. Before the first take-over a module stays dark.

### Lab 2 and Lab 3 – LED pendulum and HC-SR04

| Component | Pins | Model |
|---|---|---|
| LED pendulum "Swinging LED", pivot at the bottom | LEDs PM0–PM7 (HIGH = on), **LED 7 = PM7 is the topmost one** | `PendulumDisplay` with `syncMode: "direction"` |
| signal R/L | PL0: **rising edge = left turning point, falling edge = right turning point** (HIGH during the swing left → right) | |
| ultrasonic HC-SR04 | trigger = PD0, echo = PD1 | `HcSr04` |

- **Pendulum:** it is the same model and widget as in Example 2 / Example 04, only with the signal
  from the lab instructions (figure 2). It swings at about 8.3 Hz, i.e. about 60 ms per swing. In the
  browser the frequency can be set from 2 to 15 Hz; on the board it is fixed. Frequency changes take
  effect from the next turning point.
  The display starts with 8.3 Hz and 1 s afterglow, so a complete image is shown right away.
  Measured in the test environment (2 cores): Lab 3 shows the image immediately. Lab 2 needs about 5 s,
  because during the first seconds Renode only reaches about 5 % of real time with the polling
  firmware. A lower frequency delays the first image even more, because the firmware first has to
  measure a swing.
- **HC-SR04:** the falling edge on the trigger starts a measurement (figure 5). Echo goes HIGH about
  450 µs later, for 58.3 µs per cm (speed of sound 343 m/s, there and back). Outside 3–300 cm,
  echo stays HIGH for 200 ms (instructions NVIC, table 2.1). While a measurement is running, the
  module ignores further triggers.
- **Lab 3:** the set-up is the same. GPIO interrupts exist for port D (IRQ 3), port L (IRQ 53)
  and port J (IRQ 51), timer interrupts for timers 0–7.

### Lab 4 – UART

UART0 on PA0/PA1. The terminal in the browser is set up like Tera Term in the lab instructions:
9600 bit/s, 7N1, local echo, a received CR starts a new line. In addition there are the LEDs D1–D4
(PN1, PN0, PF4, PF0) and USR_SW1/2 (PJ0/PJ1, switching to GND).

## Strict checking of the registers (according to data sheet SPMS433)

The models reproduce the data sheet exactly and report misconfigurations in the Diagnostics panel.
Errors are not silently "repaired":

| Area | Behaviour as on the chip | Message |
|---|---|---|
| GPIO | an input with `DEN = 0` reads 0; an output without `DEN` does not drive the pin | "PM4 is read as an input, but GPIODEN = 0 …" |
| GPIO | a floating input (nothing connected, push button released, no PUR/PDR) reads 0 | "PJ0 is a floating input …" (when it is read, or when its interrupt is enabled) |
| GPIO | setting PDR clears PUR and vice versa; PC0–3, PD7, PE7 can only be changed with GPIOLOCK/GPIOCR | "… is protected (JTAG/NMI) …" |
| GPIO | interrupt enabled, but `DEN = 0` | "… no interrupt will ever occur" |
| Timer | TnR/TnV as in table 13-4 (counting down: true prescaler, counting up: linear extension), reset values, TnILD | configuration while the timer is running (except TCACT), reserved/unmodelled modes (edge count, RTC), CCP mode without a CCP pin (PCTL = 3), ILR > 16 bit, prescaler > 8 bit, start with ILR = 0 |
| UART | IBRD/FBRD only take effect after LCRH is written; only WLEN data bits; without AFSEL/PCTL/DEN on PA0/PA1 no character | "UART0: transmitting, but PA1 is not configured as U0TX (GPIOAFSEL, GPIODEN, GPIOPCTL = 1)" |
| UART | the line carries signal edges; the PC terminal samples them with **its own** settings. If baud rate/format do not match (more than 2.5 % off), garbage or nothing at all arrives, as on the board (e.g. 115200 to a 9600 terminal: start bits that are too short are discarded) | "the firmware is set to 115108 baud 8N1 …, the terminal expects 9600 baud 7N1", possibly also "Terminal: framing error …" |
| UART | characters from the terminal arrive at the speed of the line (9600 bit/s 7N1: about every 0.94 ms), framing/parity errors in DR/RSR, overrun when the FIFO is full | "receive FIFO full …" |
| all | access without clock (RCGC*) is ignored | "access … without clock! …" |

Push buttons in the web console: pressed connects the pin to GND. Released, the pin is **open**
(floating); only a pull-up set by the firmware then keeps it at 1. This applies to all experiments.
The examples example03/example04 set the pull-up and run unchanged.

## Reference solutions

The sources of the reference solutions Lab 1–4 are in the **private** repository
[haw-mc-labsolutions](https://github.com/tedeler/haw-mc-labsolutions), included as the submodule
`solutions/` (per lab `solutions/labs/<lab>/code/`, plus the lab instructions in `doc/`). Anyone
without access (students, forks) gets an empty `solutions/` – without an error message, because the
submodule is entered in `.gitmodules` with `update = none`. The web console still works completely:
the reference solutions are included as ready-made ELF files in `sim/solutions/` (checked in,
without debug info; the symbols for the simulation panel are kept).

**Teaching staff** fetch the submodule explicitly:

```bash
git submodule update --init --checkout solutions
git config submodule.solutions.update checkout    # from now on, update it with "git submodule update"
```

For CCS and the board you build a solution like the examples: `make` in `solutions/labs/<lab>/code`
(TI Arm Clang, otherwise gcc, see `tools/tm4c.mk`) or `tools/ccs-import.sh solutions/labs/<lab>/code`.
The web console loads gcc builds from `sim/solutions/<example>.elf`:

```bash
tools/build-solutions.sh                               # arm-none-eabi-gcc from PATH
CC=/path/arm-none-eabi-gcc tools/build-solutions.sh
```

The script always builds `example05_timer_ccp` from `examples/`, and the lab solutions only if their
sources are in `solutions/`; then it replaces the ELF files in `sim/solutions/`. After changing a
solution, the ELF files and the new submodule state belong in the same commit:

```bash
(cd solutions && git switch main && git pull)          # or change, commit and push there
tools/build-solutions.sh
git add solutions sim/solutions && git commit -m "Reference solutions updated"
```

The Docker image does the same (stage `solutions` in `webconsole/Dockerfile`, Debian package
`gcc-arm-none-eabi`): with the submodule checked out from the sources, otherwise with the ready-made
ELFs. The sources are only read via a bind mount and end up in no image layer. Instead of the TI
run-time library, the gcc build uses newlib.
`tools/gcc/cio_gcc.c` sends `printf()` over the same CIO protocol, so the output also appears in the
CCS console. Which reference solution belongs to which experiment is written in the experiment JSON:
`"solution": { "example": "lab01_hexkeypad_bcd", "label": "…" }`.

## Oscilloscope

In all environments you can show an oscilloscope in the web console (see
[WEBCONSOLE.md](WEBCONSOLE.md#oscilloscope)). The drop-down lists offer the signals of the
experiment by name, e.g. Lab 2/3: pendulum R/L (PL0), pendulum LEDs (PM0–PM7), HC-SR04 trigger (PD0)
and echo (PD1); Lab 1: keypad X/Y (PM0–PM7), BCD D0–D7 (PK0–PK7), EN (PL0/PL1); Lab 4: U0RX/U0TX
(PA0/PA1) with the bit stream at 9600 bit/s 7N1 – a wrongly set baud rate can be seen from the
bit width.

## Tests

```bash
cd webconsole/backend && npm start &
# build the reference solutions and deliberately wrong variants into /tmp/fw/out (see the top of e2e_labs.js)
node test/e2e_labs.js /tmp/fw/out              # ONLY=lab1,lab4,solution for a subset
```

`test/e2e_labs.js` checks every environment with its reference solution:

- keypad with printf (requirements 1 and 2) and BCD display
- HC-SR04 at 42/123/330/7 cm with printf
- the pendulum image column by column in the swing left → right, also at 5 Hz
- UART commands, LEDs, `#13<CR>` on SW1 and abort on a syntax error
- that the Diagnostics panel stays empty with correct firmware
- that it reports: PM4 without DEN, missing `wait()`, wrong baud rate (no ">" in the terminal, diagnostic message), PJ0 without pull-up
- starting all reference solutions via `POST /api/solution`

## Limitations

- **Not tested:** programs built with tiarmclang and the TI run-time library itself (only gcc
  with a re-implemented CIO protocol), the Docker image (no Docker daemon in the test environment)
  and real hardware.
- `scanf()` reads nothing in the simulator (CIO read returns end of file).
- Timer: input edge-count and RTC are not modelled (compare action, PWM, input edge-time on the
  CCP pins and the match event TnMIE/TnMRIS in one-shot/periodic mode are, see
  `example05_timer_ccp`). `lab03_nvic_pendel` measures the echo with a GPIO interrupt on both edges
  and a free-running timer; edge-time capture on a CCP pin would work as well. If the firmware uses
  a mode that is not modelled, the Diagnostics panel reports it.
- Access without clock does not cause a bus fault in the simulator as it does on the board, but it
  is reported.
- Times are exact to one Renode quantum (10 µs in the lab environments); the oscilloscope records
  level changes made by the firmware with 1 µs resolution. Busy-wait programs run slower than real
  time in the simulation, but the virtual time is still correct.
