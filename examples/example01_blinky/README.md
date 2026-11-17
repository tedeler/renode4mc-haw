# Example 01 – Blinky: making LEDs blink

**Goal:** your first microcontroller program. The LEDs **D1** and **D2** of the board blink
alternately every half second – first in the **simulator**, then on the **real board**.

**Before you start:** [Installation on Linux](../../docs/INSTALL_LINUX.md) is complete.

| | |
|---|---|
| Board | EK-TM4C1294XL (microcontroller TM4C1294NCPDT, ARM Cortex-M4F) |
| LEDs | D1 = pin **PN1**, D2 = pin **PN0** (port N, pin 1 and 0) |
| Clock | 16 MHz (the clock directly after power-on; we do not change it) |
| Files | `main.c` (program), `example01_blinky.projectspec` (CCS project), `Makefile` (build in the terminal) |

---

## 1. What you learn

- A microcontroller pin is a connection that the program controls via **registers**. A register
  is a 32-bit value at a fixed address; writing to this address changes the hardware.
- Before you use a peripheral module (e.g. a GPIO port), you must **switch on its clock**
  ("clock gating", register `RCGCGPIO`). Without a clock, every access causes a fault.
- Pins must be configured as **output** (`DIR`) and **digital** (`DEN`) before you write to them (`DATA`).
- **Bit operations** (`|=`, `&= ~`, `^=`) change individual bits without touching the others.
- With a **busy-wait loop** you delay the program – the CPU is fully busy while waiting
  (Example 02 improves this with a timer).

## 2. Understanding the program (`main.c`)

**No library** is used, only the header file **`tm4c1294ncpdt.h`** from TI
(in `common/`, included with `#include "tm4c1294ncpdt.h"`). It contains
- for every register a macro `<MODULE>_<REGISTER>_R` that you read and write like a variable –
  behind it is the address from the data sheet (**base address + offset**), e.g.
  `GPIO_PORTN_DIR_R` = address `0x40064400`;
- for bits and field values constants such as `SYSCTL_RCGCGPIO_R12` (= bit 12) or `TIMER_CTL_TAEN`.

That is why the program contains **no addresses** – so typing errors in addresses are impossible.

| Register (data sheet) | Name in `tm4c1294ncpdt.h` | Address | Effect here |
|---|---|---|---|
| `RCGCGPIO` | `SYSCTL_RCGCGPIO_R` | `0x400FE608` | bit 12 (`SYSCTL_RCGCGPIO_R12`) = 1: port N gets its clock (bit *n* = port *n*, A = 0 … N = 12) |
| `PRGPIO` | `SYSCTL_PRGPIO_R` | `0x400FEA08` | bit 12 (`SYSCTL_PRGPIO_R12`) = 1: port N is ready |
| `GPIODIR` (port N) | `GPIO_PORTN_DIR_R` | `0x40064400` | bit = 1: the pin is an output |
| `GPIODEN` (port N) | `GPIO_PORTN_DEN_R` | `0x4006451C` | bit = 1: the pin is digitally enabled |
| `GPIODATA` (port N) | `GPIO_PORTN_DATA_R` | `0x400643FC` | levels of the pins (bit 0 = PN0, bit 1 = PN1) |

```c
SYSCTL_RCGCGPIO_R |= PORT_N;                      // 1. clock for port N on (set bit 12)
while ((SYSCTL_PRGPIO_R & PORT_N_READY) == 0) {}  // 2. wait until the port is ready
GPIO_PORTN_DIR_R |= PIN0 | PIN1;                  // 3. PN0, PN1 = outputs
GPIO_PORTN_DEN_R |= PIN0 | PIN1;                  //    and digital
GPIO_PORTN_DATA_R = PIN1;                         // start: D1 on, D2 off
while (1) {
    delay(HALF_SECOND);                           // 4. wait about 0.5 s
    GPIO_PORTN_DATA_R ^= PIN0 | PIN1;             // 5. toggle both LEDs (XOR)
}
```

**Caution, names of ports A–J:** on the TM4C1294 all GPIO ports are connected to the fast AHB bus.
That is why the header file calls ports A to J `GPIO_PORTA_AHB_..._R` … `GPIO_PORTJ_AHB_..._R`,
while ports K to Q have no suffix (`GPIO_PORTN_DIR_R`).

The delay is an empty counting loop (`volatile`, so that the compiler does not remove it). One pass
takes about 12 clock cycles; at 16 MHz, `HALF_SECOND` ≈ 700 000 passes are just under half a second.
The exact time depends on the compiler and the optimisation – that is why Example 02 uses a timer.

---

## 3. Option A: in the simulator (without a board)

The simulator runs **the same `.out` file** as the board.

### 3.1 Compiling

In the terminal:

```bash
cd ~/lab/renode4mc-haw/examples/example01_blinky
make
```

Result: the file `example01_blinky.out`. Error message "tiarmclang not found" → section
*Common problems* in the installation guide.

*Alternatively* you can build the `.out` file in CCS (section 4) and simulate that one.

### 3.2 Starting the simulator

```bash
ucsim example01_blinky.out
```

The page **"EK-TM4C1294XL – LEDs"** opens in the browser (if not: open the file
`sim/visualizer/ek-tm4c1294xl.html` in the browser yourself). At the bottom it says "Connected to
the simulator", and **D1 and D2 blink alternately**. Stop with `Ctrl+C` in the terminal.

The four LEDs on the page correspond to the four user LEDs of the board (D1 PN1, D2 PN0, D3 PF4, D4 PF0).

### 3.3 Try it yourself

- Change `HALF_SECOND` to `70000u` (about 0.05 s), run `make`, restart `ucsim`.
- As a test, remove the line `SYSCTL_RCGCGPIO_R |= PORT_N;` and simulate again: the terminal shows
  the warning *"GPIO port N: access … without clock!"*, and the LEDs stay off. On the board the
  program would end up in the HardFault handler – a very common beginner's mistake.

---

## 4. Option B: on the real board with CCS

### 4.1 Importing the project into CCS

1. Start CCS (`~/ti/ccs2040/ccs/theia/ccstudio`).
2. Menu **File → Import Projects…** (or in the view "CCS Project Explorer" → *Import*), choose the
   type **CCS Projects** and select the file
   `~/lab/renode4mc-haw/examples/example01_blinky/example01_blinky.projectspec`.
3. The project needs no further settings (no library, no path variables).

**If the user interface does not react as described**, import it in the terminal – this works
without clicking and has been tested by us:

```bash
cd ~/lab/renode4mc-haw
tools/ccs-import.sh examples/example01_blinky
```

The project is then in the workspace `~/ccs_workspace`; in CCS, use
`-data`/"Switch Workspace" to open this folder.

### 4.2 Building

Right-click on the project **example01_blinky → Build Project** (hammer icon). At the end, the
console must show `Finished building target: "example01_blinky.out"` and **0 errors**.

### 4.3 Connecting the board and loading the program

1. Connect the board with the USB cable to the port **DEBUG** (not USER). The power LED lights up.
2. Menu **Run → Debug** (or the bug icon). CCS loads the program via the debug connection
   "Stellaris ICDI" and stops at the beginning of `main`.
3. **Run → Resume** (green arrow/`F8`): D1 and D2 blink alternately.
4. To finish: **Terminate** (red square).

The program is then stored in the flash of the board: after unplugging and plugging in the USB
cable it starts again by itself.

### 4.4 Alternative: loading the `.out` file onto the board from the terminal (without CCS)

```bash
openocd -f board/ti_ek-tm4c1294xl.cfg -c "program example01_blinky.out verify reset exit"
```

(`sudo apt install openocd`, details in the [installation guide, step 9](../../docs/INSTALL_LINUX.md).)

---

## 5. Debugging in the simulator (extra)

You can follow the program step by step:

```bash
ucsim --debug example01_blinky.out      # terminal 1: the simulator waits for the debugger
gdb-multiarch example01_blinky.out      # terminal 2
(gdb) target remote localhost:3333
(gdb) break main
(gdb) continue
(gdb) next                            # line by line
(gdb) quit
```

Debugging with the CCS user interface against the simulator is described in `docs/TOOLCHAIN.md`
(not fully integrated yet).

---

## 6. How accurate is the simulator?

- The **timing** of busy-wait loops is approximate (±30 %), not cycle-accurate.
- Modelled are: clock gating (SYSCTL), GPIO (ports A–Q), timers 0–7, UART, I2C, interrupts (SysTick
  is part of the processor model but has not been tested separately yet). ADC follows (see `docs/ROADMAP.md`).

## 7. Exercises

1. Make **D3 (PF4)** and **D4 (PF0)** blink as well (port F = bit 5 in `RCGCGPIO`,
   i.e. `SYSCTL_RCGCGPIO_R5`; registers `GPIO_PORTF_AHB_DIR_R`, `…_DEN_R`, `…_DATA_R` – look them up
   in `tm4c1294ncpdt.h`). Which line is missing if the LEDs stay dark?
2. Create a **running light** over all four LEDs.
3. Measure with a stopwatch how accurate the 0.5 s are on the board. Why does the value differ?
