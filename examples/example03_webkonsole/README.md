# Example 03 – Web console: UART, I2C, keypad and push buttons

**Goal:** a program that uses all controls of the [web console](../../docs/WEBCONSOLE.md).
It prints messages via **UART0**, reads an **ultrasonic sensor** and writes to an
**OLED display** via **I2C**. A **keypad** is read by multiplexing, and the **push buttons**
trigger interrupts. First in the **simulator** (web console), then on the **board** with
additional hardware.

**Before you start:** [Example 01](../example01_blinky/README.md) (GPIO, clock gating) and
[Example 02](../example02_timer_blink/README.md) (timer, interrupt).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT), clock 16 MHz (unchanged) |
| LEDs | D1 = PN1 (distance < 50 cm), D2 = PN0 (heartbeat 1 Hz), D3 = PF4 / D4 = PF0 (push buttons) |
| Push buttons | USR_SW1 = PJ0, USR_SW2 = PJ1 (pressed = LOW), interrupt on falling edge |
| UART0 | PA0 RX / PA1 TX, 115200 baud, 8N1 (virtual COM port of the board) |
| I2C0 | PB2 SCL / PB3 SDA, 100 kHz |
| OLED | SSD1306 128×64, I2C address 0x3C |
| Ultrasonic sensor | MaxBotix MB1242 (I2CXL-MaxSonar), I2C address 0x70 |
| Keypad 4×3 | rows PK0–PK3 (outputs), columns PK4–PK6 (inputs, pull-down, interrupt) |
| Timer | Timer0A, 100 ms periodic |
| Files | `main.c`, `example03_webkonsole.projectspec`, `Makefile` |

---

## 1. What you learn

- **UART:** compute the baud rate from the clock (`IBRD`/`FBRD`), switch pins to the alternate
  function (`AFSEL`, `PCTL`), transmit by polling `TXFF`, receive by polling `RXFE`.
- **I2C master:** address in `MSA`, data in `MDR`, sequence via `MCS` (START, RUN, STOP, ACK).
  Then wait for the end and check for errors (`BUSY`, `ERROR`).
- **Devices on the bus:** the OLED receives a control byte with every transfer (`0x00` = commands,
  `0x40` = image data). The sensor measures after the command `0x51` and returns 2 bytes.
- **Multiplexing:** with 4 + 3 lines you can read 12 keys. The firmware drives one row HIGH
  and reads the columns.
- **Interrupts from several sources** (timer, port J, port K): the ISR only sets a flag, the
  main loop does the work.

## 2. Understanding the program (`main.c`)

All registers and bits come from `tm4c1294ncpdt.h` (see Example 01); the program contains no addresses.

| Register (data sheet) | Name in `tm4c1294ncpdt.h` | Address | Effect here |
|---|---|---|---|
| `RCGCUART` / `PRUART` | `SYSCTL_RCGCUART_R` / `SYSCTL_PRUART_R` | `0x400FE618` / `0x400FEA18` | `…_R0` (bit 0): clock for UART0 |
| `RCGCI2C` / `PRI2C` | `SYSCTL_RCGCI2C_R` / `SYSCTL_PRI2C_R` | `0x400FE620` / `0x400FEA20` | `…_R0` (bit 0): clock for I2C0 |
| `UARTIBRD` / `UARTFBRD` | `UART0_IBRD_R` / `UART0_FBRD_R` | `0x4000C024` / `0x4000C028` | 8 / 44 → 115200 baud at 16 MHz |
| `UARTLCRH` | `UART0_LCRH_R` | `0x4000C02C` | `UART_LCRH_WLEN_8 \| UART_LCRH_FEN`: 8 data bits, FIFO on |
| `UARTCTL` | `UART0_CTL_R` | `0x4000C030` | `UART_CTL_UARTEN`, `UART_CTL_TXE`, `UART_CTL_RXE` |
| `I2CMCR` | `I2C0_MCR_R` | `0x40020020` | `I2C_MCR_MFE`: switch the master on |
| `I2CMTPR` | `I2C0_MTPR_R` | `0x4002000C` | 7 → 100 kHz at 16 MHz |
| `I2CMSA` / `I2CMDR` / `I2CMCS` | `I2C0_MSA_R` / `I2C0_MDR_R` / `I2C0_MCS_R` | `0x40020000` / `…08` / `…04` | address+R/W, data byte, command/status (`I2C_MCS_RUN`, `…_START`, `…_STOP`, `…_ACK`) |
| `GPIOIEV` (port K) | `GPIO_PORTK_IEV_R` | `0x4006140C` | columns: interrupt on rising edge |

Two things that the header file does **not** contain and that are therefore defined in `main.c`:
- the pin functions for `GPIOPCTL` (data sheet, table "GPIO Pins and Alternate Functions":
  PA0/PA1 → function 1 = U0RX/U0TX, PB2/PB3 → function 2 = I2C0SCL/I2C0SDA) and
- the NVIC numbers: `IRQ_GPIOJ = INT_GPIOJ − 16 = 51` → bit 19 in `NVIC_EN1_R` (51 − 32).

**Writing single pins:** `GPIO_PORTK_DATA_BITS_R[mask] = value` only changes the pins whose bit is
set in `mask` (address masking of the `GPIODATA` register, data sheet chapter GPIO, "Data Register Operation").

**Baud rate:** `BRD = 16 000 000 / (16 · 115 200) = 8.6806` → `IBRD = 8`,
`FBRD = round(0.6806 · 64) = 44`.

**I2C clock:** `TPR = 16 MHz / (2 · (6 + 4) · 100 kHz) − 1 = 7`.

**Reading the keypad:**

```c
// idle state: all rows HIGH -> a key press makes its column HIGH -> interrupt (GPIOK_Handler)
for (row = 0; row < 4; row++) {
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << row;            // only this row HIGH
    cols = (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) >> 4;
    if (cols) { key = keymap[row][first column that is set]; break; }
}
GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;                  // all rows HIGH again
```

## 3. Option A: in the simulator (web console)

1. Build: in CCS (import as in Example 01, `example03_webkonsole.projectspec`) or
   ```bash
   cd ~/lab/renode4mc-haw/examples/example03_webkonsole
   make
   ```
2. Start the web console (the first build takes a few minutes):
   ```bash
   cd ~/lab/renode4mc-haw/webconsole
   docker compose up --build
   ```
3. Create an experiment with OLED, MB1242 and keypad – the ready-made file `sim/experiments/webkonsole.json`
   is shown in the [guide, section 3](../../docs/GUIDE.md#3-adding-a-new-experiment). The
   experiment "Simple elements" (`example1`) that comes with the repository only has LEDs, push
   buttons, UART and an HC-SR04; OLED, sensor and keypad are missing there (as with `ucsim`, see below).
4. Open http://localhost:3000, choose this experiment, select `example03_webkonsole.out`, **Start**.

What you should see:

- In the **terminal**: `renode4mc-haw - Example 03 Web console`, then `Distance: 100 cm`.
- On the **OLED**: title, `DISTANCE: 100 CM`, `KEY: -`, `UART: -`.
- **D2** blinks at 1 Hz.
- **Slider** below 50 cm: **D1** goes on, terminal and OLED show the new distance.
- Press **keypad** "5": `Key: 5`, when released `Key released`.
- **USR_SW1**/**USR_SW2**: **D3**/**D4** are toggled.
- Type into the **terminal**: the characters come back (echo), the last one is shown on the OLED.

`make sim` (i.e. `ucsim`) only starts the simple simulator: there D2 blinks, but OLED, sensor
and keypad are missing. The simulator reports once per address *"no device at address 0x3C"*.

### Try it yourself

- Remove `SYSCTL_RCGCI2C_R |= …`. The program stays in the wait loop on `PRI2C`, and no output
  appears. Why? Also remove `(SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0` from the condition. Now the
  simulator warns *"I2C0: access … without clock!"*.
- Change `OLED_ADDR` to `0x3D`. What does `i2c_wait()` return?
- In `keypad_scan()`, remove setting the row (`GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << row`).
  Which key is detected?

## 4. Option B: on the board

In addition to the EK-TM4C1294XL you need: an SSD1306 OLED module (I2C, 3.3 V), an MB1242 sensor
(3.3–5 V) and a 4×3 membrane keypad. Connect them as in the table above. Most OLED modules already
have pull-up resistors for SCL/SDA. Import, build and debug work as in Example 02, section 4.
You can watch the UART e.g. with `picocom -b 115200 /dev/ttyACM0`.

> **Note:** on the hardware, push buttons and keypad bounce. The program does not debounce, because
> the simulator does not model bouncing. Add a lock-out time for this (e.g. 50 ms using `ticks`).

## 5. Exercises

1. Also show the time since start (in seconds, from `ticks`) in OLED line 2.
2. Send the command `L` via the terminal → all LEDs off, `H` → all on.
3. Switch the UART reception to interrupt mode (`UART0_IM_R` with `UART_IM_RXIM`/`UART_IM_RTIM`, `UART0_Handler`, NVIC IRQ `INT_UART0 − 16` = 5).
4. Build a code lock: after entering `1234#` on the keypad, D1 lights up for 2 s.

## 6. Notes on the simulator

- The UART transmits with correct timing at the configured baud rate (`TXFF`/`BUSY` as on the
  board). I2C transfers without bus delay; polling the busy flag is still necessary, because
  otherwise the program does not work on the hardware.
- The ultrasonic sensor returns the set value immediately. The real measurement takes about 80 ms,
  which is why the program only reads the value at the next 100 ms tick.
- Details about the models: [docs/WEBCONSOLE.md](../../docs/WEBCONSOLE.md), section 2.
