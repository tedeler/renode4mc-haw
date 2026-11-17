# Example 02 – Timer blink: an LED blinks via a timer interrupt

**Goal:** the LED **D1** blinks every half second – this time without a busy-wait loop. A **timer**
triggers an **interrupt** every 0.5 s, and its routine toggles the LED. Meanwhile the CPU can
sleep. First in the **simulator**, then on the **real board**.

**Before you start:** the [installation](../../docs/INSTALL_LINUX.md) is complete and you have
understood [Example 01](../example01_blinky/README.md) (clock gating, GPIO output).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT) |
| LED | D1 = pin **PN1** |
| Clock | 16 MHz (unchanged) |
| Timer | Timer0, half A, 32 bit, periodic |
| Files | `main.c`, `example02_timer_blink.projectspec`, `Makefile` |

---

## 1. What you learn

- A **timer** counts down from a start value to 0 with the system clock and signals this
  ("time-out"). In **periodic mode** it then starts again by itself.
- An **interrupt** interrupts the main program and calls an **interrupt service routine (ISR)**.
  After that, the main program continues.
- Enabling an interrupt consists of **three switches**: in the peripheral module (register
  `GPTMIMR`), in the interrupt controller NVIC (register `ISER0`/`EN0`) and globally in the CPU (instruction `cpsie i`).
- The **interrupt flag** must be cleared in the ISR (register `GPTMICR`), otherwise the CPU jumps
  straight back into it.
- Like GPIO, timers have **clock gating** (register `RCGCTIMER`, bit 0 = Timer0).

## 2. Understanding the program (`main.c`)

As in Example 01, register names and bit constants come from `tm4c1294ncpdt.h` (see the data sheet,
chapter "General-Purpose Timers", register map). The program does not contain any addresses.

| Register (data sheet) | Name in `tm4c1294ncpdt.h` | Address | Effect here |
|---|---|---|---|
| `RCGCTIMER` | `SYSCTL_RCGCTIMER_R` | `0x400FE604` | `SYSCTL_RCGCTIMER_R0` (bit 0): Timer0 gets its clock |
| `PRTIMER` | `SYSCTL_PRTIMER_R` | `0x400FEA04` | `SYSCTL_PRTIMER_R0` (bit 0): Timer0 is ready |
| `GPTMCFG` | `TIMER0_CFG_R` | `0x40030000` | `TIMER_CFG_32_BIT_TIMER` (0): one 32-bit timer |
| `GPTMTAMR` | `TIMER0_TAMR_R` | `0x40030004` | `TIMER_TAMR_TAMR_PERIOD` (bits 1:0 = 2): periodic (counts down) |
| `GPTMCTL` | `TIMER0_CTL_R` | `0x4003000C` | `TIMER_CTL_TAEN` (bit 0): the timer runs |
| `GPTMIMR` | `TIMER0_IMR_R` | `0x40030018` | `TIMER_IMR_TATOIM` (bit 0): a time-out triggers an interrupt |
| `GPTMICR` | `TIMER0_ICR_R` | `0x40030024` | write `TIMER_ICR_TATOCINT` (bit 0): clear the time-out flag |
| `GPTMTAILR` | `TIMER0_TAILR_R` | `0x40030028` | start value |
| NVIC `EN0` | `NVIC_EN0_R` | `0xE000E100` | bit 19 = 1: enable interrupt no. 19 (Timer0A) |

**Interrupt number:** the header file counts the entries of the vector table: `INT_TIMER0A` = 35.
The first 16 entries are processor exceptions (reset, HardFault, SysTick …), so in the NVIC
Timer0A is interrupt 35 − 16 = **19** (`IRQ_TIMER0A` in `main.c`).

Start value for 0.5 s: **16 000 000 clock cycles/s × 0.5 s = 8 000 000** clock cycles. The timer
counts from `start value` down to 0, which takes `start value + 1` clock cycles; hence `8 000 000 − 1`.

```c
SYSCTL_RCGCGPIO_R  |= PORT_N;                  // clock for port N
SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;     // clock for Timer0
while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R12) == 0 ||
       (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0) {}                  // ready?
GPIO_PORTN_DIR_R |= PIN1;  GPIO_PORTN_DEN_R |= PIN1;   // PN1 = digital output

TIMER0_CTL_R   = 0;                            // switch the timer off for configuration
TIMER0_CFG_R   = TIMER_CFG_32_BIT_TIMER;       // 32 bit
TIMER0_TAMR_R  = TIMER_TAMR_TAMR_PERIOD;       // periodic
TIMER0_TAILR_R = 8000000 - 1;                  // 0.5 s
TIMER0_IMR_R  |= TIMER_IMR_TATOIM;             // switch 1: in the timer
NVIC_EN0_R     = 1u << IRQ_TIMER0A;            // switch 2: in the NVIC (bit 19)
__asm volatile("cpsie i");                     // switch 3: in the CPU
TIMER0_CTL_R  |= TIMER_CTL_TAEN;               // go!

while (1) { __asm volatile("wfi"); }           // the CPU sleeps until the interrupt

void TIMER0A_Handler(void)                     // the ISR
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;         // clear the flag
    GPIO_PORTN_DATA_R ^= PIN1;                 // toggle PN1
}
```

The name **`TIMER0A_Handler`** is not a coincidence: it is listed in the **vector table** in
`common/startup_tm4c1294.c`. When Timer0A triggers an interrupt, the CPU jumps via this table
to the function with exactly this name. You can find all names of the table in that file
(e.g. `GPIOA_Handler`, `UART0_Handler`, `SysTick_Handler`).

---

## 3. Option A: in the simulator

```bash
cd ~/lab/renode4mc-haw/examples/example02_timer_blink
make
ucsim example02_timer_blink.out
```

In the browser, **D1** (the left LED) toggles every 0.5 s (i.e. a period of 1 s). Stop with `Ctrl+C`.

### Try it yourself

- Change `/ 2u` to `/ 10u` (0.1 s): `make`, restart `ucsim`.
- Remove the line `TIMER0_ICR_R = TIMER_ICR_TATOCINT;` in the ISR: it is called again and again (the LED flickers). Why?
- Remove `SYSCTL_RCGCTIMER_R |= …`: the simulator warns
  *"Timer: access without clock!"*.

### Debugging in the simulator (breakpoint in the ISR)

```bash
ucsim --debug example02_timer_blink.out       # terminal 1
gdb-multiarch example02_timer_blink.out       # terminal 2
(gdb) target remote localhost:3333
(gdb) break TIMER0A_Handler
(gdb) continue                              # stops in the ISR after 0.5 s
(gdb) bt                                    # call stack
(gdb) quit
```

---

## 4. Option B: on the board with CCS

1. **Import:** in CCS choose **File → Import Projects…** and
   `examples/example02_timer_blink/example02_timer_blink.projectspec`. No further settings are
   needed (no library).
   Without the user interface: `tools/ccs-import.sh examples/example02_timer_blink`.
2. **Build:** right-click on the project → **Build Project**; at the end **0 errors**.
3. **Board:** USB to the port **DEBUG**; **Run → Debug**; then **Resume**. **D1** blinks.
4. **Breakpoint in the ISR:** double-click to the left of the line `GPIO_PORTN_DATA_R ^= PIN1;` in
   `TIMER0A_Handler`, then Resume – CCS stops at every interrupt.
   In the window **Registers** you can see the Timer0 registers (`GPTM`), e.g. `GPTMRIS`.
5. **Alternatively without CCS:** load the `.out` file in the terminal (after `sudo apt install openocd`):
   ```bash
   openocd -f board/ti_ek-tm4c1294xl.cfg -c "program example02_timer_blink.out verify reset exit"
   ```
   Details: [installation guide, step 9](../../docs/INSTALL_LINUX.md).

---

## 5. Difference from Example 01

| | Example 01 | Example 02 |
|---|---|---|
| time measurement | the CPU counts in a loop | hardware timer |
| CPU during the delay | 100 % busy | sleeps (`wfi`) |
| accuracy | approximate | exact to the clock cycle (16 MHz) |
| additional hardware | – | Timer0, NVIC, interrupt |

## 6. Exercises

1. Make **D1 blink at 1 Hz** and in addition **D2 (PN0)** at 2 Hz – with **one** timer.
   (Hint: let the timer trigger every 125 ms; toggle D2 on every 2nd call and D1 on every 4th call – with a counter in the ISR.)
2. Set `GPTMTAMR` to **one-shot** mode (value 1). What happens?
3. Compute the start value for 250 ms and for 5 s (careful: the start value must fit into 32 bits).

## 7. Notes on the simulator

- Timing: timers are **exact to the clock cycle** in simulated time; on the PC the simulated time
  runs at roughly real time. Busy-wait delays as in Example 01 are less accurate.
- Modelled are 32/16-bit operation A/B, periodic and one-shot, time-out interrupt, and (see
  Example 05) compare action, PWM, edge-time capture and the match event. Not modelled: edge count,
  RTC, ADC trigger.
