# Example 04 – Pendulum display: UART, ultrasonic sensor and POV display

**Goal:** a **pendulum with 8 LEDs** swings 10 times per second. If the firmware switches the LEDs
at exactly the right moment, the eye sees a stationary image ("persistence of vision", POV).
The pendulum shows the distance measured by the **ultrasonic sensor**, e.g. `123CM`. The distance
is also printed via **UART0**. First in the **simulator** (web console), then on the **board** with
additional hardware.

**Before you start:** [Example 02](../example02_timer_blink/README.md) (timer, interrupt) and
[Example 03](../example03_webkonsole/README.md) (UART, I2C, ultrasonic sensor).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT), clock 16 MHz (unchanged) |
| Pendulum LEDs | PM0–PM7 (outputs); upright pendulum with the pivot at the bottom: PM0 = LED at the top at the tip, PM7 = lowest LED |
| Pendulum signal | PL0 (input): **HIGH = pendulum right of the centre**, LOW = left; interrupt on both edges |
| Pendulum | 10 oscillations per second (period T = 100 ms); adjustable from 0.1 to 20 Hz in the web console |
| UART0 | PA0 RX / PA1 TX, 115200 baud, 8N1 (virtual COM port of the board) |
| I2C0 | PB2 SCL / PB3 SDA, 100 kHz |
| Ultrasonic sensor | MaxBotix MB1242 (I2CXL-MaxSonar), I2C address 0x70 |
| LED D2 | PN0, heartbeat 1 Hz |
| Timers | Timer0A 100 ms (sensor), Timer1A one-shot timer (columns), Timer2A free-running (time base) |
| Files | `main.c`, `example04_pendeldisplay.projectspec`, `Makefile` |

---

## 1. What you learn

- **Time-critical output with timers:** a **one-shot timer** triggers an interrupt at the start of
  every image column. A second, **free-running** timer serves as a clock.
- **Absolute instead of relative points in time:** if you always start the next timer relative to
  the last interrupt, the delays of the interrupt routine add up. Here the start of every column
  is computed absolutely on the clock.
- **Synchronisation to an external signal:** the edges on PL0 mark the moment when the pendulum
  passes the centre. The time between two consecutive edges is half a period; from this the
  firmware keeps measuring the period and adapts the schedule.
- **Non-linear motion:** the pendulum is fast in the centre and slow at the turning points.
  Columns of equal width therefore need different durations (a table with `asin`, pre-computed as
  integers).
- **Image as bytes:** one image column is one byte on port M (bit n = LED n). The 5×7 font from
  Example 03 fits directly.

## 2. The principle

The deflection of the pendulum follows a sine oscillation:

```
x(t) = sin(2·π·t / T)        x = −1: far left,  x = 0: centre,  x = +1: far right

time t        0         25 ms        50 ms        75 ms        100 ms
deflection    centre  → far right  → centre    →  far left   → centre
motion        to the right (0 … 25 ms), to the left (25 … 75 ms), to the right (75 … 100 ms)
PL0           ↑ HIGH ──────────────── ↓ LOW ─────────────────  ↑ HIGH
```

So the rising edge on PL0 means "the pendulum passes the centre moving to the right", the
falling edge "the pendulum passes the centre moving to the left".

The image has **40 columns**. They are spread evenly over the inner 90 % of the swing range
(`x` from −0.9 to +0.9). At the very outside the pendulum is so slow that the columns would
become too wide. Column k starts at `x(k) = −0.9 + 1.8·k/40`, i.e. at the time

```
t(k) = asin(x(k)) / (2·π) · T          (measured from the moment the pendulum passes the centre)
```

For T = 100 ms one image lasts from `t(0) = −17.8 ms` to `t(40) = +17.8 ms`. The columns in the
centre last 0.72 ms, the outermost ones 1.5 ms.

**Important:** the edge on PL0 lies **in the middle** of the image. That is why the firmware always
schedules the **next** pass through the centre. It comes half a period after the last edge, in the
opposite direction:

- PL0 HIGH (pendulum right) → the next pass goes to the **left**: columns 39 … 0.
- PL0 LOW (pendulum left) → the next pass goes to the **right**: columns 0 … 39.

So the image is drawn on every swing, 20 times per second.

## 3. Understanding the program (`main.c`)

| Part | Task |
|---|---|
| `columnTime_q16[]` | `t(k)/T` in units of 1/65536 of the period (pre-computed with Python, command in the comment) |
| `compute_schedule()` | converts the table into timer ticks using the measured period (`columnTicks[]`) |
| `GPIOL_Handler()` | edge on PL0: remember the time, period = 2 × time since the previous edge |
| `plan_swing()` | compute the next pass through the centre (`center`), set the direction, set Timer1A to column 0 |
| `set_column_timer(k)` | set Timer1A so that it triggers at `center + t(k)` |
| `TIMER1A_Handler()` | output the column on port M, set the timer to the next column; after column 39 switch the LEDs off and schedule the next swing |
| `image_text()` | write text centred into the image (5×7 font, bit 0 = top) |
| main loop | measure the sensor every 200 ms; on a change, update the image and the UART |

| Register (data sheet) | Name in `tm4c1294ncpdt.h` | Address | Effect here |
|---|---|---|---|
| `GPIOIBE` (port L) | `GPIO_PORTL_IBE_R` | `0x40062408` | bit 0: interrupt on **both** edges of PL0 |
| `GPIODATA` (port M) | `GPIO_PORTM_DATA_R` | `0x400633FC` | all 8 bits at once: one image column |
| `GPTMTAMR` (Timer1) | `TIMER1_TAMR_R` | `0x40031004` | `TIMER_TAMR_TAMR_1_SHOT`: one-shot mode |
| `GPTMTAILR` (Timer1) | `TIMER1_TAILR_R` | `0x40031028` | waiting time until the next column (ticks − 1) |
| `GPTMCTL` (Timer1) | `TIMER1_CTL_R` | `0x4003100C` | `TIMER_CTL_TAEN`: start; in one-shot mode the timer switches itself off afterwards |
| `GPTMTAV` (Timer2) | `TIMER2_TAV_R` | `0x40032050` | current value of the free-running clock (counts **down**) |

All names come from `tm4c1294ncpdt.h` (see Example 01); the program contains no addresses.

The clock (Timer2) counts down. "Later" therefore means "smaller counter value". With unsigned
32-bit numbers the difference `earlier − later` is correct even across the overflow:

```c
uint32_t dest = center - (uint32_t)columnTicks[k];        // point in time of column k
int32_t wait  = (int32_t)(TIMER2_TAV_R - dest);           // ticks until then
```

## 4. Option A: in the simulator (web console)

1. Build: in CCS (import as in Example 01, `example04_pendeldisplay.projectspec`) or
   ```bash
   cd ~/lab/renode4mc-haw/examples/example04_pendeldisplay
   make
   ```
   `make` looks for CCS in `~/ti`, `~/tmp/ti`, `/opt/ti` and `/Applications/ti` (otherwise gcc, see
   `make toolchain`). If it is somewhere else, give the path, e.g. `make CCS_ROOT=/opt/ti/ccs`.
2. Start the web console:
   ```bash
   cd ~/lab/renode4mc-haw/webconsole
   docker compose up --build
   ```
3. Open http://localhost:3000, choose **Example 2**, select `example04_pendeldisplay.out`, **Start**.

What you should see:

- In the **terminal**: `renode4mc-haw - Example 04 Pendulum display`, `Distance: 100 cm`,
  `Pendulum period: 100.0 ms`.
- On the **pendulum display**: the swinging rod (pivot at the bottom). Every LED that is on leaves
  a light trail that disappears after the set **afterglow time** (default 1 s: the whole image is
  visible at once). Set the afterglow to about 100 ms – that is roughly how slow the eye is – and
  `100CM` is still shown as an arc; with 10 ms you only see a short piece of trail behind the rod.
  The view "Still image" shows the last swing in each direction without fading. The display runs
  about 0.3 s behind the simulation.
- **D2** blinks at 1 Hz.
- **Slider** of the sensor: terminal and pendulum show the new distance.
- **Pendulum frequency** (slider at the pendulum, 0.1–20 Hz): the terminal reports the newly measured
  period, e.g. `Pendulum period: 66.7 ms` at 15 Hz, and the image stays still. At low frequencies
  (e.g. 0.5 Hz) you can see how the rod swings and the LEDs switch column by column; then there is no
  stationary image any more – just as with the real pendulum. The last digit of the measured period
  can vary by 0.1 ms.
- The selection below the pendulum shows **both swings** (like the eye) or only one. If the firmware
  only draws in one direction, or if the two directions do not match, you see it here immediately.

### Try it yourself

- Disable `compute_schedule(t)` in `GPIOL_Handler()` (comment it out) and change the pendulum
  frequency. What happens to the image at 5 Hz, and what at 20 Hz? Why?
- Replace the `asin` table by columns of equal duration (`t(k)` linear in k). What does the text
  look like now?
- In `plan_swing()`, comment out the line with `toLeft = …` (always output left → right). What
  happens on the swing back?

## 5. Option B: on the board

In addition to the EK-TM4C1294XL you need: a pendulum with 8 LEDs (each with a series resistor,
e.g. 330 Ω at 3.3 V; for more current via transistors or a driver chip), a sensor for the pass
through the centre (fork light barrier or Hall sensor; connect the output so that PL0 is HIGH
while the pendulum is on the right) and the MB1242 sensor as in Example 03.

> **Note:** a real pendulum does not swing at exactly 10 Hz and loses amplitude. That is why the
> firmware keeps measuring the period. If the amplitude differs, the image becomes narrower or
> wider; the table is valid for one fixed amplitude.

## 6. Exercises

1. Below 50 cm, show `NEAR` instead of the number (extend the font by `N`, `E`, `A`, `R`).
2. Let the text scroll from right to left every 0.2 s (scrolling text).
3. Measure with Timer2 how long `TIMER1A_Handler()` takes, and print the largest value via UART.
4. Draw a bar whose length corresponds to the distance (0–400 cm → 0–40 columns).

## 7. Notes on the simulator

- The pendulum model (`sim/models/PendulumDisplay.cs`) computes in **virtual time**. So the image
  is correct even if the computer runs the simulation more slowly.
- Example 2 sets Renode to 10 µs time slices (`emulation SetGlobalQuantum`), so that the LED
  changes are captured precisely enough.
- A new pendulum frequency takes effect from the next pass through the centre. A real pendulum
  does not change its frequency abruptly; here the slider is used to test the period measurement.
- The model shows the **last** swing per swing direction. Brightness curves, afterglow of the
  LEDs and damping of the pendulum are not modelled.
- Details about the model: [docs/WEBCONSOLE.md](../../docs/WEBCONSOLE.md), section 2.
