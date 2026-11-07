# Fahrplan: Peripherie-Unterstützung für Studierende

> **Stand:** M0 (Gerüst, Bit-Banding), M1 (Clock-Gating), M3 (GPIO) und M4 (Timer) sind umgesetzt
> (siehe `sim/`, Beispiele `examples/`). M5 (UART) ist im Kern umgesetzt (`sim/models/TivaUART.cs`:
> Register, RX-FIFO, Interrupts; offen: Baudraten-Timing, µDMA, Break/Fehler-Injektion). Zusätzlich –
> abweichend von „Nicht im Umfang“ – gibt es einen I2C-Master (`TivaI2C.cs`) mit OLED-, Ultraschall-
> und Keypad-Modell für die Web-Konsole ([WEBCONSOLE.md](WEBCONSOLE.md), Lab 03).
> Praktikumsversuche Lab 1–4 mit eigenen Umgebungen, Musterlösungen und strenger Registerprüfung:
> [LABORE.md](LABORE.md). Offen: M2 (SysTick-Test), M6 (ADC), Timer-Capture/PWM, Bus-Fault bei
> Zugriff ohne Takt.
> Die folgenden Abschnitte beschreiben den ursprünglichen Plan.

Ziel: Studierende schreiben normale TM4C1294-Firmware (Register oder TivaWare-`driverlib`) und
lassen sie unverändert in Renode laufen. Benötigt werden **SYSCTL (Clock-Gating), SysTick, GPIO,
Timer (GPTM), UART und ADC**. Alles andere (I2C, SSI, CAN, USB, Ethernet, EPI, …) ist
vorerst nicht im Umfang.

Referenzen: Datenblatt TM4C1294NCPDT (SPMS433), `TivaWare/inc/tm4c1294ncpdt.h`
(Adressen, Bitfelder, IRQ-Nummern), `TivaWare/driverlib/*.c` (erwartetes Hardwareverhalten).

## Vorhanden
- Cortex-M4F, NVIC, Flash, SRAM (Renode-Bordmittel; SysTick ist Teil der Renode-CPU).
- `TivaGPIOPort` (nur `DATA`, `DIR`, `DEN`) für Port N, SYSCTL nur als Stub (liest `0xFFFFFFFF`).
- WebSocket-Bridge + Browser-Visualisierung.

## Architektur-Entscheidung
Eigene C#-Modelle in `renode_bridge/` (bzw. später `renode_models/`) auf Basis von
`RegistersCollection`/`DoubleWordRegister`. Registergerüste werden aus `tm4c1294ncpdt.h`
generiert (Skript in `tools/`), die Logik wird von Hand ergänzt. Vorhandene Renode-Modelle
(z. B. `UART.PL011`, `Timers.ARM_SP804_Timer`) werden nur verwendet, wenn das Registerlayout
tatsächlich passt – sonst Eigenbau.

## Meilensteine

### M0 – Gerüst (Voraussetzung für alles)
- Registergenerator: `tm4c1294ncpdt.h` → C#-Registerdefinitionen (Offset, Name, Reset-Wert).
- Plattform `tm4c1294ncpdt.repl` bereinigen, Peripherie-Adressen aus Header übernehmen.
- Robot-Tests (`renode-test`) als Rahmen für automatische Abnahme je Meilenstein.
- **Bit-Banding** (`0x42000000–0x43FFFFFF`) für Peripherie und SRAM: `driverlib` greift darüber auf Einzelbits zu
  (im Test mit TIs `blinky.out` bereits aufgefallen).
- Entscheidung Timing: Taktfrequenz der CPU in Renode (`PerformanceInMips`) passend zum
  simulierten Systemtakt setzen, damit Timer/UART-Zeiten realistisch sind.

### M1 – SYSCTL mit Clock-Gating
- `RCGC*`/`SCGC*`/`DCGC*` (Run/Sleep/Deep-Sleep) und `PR*` (Peripheral Ready) für **GPIO
  (`RCGCGPIO` 0x608 / `PRGPIO` 0xA08), Timer (0x604 / 0xA04), UART (0x618 / 0xA18), ADC
  (0x638 / 0xA38)**.
- Zugriff auf eine Peripherie **ohne** aktiviertes Clock-Gating: Warnung im Log und
  Register lesen 0 / Schreiben ignorieren (auf echter Hardware: Bus-Fault) – wichtigster
  didaktischer Punkt („Takt vergessen“). Umschaltbar auf Fault.
- `PR*` wird erst kurz nach `RCGC*` gesetzt (wie in Hardware), damit Warteschleifen
  getestet werden.
- Takterzeugung, damit `SysCtlClockFreqSet()` (driverlib) durchläuft: `MOSCCTL`, `RSCLKCFG`,
  `PLLFREQ0/1`, `PLLSTAT`, `RIS`/`MISC` (PLL-Lock, MOSC-Status), `MEMTIM0`, `RCC/RCC2`.
  Simulierter Systemtakt wird aus diesen Registern berechnet und an Timer/UART/ADC verteilt.
- Reset-Ursache (`RESC`), `DID0/DID1`-Kennung, Software-Reset (`APINT`).
- Abnahme: `main.c` mit `SysCtlClockFreqSet(120 MHz)` läuft; `SysCtlClockGet()` liefert 120 MHz.

### M2 – SysTick
- Renode-eigener SysTick der Cortex-M-CPU: Reload, Current, Control, Interrupt-Handler in
  der Vektortabelle prüfen; Takt = Systemtakt aus M1.
- Vektortabelle in den Labs vervollständigen (derzeit nur SP, Reset, NMI, HardFault).
- Abnahme: 1-ms-Tick-Zähler, Blinky ohne Busy-Loop.

### M3 – GPIO (Ports A–Q, 15 Ports)
- Alle Register: `DATA` (Maskenadressierung), `DIR`, `IS/IBE/IEV/IM/RIS/MIS/ICR`
  (Interrupts), `AFSEL`, `DR2R/4R/8R`, `ODR`, `PUR/PDR`, `DEN`, `AMSEL`, `PCTL`, `LOCK/CR`.
- Interrupt-Auslösung (Flanke/Pegel) über den NVIC; Eingänge aus dem Browser (`PIN:n:v`).
- Pin-Zuordnung zum Board EK-TM4C1294XL: LEDs (PN0, PN1, PF0, PF4), Taster USR_SW1 (PJ0),
  USR_SW2 (PJ1) als `led`-/`button`-Peripherie.
- Bridge so erweitern, dass **alle** Pins/Ports statt nur Pin 0 übertragen werden
  (JSON `port`, `pin`, `state`), Visualizer mit LEDs und Tastern.
- Abnahme: Taster-Interrupt toggelt LED; driverlib `GPIOPinTypeGPIOOutput` etc. laufen.

### M4 – Timer (GPTM 0–7)
- 16/32-Bit-Modi, One-Shot, Periodic, RTC, Input-Capture (Edge-Count/Time), PWM-Modus.
- Timer A/B getrennt (Split) und verkettet (32/64 Bit), Prescaler, `TAILR/TAMATCHR/TAV`,
  `IMR/RIS/MIS/ICR`, Interrupts in den NVIC, ADC-Trigger (`ADCEV`).
- Zeitbasis aus M1; Zählung als Renode-`LimitTimer`, nicht Zyklus-für-Zyklus.
- Abnahme: periodischer Timer-Interrupt mit 1 Hz, Messung der Periode in Simulationszeit.

### M5 – UART (UART0–7)
- Register: `DR`, `FR`, `IBRD/FBRD/LCRH`, `CTL`, `IFLS`, `IM/RIS/MIS/ICR`, FIFO (16 Byte) mit
  Schwellwerten, Fehler-/Break-Flags, Baudratenzeit.
- Prüfen, ob `UART.PL011` aus Renode wiederverwendbar ist (Layout = ARM PrimeCell); sonst Eigenbau.
- Anbindung: Renode-Terminal (`showAnalyzer`), Socket (`uart.CreateServerSocketTerminal`),
  optional Browser-Konsole über die Bridge.
- UART0 = Virtual COM Port des Boards (PA0/PA1) als Standard.
- Abnahme: `printf`/`UARTprintf` und Echo-Programm per Terminal.

### M6 – ADC (ADC0, ADC1)
- Sample Sequencer 0–3 (Tiefe 8/4/4/1), `ACTSS`, `EMUX` (Software, Timer, GPIO, Continuous),
  `SSMUXn`, `SSCTLn`, `SSFIFOn`, Interrupts (`IM/RIS/ISC`), Oversampling (`SAC`), `PSSI`.
- 12 Bit, Kanäle AIN0–AIN19; Eingangswerte kommen aus dem Browser (Schieberegler → Bridge) oder
  aus einer CSV (`csv2resd` aus Renode, reproduzierbare Messreihen).
- Interne Temperatursensor-Kanal als fester Beispielwert.
- Abnahme: Poti im Browser → ADC-Wert per UART ausgegeben.

### M7 – Labs & Dokumentation
- `lab02_systick`, `lab03_gpio_irq`, `lab04_timer`, `lab05_uart`, `lab06_adc` mit je
  `main.c`, `Makefile`, `sim.resc`, passender Visualizer-Seite.
- Gemeinsame Startup-/Vektortabellen-Dateien in `labs/common/`.
- Anleitung „Neues Lab anlegen“, Fehlersuche, bekannte Abweichungen zur Hardware.

## Nicht im Umfang (vorerst)
I2C, SSI, CAN, USB, Ethernet, EPI, uDMA, QEI, PWM-Modul, Komparatoren, EEPROM, Hibernate,
Crypto, Flash-Controller (Schreiben/Löschen), Low-Power-Modi. Bei Zugriff soll ein
Stub eine eindeutige Warnung („nicht implementiert“) ausgeben statt still `0` zu liefern.

## Bekannte Risiken
- **Timing:** Renode läuft nicht zyklengenau; Schleifen wie `for(i<5000000)` dauern
  in Simulationszeit anders als auf Hardware. Timer/SysTick-basierte Zeitmessung ist verlässlich.
- **ROM-Funktionen:** Der TM4C1294 hat `driverlib` im ROM (`ROM_*`-Aufrufe, `0x01000000`).
  Das ROM-Image ist nicht Teil der Simulation; Labs sollen `driverlib` aus dem Flash linken.
- **Lizenz:** TivaWare-Header/-Quellen werden nicht ins Repo kopiert; nur der Generator.
