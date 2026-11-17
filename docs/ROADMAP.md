# Roadmap: peripheral support for students

> **Status:** M0 (framework, bit-banding), M1 (clock gating), M3 (GPIO) and M4 (timer) are implemented
> (see `sim/`, examples in `examples/`). M5 (UART) is implemented at its core (`sim/models/TivaUART.cs`:
> registers, FIFOs, interrupts, the line as signal edges with baud-rate timing, framing/parity errors,
> break; system clock from the PLL registers; open: µDMA, RX time-out timing, IrDA/9-bit). In addition –
> deviating from "Out of scope" – there is an I2C master (`TivaI2C.cs`) with OLED, ultrasonic sensor
> and keypad models for the web console ([WEBCONSOLE.md](WEBCONSOLE.md), Example 03).
> Lab sessions Lab 1–4 with their own environments, reference solutions and strict register checks:
> [LABS.md](LABS.md). Open: M2 (SysTick test), M6 (ADC), timer edge-count/RTC, bus fault on
> access without clock.
> The following sections describe the original plan.

Goal: students write normal TM4C1294 firmware (registers or TivaWare `driverlib`) and run it
unchanged in Renode. Needed are **SYSCTL (clock gating), SysTick, GPIO, timer (GPTM), UART and ADC**.
Everything else (I2C, SSI, CAN, USB, Ethernet, EPI, …) is out of scope for now.

References: data sheet TM4C1294NCPDT (SPMS433), `TivaWare/inc/tm4c1294ncpdt.h`
(addresses, bit fields, IRQ numbers), `TivaWare/driverlib/*.c` (expected hardware behaviour).

## Existing
- Cortex-M4F, NVIC, flash, SRAM (Renode built-ins; SysTick is part of the Renode CPU).
- `TivaGPIOPort` (only `DATA`, `DIR`, `DEN`) for port N, SYSCTL only as a stub (reads `0xFFFFFFFF`).
- WebSocket bridge + browser visualisation.

## Architecture decision
Own C# models in `renode_bridge/` (later `renode_models/`) based on
`RegistersCollection`/`DoubleWordRegister`. Register skeletons are generated from `tm4c1294ncpdt.h`
(script in `tools/`), the logic is added by hand. Existing Renode models
(e.g. `UART.PL011`, `Timers.ARM_SP804_Timer`) are only used if the register layout really
fits – otherwise we build our own.

## Milestones

### M0 – framework (prerequisite for everything)
- Register generator: `tm4c1294ncpdt.h` → C# register definitions (offset, name, reset value).
- ~~Clean up the platform `tm4c1294ncpdt.repl`, take the peripheral addresses from the header.~~ Done:
  `common/tm4c1294ncpdt.h` (TI) is in the repository; `tools/check_header.py` checks the addresses,
  clock bits and IRQs of the platform, the register offsets/bits of the models, the vector table and
  that the examples do not define any addresses of their own.
- Robot tests (`renode-test`) as a framework for automatic acceptance per milestone.
- **Bit-banding** (`0x42000000–0x43FFFFFF`) for peripherals and SRAM: `driverlib` uses it to access
  single bits (already noticed in the test with TI's `blinky.out`).
- Timing decision: set the CPU frequency in Renode (`PerformanceInMips`) to match the
  simulated system clock, so that timer/UART times are realistic.

### M1 – SYSCTL with clock gating
- `RCGC*`/`SCGC*`/`DCGC*` (run/sleep/deep sleep) and `PR*` (peripheral ready) for **GPIO
  (`RCGCGPIO` 0x608 / `PRGPIO` 0xA08), timer (0x604 / 0xA04), UART (0x618 / 0xA18), ADC
  (0x638 / 0xA38)**.
- Access to a peripheral **without** its clock enabled: warning in the log, registers read 0 /
  writes are ignored (on real hardware: bus fault) – the most important teaching point
  ("forgot the clock"). Can be switched to fault.
- `PR*` is only set shortly after `RCGC*` (as in hardware), so that wait loops are tested.
- Clock generation, so that `SysCtlClockFreqSet()` (driverlib) runs through: `MOSCCTL`, `RSCLKCFG`,
  `PLLFREQ0/1`, `PLLSTAT`, `RIS`/`MISC` (PLL lock, MOSC status), `MEMTIM0`, `RCC/RCC2`.
  The simulated system clock is computed from these registers and distributed to timer/UART/ADC.
- Reset cause (`RESC`), `DID0/DID1` identification, software reset (`APINT`).
- Acceptance: `main.c` with `SysCtlClockFreqSet(120 MHz)` runs; `SysCtlClockGet()` returns 120 MHz.

### M2 – SysTick
- Renode's own SysTick of the Cortex-M CPU: check reload, current, control, interrupt handler in
  the vector table; clock = system clock from M1.
- Complete the vector table in the labs (currently only SP, reset, NMI, HardFault).
- Acceptance: 1 ms tick counter, blinky without a busy loop.

### M3 – GPIO (ports A–Q, 15 ports)
- All registers: `DATA` (mask addressing), `DIR`, `IS/IBE/IEV/IM/RIS/MIS/ICR`
  (interrupts), `AFSEL`, `DR2R/4R/8R`, `ODR`, `PUR/PDR`, `DEN`, `AMSEL`, `PCTL`, `LOCK/CR`.
- Triggering interrupts (edge/level) via the NVIC; inputs from the browser (`PIN:n:v`).
- Pin assignment of the board EK-TM4C1294XL: LEDs (PN0, PN1, PF0, PF4), push buttons USR_SW1 (PJ0),
  USR_SW2 (PJ1) as `led`/`button` peripherals.
- Extend the bridge so that **all** pins/ports are transmitted instead of only pin 0
  (JSON `port`, `pin`, `state`), visualizer with LEDs and push buttons.
- Acceptance: a push-button interrupt toggles an LED; driverlib `GPIOPinTypeGPIOOutput` etc. work.

### M4 – timer (GPTM 0–7)
- 16/32-bit modes, one-shot, periodic, RTC, input capture (edge count/time), PWM mode.
- Timer A/B separate (split) and concatenated (32/64 bit), prescaler, `TAILR/TAMATCHR/TAV`,
  `IMR/RIS/MIS/ICR`, interrupts to the NVIC, ADC trigger (`ADCEV`).
- Time base from M1; counting as a Renode `LimitTimer`, not cycle by cycle.
- Acceptance: periodic timer interrupt at 1 Hz, measuring the period in simulated time.

### M5 – UART (UART0–7)
- Registers: `DR`, `FR`, `IBRD/FBRD/LCRH`, `CTL`, `IFLS`, `IM/RIS/MIS/ICR`, FIFO (16 bytes) with
  thresholds, error/break flags, baud-rate timing.
- Check whether `UART.PL011` from Renode can be reused (layout = ARM PrimeCell); otherwise build our own.
- Connection: Renode terminal (`showAnalyzer`), socket (`uart.CreateServerSocketTerminal`),
  optionally a browser console via the bridge.
- UART0 = virtual COM port of the board (PA0/PA1) as default.
- Acceptance: `printf`/`UARTprintf` and an echo program via terminal.

### M6 – ADC (ADC0, ADC1)
- Sample sequencers 0–3 (depth 8/4/4/1), `ACTSS`, `EMUX` (software, timer, GPIO, continuous),
  `SSMUXn`, `SSCTLn`, `SSFIFOn`, interrupts (`IM/RIS/ISC`), oversampling (`SAC`), `PSSI`.
- 12 bit, channels AIN0–AIN19; input values come from the browser (slider → bridge) or
  from a CSV file (`csv2resd` from Renode, reproducible measurement series).
- Internal temperature sensor channel with a fixed example value.
- Acceptance: potentiometer in the browser → ADC value printed via UART.

### M7 – labs & documentation
- `example_systick`, `example_gpio_irq`, `example_timer`, `example_uart`, `example_adc`, each with
  `main.c`, `Makefile`, `sim.resc` and a matching visualizer page.
- Shared start-up/vector table files in `labs/common/`.
- Guide "Creating a new lab", troubleshooting, known differences from the hardware.

## Out of scope (for now)
I2C, SSI, CAN, USB, Ethernet, EPI, uDMA, QEI, PWM module, comparators, EEPROM, hibernate,
crypto, flash controller (write/erase), low-power modes. On access, a stub should print a
clear warning ("not implemented") instead of silently returning `0`.

## Known risks
- **Timing:** Renode is not cycle-accurate; loops such as `for(i<5000000)` take a different
  amount of simulated time than on hardware. Time measurement based on timers/SysTick is reliable.
- **ROM functions:** the TM4C1294 has `driverlib` in ROM (`ROM_*` calls, `0x01000000`).
  The ROM image is not part of the simulation; labs should link `driverlib` from flash.
- **Licence:** TivaWare headers/sources are not copied into the repository; only the generator is.
