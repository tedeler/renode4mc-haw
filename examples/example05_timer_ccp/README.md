# Example 05 – Timer with CCP pins: PWM, pulse, key press duration

**Goal:** three timers work directly on pins, without the CPU switching the pin itself:

- **Timer0** generates a PWM signal of about **30 Hz** on **LED1** – the LED looks dimmed.
  The keys select the duty cycle: **key 0 = 0 %, key 1 = 25 %, key 2 = 50 %, key 3 = 100 %**.
- **Timer1** generates a pulse on **LED2**: **100 ms HIGH, every second**.
- **Timer2** measures **how long key 0 is pressed** (capture) and prints the time via the **UART**.

Timer0 and Timer1 run in **16-bit compare mode**, Timer2 in **16-bit capture mode**.

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT) |
| Clock | 16 MHz (unchanged) |
| Web console | experiment **"Example 3 – Timer"** (`sim/experiments/example3.json`); the button "Reference solution" starts this demo |
| Files | `main.c`, `example05_timer_ccp.projectspec`, `Makefile` |

## Connections

| Component | Pin | Function (GPIOPCTL) | Meaning |
|---|---|---|---|
| LED1 | PL4 | T0CCP0 (3) | PWM from Timer0 A |
| LED2 | PL6 | T1CCP0 (3) | pulse from Timer1 A |
| LED3, LED4 | PL0, PL1 | GPIO output | selected step in binary (LED4 LED3: 00 = 0 %, 01 = 25 %, 10 = 50 %, 11 = 100 %) |
| key 0 | PM0 | T2CCP0 (3) | 0 %, input of the capture of Timer2 A |
| key 1..3 | PM1..PM3 | GPIO input | 25 %, 50 %, 100 % (GPIO interrupt on falling edge) |
| UART0 | PA0/PA1 | U0RX/U0TX (1) | 115200 bit/s 8N1 |

The keys switch to GND; the firmware switches on the internal pull-ups (GPIOPUR).
Which pins belong to which timer is listed in table 13-2 of the data sheet ("General-Purpose Timers
Signals"): CCP0 belongs to timer A, CCP1 to timer B.

## 1. Compare mode (Timer0 and Timer1)

In **Timer Compare Action Mode** (data sheet 13.3.3.1) the timer counts down periodically as usual.
At the time-out, **the hardware** changes the CCP pin according to the field **TCACT** in GPTMTnMR:

| TCACT | Effect at the time-out |
|---|---|
| `TIMER_TAMR_TCACT_TOGGLE` (0x1) | toggle the pin |
| `TIMER_TAMR_TCACT_CLRTO` (0x2) | pin LOW |
| `TIMER_TAMR_TCACT_SETTO` (0x3) | pin HIGH |
| 0x4 … 0x7 | additionally set/clear immediately |

TCACT may be changed while the timer is running (it is the only field in GPTMTnMR that may). The
interrupt routine therefore always plans **one phase ahead**: phase *n+1* has just started; the ISR
decides to which level the pin jumps at the end of phase *n+1* (TCACT) and how long phase *n+2*
lasts (GPTMTnILR). With **TnILD = 1** the timer only takes over the new TnILR at the next time-out –
the running phase is not disturbed, and the pin changes exactly at the right clock cycle, even if
the ISR runs a little later.

**Calculation (16-bit mode, counting down: the prescaler is a "true" divider):**

| | Prescaler GPTMTnPR | 1 tick | Period | HIGH |
|---|---|---|---|---|
| Timer0 (PWM) | 15 → ÷16 | 1 µs | 33 333 ticks = 33.333 ms (30 Hz) | 25 %: 8 333, 50 %: 16 666 |
| Timer1 (pulse) | 255 → ÷256 | 16 µs | 62 500 ticks = 1 s | 6 250 ticks = 100 ms |

Both values fit into the 16 bits of GPTMTnILR (≤ 65 535). At 0 % and 100 % there are no changes:
the ISR then always selects the same action (CLRTO or SETTO).

At 30 Hz a real LED still flickers slightly, but the eye already averages enough for it to look
dimmed. That is why the web console shows an LED that switches quickly with its averaged brightness.

## 2. Capture mode (Timer2)

Timer2 A runs in **Input Edge-Time Mode** (13.3.3.4): `TAMR = TIMER_TAMR_TAMR_CAP | TIMER_TAMR_TACMR`,
`TIMER_CTL_TAEVENT_BOTH` (both edges). On every edge on T2CCP0, the hardware stores the counter value
in **GPTMTAR** and sets **CAERIS** – so the point in time is exact to one clock cycle (62.5 ns),
no matter when the ISR runs.

In 16-bit mode the prescaler is used here as an **extension** of the counter: GPTMTAPR = 0xFF and
GPTMTAILR = 0xFFFF give a 24-bit counter that overflows after 2²⁴ clock cycles = **1.048576 s**. For
longer key presses, **Timer2 B** (periodic, (0xFFFF+1)·(0xFF+1) = 2²⁴ clock cycles, started with the
same write access to GPTMCTL) counts the overflows – as recommended by the note on figure 13-3.
Timer2 B has the higher interrupt priority. The function `timestamp()` checks, with interrupts
disabled, whether an overflow happened between the edge and reading the counter.
Duration = timestamp(release) − timestamp(press).

Output in the terminal:

```
PWM: 0 %
Key 0 pressed: 1799.790 ms
```

## 3. Trying it out in the web console

1. Choose the experiment **"Example 3 – Timer …"** and start the **Reference solution** (or build
   `main.c` yourself and upload it).
2. Switch on the **scope**: CH1 = PL4 (PWM), CH2 = PL6 (pulse), CH3 = PM0 (key 0). Time base 20 ms/div
   for the PWM, 200 ms/div for the pulse.
3. Press key 1, 2, 3: the duty cycle on the oscilloscope and the brightness of LED1 change, LED3/LED4
   show the step.
4. Hold key 0: LED1 goes off; after releasing it, the duration is shown in the UART monitor. Compare
   it with the LOW time of CH3 on the oscilloscope.

In the Renode monitor, `sysbus.timer0 CcpPins` shows which CCP pins a timer currently uses.

## 4. Building

```bash
make          # tiarmclang from CCS, result example05_timer_ccp.out (without CCS: gcc -> .elf)
make sim      # start in the simulator
```

For the web console, `tools/build-solutions.sh` builds the demo with gcc into
`sim/solutions/example05_timer_ccp.elf`.

## 5. Exercises

- Change the PWM frequency to 100 Hz. Which prescaler/start values are needed? At what frequency
  can you no longer see the flicker?
- Generate the PWM of Timer0 with the **PWM mode** of the timer instead (TnAMS = 1,
  GPTMTnMATCHR, data sheet 13.3.3.5) – without any interrupt. What do you have to consider at 0 % and
  100 % (figures 13-5/13-6)?
- Also measure the time between two presses of key 0.
