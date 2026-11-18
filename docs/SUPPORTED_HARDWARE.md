# Supported hardware

This document lists what the simulator models of the **TM4C1294NCPDT** (board **EK-TM4C1294XL**) and
where the simulation differs from the real chip. The platform is described in
[`sim/platforms/tm4c1294ncpdt.repl`](../sim/platforms/tm4c1294ncpdt.repl); the peripheral models are
in [`sim/models/`](../sim/models). Addresses, clock bits and IRQ numbers are taken from
`common/tm4c1294ncpdt.h` and are checked with `python3 tools/check_header.py`.

Reference: data sheet TM4C1294NCPDT (SPMS433). Chapter numbers below refer to it.

**Rule of thumb:** everything that the labs need (clock gating, GPIO, timers, UART, interrupts) behaves
like the data sheet at register level. The simulator is **not cycle-accurate**, and it does not
model the analogue side, the bus fabric or most of the "big" peripherals (ADC, SSI, USB, Ethernet, …).
Where the firmware uses something that is not modelled or is misconfigured, the models print a warning
(web console: panel **Diagnostics**) instead of failing silently – on the board the program would simply
not work.

## 1. Platform `tm4c1294ncpdt.repl`

| Component | Renode name | Address | Model | Notes |
|---|---|---|---|---|
| CPU Cortex-M4F (with FPU) | `cpu` | – | Renode `CPU.CortexM` | `PerformanceInMips: 11` (≈ 16 MHz / 1.5 clocks per instruction) |
| NVIC + SysTick | `nvic` | `0xE000E000` | Renode `IRQControllers.NVIC` | `systickFrequency: 16000000` |
| Flash 1 MB | `flash` | `0x00000000` | Renode `Memory.MappedMemory` | loaded from the `.out`/ELF file |
| SRAM 256 KB | `sram` | `0x20000000` | Renode `Memory.MappedMemory` | |
| Bit-banding peripherals | `bbPeripherals` | `0x42000000` (32 MB) | Renode `Miscellaneous.BitBanding` | alias of `0x40000000…` |
| Bit-banding SRAM | `bbSram` | `0x22000000` (2 MB) | Renode `Miscellaneous.BitBanding` | alias of `0x20000000…` |
| System control (SYSCTL) | `sysctl` | `0x400FE000` | `TivaSysCtl.cs` | clock gating, system clock, IDs |
| GPIO ports A–H, J–N, P, Q (15 ports) | `gpioA` … `gpioQ` | `0x40058000` … `0x40066000` (AHB) | `TivaGPIOPort.cs` | |
| General-purpose timers 0–7 | `timer0` … `timer7` | `0x40030000` … `0x40035000`, `0x400E0000`, `0x400E1000` | `TivaTimer.cs` | |
| UART 0–7 | `uart0` … `uart7` | `0x4000C000` … `0x40013000` | `TivaUART.cs` (+ `UartLine.cs`) | UART0 = virtual COM port of the board |
| I2C 0–9 | `i2c0` … `i2c9` | `0x40020000` … `0x40023000`, `0x400C0000` … `0x400C3000`, `0x400B8000`, `0x400B9000` | `TivaI2C.cs` | master only |
| Oscilloscope (simulator only) | `scope` | `0xF0001000` (placeholder) | `Oscilloscope.cs` | not part of the chip, used by the web console |

Clock after reset: PIOSC = 16 MHz. The main oscillator (MOSC) of the board is set to 25 MHz.

### Interrupt assignment

`nvic@N` in the `.repl` file is the IRQ number, i.e. `INT_<name> − 16` (the `INT_` constants of the
header count the vector table entries).

| Peripheral | IRQ number(s) |
|---|---|
| GPIO A, B, C, D, E | 0, 1, 2, 3, 4 |
| GPIO F, G, H | 30, 31, 32 |
| GPIO J, K, L | 51, 52, 53 |
| GPIO M, N | 72, 73 |
| GPIO P, Q | **not connected** (see 3.2) |
| Timer 0A/0B, 1A/1B, 2A/2B | 19/20, 21/22, 23/24 |
| Timer 3A/3B, 4A/4B, 5A/5B | 35/36, 63/64, 65/66 |
| Timer 6A/6B, 7A/7B | 98/99, 100/101 |
| UART 0, 1, 2, 3–7 | 5, 6, 33, 56–60 |
| I2C 0, 1, 2, 3 | 8, 37, 61, 62 |
| I2C 4, 5, 6, 7, 8, 9 | 70, 71, 102, 103, 109, 110 |
| SysTick | exception 15 (Renode NVIC) |

## 2. Modelled peripherals

### 2.1 CPU, NVIC, memory (Renode built-ins)

**Modelled:** Cortex-M4F instruction set including FPU, NVIC with priorities, SysTick, flash and SRAM
with the sizes of the TM4C1294NCPDT, bit-banding for peripherals and SRAM (driverlib uses it, e.g. in
`SysCtlPeripheralEnable`).

**Limitations compared with the real hardware:**

- **Not cycle-accurate.** Renode counts instructions, not clock cycles. Every instruction takes
  1/`PerformanceInMips` ≈ 91 ns. Busy-wait loops (`for(i = 0; i < 5000000; i++)`, `SysCtlDelay`) only
  take roughly as long as on the board, pipeline effects, flash wait states and bus contention do not
  exist. Time measurement with timers or SysTick is reliable.
- **The CPU speed does not follow the system clock.** If the firmware switches to the PLL
  (e.g. `SysCtlClockFreqSet(120 MHz)`), the CPU in the simulator still executes about 11 million
  instructions per second.
- **SysTick** counts at a fixed 16 MHz. On the board the clock source depends on `STCTRL.CLK_SRC`
  (system clock or PIOSC/4). SysTick has not yet been tested systematically
  ([ROADMAP.md](ROADMAP.md), M2).
- **Flash** is plain memory: there is no flash controller (no erase/program via `FMA`/`FMD`/`FMC`,
  no protection), and writes to the flash area do not cause a fault.
- **No ROM** at `0x01000000`: `ROM_*` functions of TivaWare do not exist in the simulation – link
  driverlib from flash instead.
- **Accesses to addresses without a model** (e.g. ADC, SSI) do not cause a bus fault; Renode logs them
  and reads 0.
- Low-power modes: `WFI` is supported (the CPU sleeps until the next interrupt, the web console shows
  awake/sleeping time). Sleep and deep-sleep clock gating (`SCGC*`/`DCGC*`) are only stored.

### 2.2 System control – `TivaSysCtl.cs`

**Modelled:**

- Clock gating: `RCGC*` (run mode), `SCGC*`/`DCGC*` (stored), `PR*` (peripheral ready).
- System clock calculated from `RSCLKCFG`, `PLLFREQ0`, `PLLFREQ1` (sources PIOSC 16 MHz, MOSC 25 MHz,
  LFIOSC, RTC oscillator); it is used e.g. for the UART baud rate.
- `PLLSTAT.LOCK` and `RIS.PLLLRIS`/`MOSCPUPRIS` always read as 1, so that `SysCtlClockFreqSet()` does
  not hang.
- Identification `DID0`/`DID1` (TM4C129, revision A2).
- Reset push-button of the board (`sysbus.sysctl ResetMcu`): resets the CPU and all on-chip
  peripherals, keeps the flash contents.
- All other SYSCTL registers are stored and read back without a function.

**Limitations:**

- **`PR*` is set immediately** together with `RCGC*`. On the board it takes a few clock cycles, so a
  missing wait loop on `PRGPIO`/`PRTIMER`/… is not noticed in the simulator.
- **Access to a peripheral without its clock:** reads return 0, writes are ignored and a warning is
  printed. On the board this causes a **bus fault** (`FaultISR`).
- **The PLL locks immediately**; `MEMTIM0` (flash/EEPROM wait states) has no effect.
- The calculated system clock is only used by the UART. CPU, SysTick and timers keep running at their
  fixed rates (see 2.1 and 2.4).
- Reset cause (`RESC`) is only stored; no brown-out, no watchdog reset, no MOSC failure detection.

### 2.3 GPIO ports A–Q – `TivaGPIOPort.cs` (data sheet chapter 10)

**Modelled:**

- `GPIODATA` with address mask (bits 9:2 of the address select the pins), `GPIODIR`, `GPIOAFSEL`,
  `GPIODEN`, `GPIOPUR`/`GPIOPDR` (setting one clears the other).
- Interrupts: `GPIOIS`, `GPIOIBE`, `GPIOIEV`, `GPIOIM`, `GPIORIS`, `GPIOMIS`, `GPIOICR` (edge and level).
- `GPIOLOCK`/`GPIOCR`: commit protection of PC0–3 (JTAG/SWD), PD7 and PE7.
- Data sheet behaviour of the input: an input is only read with `DEN = 1`; an input that nobody
  drives and that has no pull-up/pull-down reads as 0.
- A pin only drives as an output with `DIR = 1`, `DEN = 1`, `AFSEL = 0`. With `AFSEL = 1` and the
  right `GPIOPCTL` value a peripheral model can take the pin over (UART TX/RX, timer CCP).
- Resistors on the board (e.g. the pull-ups of buttons) are set by the experiment.
- Strict checks (warnings): input read with `DEN = 0`, floating input read, output written with
  `DEN = 0`, interrupt enabled with `DEN = 0`, protected pin changed without unlock.

**Limitations:**

- **Ports P and Q have no interrupt.** On the chip each of their pins has its own interrupt
  (`INT_GPIOP0…7`, `INT_GPIOQ0…7`); the port model has only one IRQ output, so these are not
  connected.
- **Only digital levels**: 0, 1 or "floating". No voltages, no rise times, no drive strength
  (`GPIODR2R/4R/8R/12R`), no open-drain (`GPIOODR`), no analogue mode (`GPIOAMSEL`), no slew rate –
  these registers are only stored.
- A floating input reads as a deterministic 0; on the board it is undefined.
- `GPIOPCTL` is only evaluated by the peripherals that use pins (UART, timer CCP). All other
  alternate functions (SSI, I2C, PWM, …) have no effect on the pins.
- No `GPIOADCCTL`/`GPIODMACTL` (ADC/µDMA trigger), no `GPIOSI` (summary interrupt for P/Q),
  no wake-up from hibernation.
- Push buttons in the web console do not bounce, so debouncing code cannot be tested.

### 2.4 General-purpose timers 0–7 – `TivaTimer.cs` (data sheet chapter 13)

**Modelled (per half A/B):**

- `GPTMCFG = 0x0` (32 bit, timer A only) and `0x4` (16 bit, A and B separately).
- One-shot and periodic mode, counting down and up (`TnCDIR`), 16-bit prescaler (`TnPR`) as in
  table 13-4, `TnR`/`TnV`, reload behaviour with `TnILD`, match (`TnMIE`/`TnMRIS`, `TnMRSU`).
- Timer compare action on the CCP pin (`TCACT`).
- PWM mode (16 bit, 24-bit counter `TnPR:TnILR`, `TnPWML`, `TnPLO`, PWM interrupts with `TnEVENT`).
- Input edge-time capture (16 bit, `TnMR = 0x3`, `TnCMR = 1`) on the CCP pin.
- Interrupts `GPTMIMR`/`RIS`/`MIS`/`ICR` (time-out, match, capture event), `TnCINTD`.
- CCP pins as in table 13-2 (`GPIOPCTL = 3`), found automatically.
- Clock gating via `RCGCTIMER`.
- Strict checks (warnings): configuration changed while the timer runs, reserved or unmodelled modes,
  values too large for 16-bit mode, timer started with `TnILR = 0`, CCP mode without a CCP pin.

**Limitations:**

- **The timer clock is fixed at 16 MHz** (PIOSC, reset clock). On the board the timers run at the
  system clock (or ALTCLK via `GPTMCC`). If the firmware switches to the PLL, the timer periods in the
  simulator are wrong by the corresponding factor (e.g. 7.5× too long at 120 MHz).
- **Not modelled** (with a warning when used): input edge-count mode (`TnMR = 0x3`, `TnCMR = 0`),
  RTC mode (`GPTMCFG = 0x1`), capture match (`CnMIM`), wait-on-trigger (daisy chain), snapshot
  mode, ADC and µDMA trigger, `GPTMSYNC`, `GPTMCC.ALTCLK` (alternate clock).
- Time resolution is one Renode quantum (10 µs in the lab environments); interrupts are therefore
  delivered up to one quantum later than on the board.

### 2.5 UART 0–7 – `TivaUART.cs`, `UartLine.cs` (data sheet chapter 19)

**Modelled:**

- `UARTDR` with error bits (FE, PE, BE, OE), `UARTRSR`/`UARTECR`, `UARTFR`, `UARTIBRD`/`UARTFBRD`,
  `UARTLCRH` (format, FIFO, break), `UARTCTL` (UARTEN, TXE, RXE, HSE, EOT, LBE), `UARTCC`
  (system clock or PIOSC), `UARTIFLS`, peripheral and PrimeCell ID registers.
- Transmit and receive FIFO with 16 characters (or 1 character with `FEN = 0`), overrun.
- Interrupts RX, RT, TX (with `EOT`), OE, FE, PE, BE.
- **The line is simulated as signal edges with time stamps**: the bit time follows from IBRD/FBRD,
  HSE and the UART clock; `TXFF`, `TXFE` and `BUSY` follow the timing of the frame. The receiver
  samples in the middle of each bit with its own baud rate – a wrong baud rate or format produces
  wrong characters and framing/parity errors as on the board.
- IBRD/FBRD only take effect after the next write to `UARTLCRH` (19.3.2).
- **UART0** checks that PA0/PA1 are switched to U0RX/U0TX (`AFSEL`, `DEN`, `PCTL = 1`); the PC
  terminal of the web console is connected there. The edges appear on the pins and on the oscilloscope.
- Clock gating via `RCGCUART`.

**Limitations:**

- **UART1–7 have no pins by default.** Without `SetPins` (set by the experiment, e.g.
  `sysbus.uart3 SetPins "PJ1" "PJ0"`) they do not check `AFSEL`/`PCTL` and are not connected to a
  pin; they can be connected to a Renode terminal.
- **RX time-out interrupt (RT) is simplified**: it means "data available" and does not wait for
  32 bit times without a new character.
- **Not modelled:** µDMA (`UARTDMACTL`), IrDA (`SIREN`, warning), smartcard (`SMART`, warning),
  9-bit mode (`UARTNINEBIT`), modem/flow control signals (RTS/CTS, DCD, DSR, DTR, RI; only UART0/1
  have them on the chip), `UARTILPR` (IrDA low-power). `UARTCC` must be 0x0 or 0x5.
- No electrical effects (no line noise, no level converter); the edges are exact to 1 ns.

### 2.6 I2C 0–9 – `TivaI2C.cs` (data sheet chapter 18)

**Modelled:**

- Master registers `I2CMSA`, `I2CMCS`, `I2CMDR`, `I2CMTPR`, `I2CMIMR`, `I2CMRIS`, `I2CMMIS`,
  `I2CMICR`, `I2CMCR`, `I2CMBMON`.
- Single-byte transfers (transmit/receive) with START, RUN, STOP, ACK and repeated start.
- Address NACK when no device answers (`MCS.ERROR` + `MCS.ADRACK`).
- Master interrupt after each command.
- Devices are attached in the experiment with their 7-bit address, e.g.
  `oled: Video.SSD1306I2C @ i2c0 0x3C`.
- Clock gating via `RCGCI2C`.

**Limitations:**

- **Master mode only** – no slave registers (`I2CSOAR`, `I2CSCSR`, …).
- **No bus timing**: a command finishes immediately, `I2CMTPR` (SCL frequency) has no effect. The
  first read of `MCS` after a command still returns `BUSY = 1`, so that the usual wait loops
  (erratum workaround: wait for BUSY = 1, then BUSY = 0) do not hang.
- **The pins are neither checked nor driven**: `AFSEL`/`PCTL`/`ODR` of PB2/PB3 are not evaluated, the
  oscilloscope shows no I2C activity, and the missing pull-ups of the bus are not noticed.
- **Not modelled:** FIFO and burst mode (`I2CMBLEN`, `I2CFIFO*`), µDMA, glitch filter, high-speed mode,
  clock-low time-out (`I2CMCLKOCNT`), arbitration lost (only one master), quick command, SMBus
  features.

### 2.7 Oscilloscope (simulator only) – `Oscilloscope.cs`

Not part of the chip. Records the level of up to 16 pins as a probe would see it (driven output,
externally driven input, pull-up/pull-down or floating) with virtual time and 1 µs resolution. Only
digital levels, no analogue voltages.

## 3. Not modelled peripherals of the TM4C1294NCPDT

These blocks of the chip are **not** in the platform. Accesses to their addresses are logged by Renode
and read as 0; they never cause a bus fault.

| Peripheral (data sheet chapter) | Comment |
|---|---|
| ADC0/ADC1 (15), analogue comparators (23) | planned (ROADMAP M6) |
| SSI0–3 / QSSI (17) | |
| PWM module M0PWM (20), QEI0 (21) | PWM is possible with the GPTM PWM mode (2.4) |
| CAN0/1 (22), USB (24), Ethernet MAC + PHY (25) | |
| EPI (11) | |
| µDMA (9) | also missing as a trigger for UART/timer/ADC |
| Watchdog timers 0/1 (16) | a watchdog reset never happens |
| Hibernation module and RTC (7) | including VDD3ON, wake pin |
| Internal memory: flash controller, EEPROM (8) | flash cannot be programmed by firmware |
| CRC module, AES, DES, SHA/MD5 (crypto) | |
| ROM with TivaWare driverlib (`0x01000000`) | use driverlib from flash |
| GPIO interrupts of ports P and Q (10) | the ports themselves are modelled |
| MPU, debug/trace (ITM, DWT, ETM, TPIU) | debugging with GDB works through Renode, not via the debug registers |
| JTAG/SWD, NMI pin, reset pin of the chip | the board reset button is simulated (2.2) |

## 4. Devices outside the chip (experiments)

These models are not part of the `.repl` platform. Each experiment of the web console attaches them
in its own platform description ([EXPERIMENTS.md](EXPERIMENTS.md), [LABS.md](LABS.md)).

| Model | Device | Connected via | Main limitation |
|---|---|---|---|
| `WebSocketBridge.cs` | LEDs D1–D4 etc. in the browser | GPIO | – |
| `UartHostTerminal.cs` | PC terminal at the virtual COM port | UART0 (signal edges) | – |
| `SSD1306I2C.cs` | OLED display 128×64 | I2C | no scrolling, contrast, display offset; refreshed 10×/s |
| `MaxBotixI2C.cs` | ultrasonic sensor MaxBotix MB1242 | I2C | measurement finishes immediately |
| `HcSr04.cs` | ultrasonic sensor HC-SR04 | GPIO (trigger/echo) | timing like the real module |
| `KeypadMatrix.cs`, `HexKeypad.cs` | keypad 4×3 / hex keypad 4×4 | GPIO matrix | keys do not bounce |
| `BcdDisplay.cs` | 7-segment display with BCD decoder | GPIO | – |
| `PendulumDisplay.cs` | LED pendulum (HAW) | GPIO (8 LEDs, sync) | ideal sine oscillation, no damping |
| `TiCioConsole.cs` | CCS console (`printf`) | Renode hook on `C$$IO$$` | `scanf()` reads nothing |

## 5. Summary of the most important differences

| Topic | Board | Simulator |
|---|---|---|
| Access to a peripheral without clock | bus fault | reads 0, writes ignored, warning |
| Wait for `PR*` after `RCGC*` | necessary | `PR*` is set immediately |
| Timing of busy-wait loops | depends on clock and flash wait states | ≈ 11 million instructions/s, independent of the system clock |
| Timer and SysTick after switching to the PLL | run at the system clock | still 16 MHz |
| UART baud rate after switching to the PLL | system clock | system clock (correct) |
| Floating input | undefined | reads 0, warning |
| Analogue properties (voltages, drive strength, rise times) | real | only 0, 1, floating |
| Push buttons | bounce | do not bounce |
| I2C | bus timing, pins, pull-ups | immediate, no pins |
| Time resolution of interrupts | one clock cycle | one Renode quantum (10 µs in the labs) |
| ADC, SSI, PWM module, USB, Ethernet, … | available | not available |
