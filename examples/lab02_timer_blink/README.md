# Lab 02 – Timer-Blink: LED blinkt per Timer-Interrupt

**Ziel:** Die LED **D1** blinkt im Halbsekundentakt – diesmal ohne Warteschleife. Ein **Timer**
löst alle 0,5 s einen **Interrupt** aus, dessen Routine die LED umschaltet. Die CPU kann
währenddessen schlafen. Erst im **Simulator**, dann auf dem **echten Board**.

**Vorher:** [Installation](../../docs/INSTALL_LINUX.md) abgeschlossen und
[Lab 01](../lab01_blinky/README.md) verstanden (Clock-Gating, GPIO-Ausgang).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT) |
| LED | D1 = Pin **PN1** |
| Takt | 16 MHz (unverändert) |
| Timer | Timer0, Hälfte A, 32 Bit, periodisch |
| Dateien | `main.c`, `lab02_timer_blink.projectspec`, `Makefile` |

---

## 1. Was Sie lernen

- Ein **Timer** zählt mit dem Systemtakt von einem Startwert auf 0 herunter und meldet das
  („Time-out“). Im **periodischen Modus** beginnt er danach selbst wieder von vorn.
- Ein **Interrupt** unterbricht das Hauptprogramm und ruft eine **Interrupt-Routine (ISR)** auf. Danach
  läuft das Hauptprogramm weiter.
- Die Freigabe eines Interrupts besteht aus **drei Schaltern**: im Peripherie-Modul (Timer), im
  Interrupt-Controller NVIC (`IntEnable`) und global in der CPU (`IntMasterEnable`).
- Das **Interrupt-Flag** muss in der ISR gelöscht werden, sonst springt die CPU sofort wieder hinein.
- Timer haben – wie GPIO – ein **Clock-Gating** (`SysCtlPeripheralEnable(SYSCTL_PERIPH_TIMER0)`).

## 2. Das Programm verstehen (`main.c`)

Startwert für 0,5 s: **16 000 000 Takte/s × 0,5 s = 8 000 000** Takte. Der Timer zählt
von `Startwert` bis 0, das sind `Startwert + 1` Takte; deshalb `TimerLoadSet(... , 8 000 000 − 1)`.

```c
SysCtlPeripheralEnable(SYSCTL_PERIPH_GPION);    // Takt für Port N
SysCtlPeripheralEnable(SYSCTL_PERIPH_TIMER0);   // Takt für Timer0
GPIOPinTypeGPIOOutput(GPIO_PORTN_BASE, GPIO_PIN_1);

TimerConfigure(TIMER0_BASE, TIMER_CFG_PERIODIC);          // 32 Bit, periodisch
TimerLoadSet(TIMER0_BASE, TIMER_A, 8000000 - 1);          // 0,5 s
TimerIntEnable(TIMER0_BASE, TIMER_TIMA_TIMEOUT);          // Schalter 1: im Timer
IntEnable(INT_TIMER0A);                                   // Schalter 2: im NVIC
IntMasterEnable();                                        // Schalter 3: in der CPU
TimerEnable(TIMER0_BASE, TIMER_A);                        // los!

while(1) { __asm volatile("wfi"); }                       // CPU schläft bis zum Interrupt

void TIMER0A_Handler(void)                                // die ISR
{
    TimerIntClear(TIMER0_BASE, TIMER_TIMA_TIMEOUT);       // Flag löschen
    ... PN1 umschalten ...
}
```

Der Name **`TIMER0A_Handler`** ist kein Zufall: Er steht in der **Vektortabelle** in
`common/startup_tm4c1294.c`. Wenn Timer0A einen Interrupt auslöst, springt die CPU über diese
Tabelle zur Funktion mit genau diesem Namen. Alle Namen der Tabelle finden Sie in der Datei
(z. B. `GPIOA_Handler`, `UART0_Handler`, `SysTick_Handler`).

---

## 3. Variante A: Im Simulator

```bash
$ cd ~/praktikum/renode4mc-haw/examples/lab02_timer_blink
$ make
$ ucsim lab02_timer_blink.out
```

Im Browser blinkt **D1** (die linke LED) im 0,5-s-Takt (also 1 s Periodendauer). Mit `Strg+C` beenden.

### Selbst ausprobieren

- Ändern Sie `/ 2u` in `/ 10u` (0,1 s): `make`, `ucsim` neu starten.
- Entfernen Sie `TimerIntClear(...)`: Die ISR wird dauernd neu aufgerufen (die LED flimmert). Warum?
- Entfernen Sie `SysCtlPeripheralEnable(SYSCTL_PERIPH_TIMER0)`: Der Simulator warnt
  *„Timer: Zugriff ohne Takt!“*.

### Debuggen im Simulator (Haltepunkt in der ISR)

```bash
$ ucsim --debug lab02_timer_blink.out       # Terminal 1
$ gdb-multiarch lab02_timer_blink.out       # Terminal 2
(gdb) target remote localhost:3333
(gdb) break TIMER0A_Handler
(gdb) continue                              # hält nach 0,5 s in der ISR
(gdb) bt                                    # Aufrufkette
(gdb) quit
```

---

## 4. Variante B: Auf dem Board mit CCS

1. **Import:** In CCS **File → Import Projects…** und
   `examples/lab02_timer_blink/lab02_timer_blink.projectspec` wählen. Die Pfadvariable
   `TIVAWARE_ROOT` muss auf Ihre TivaWare zeigen (siehe Lab 01, Abschnitt 4.1).
   Ohne Oberfläche: `tools/ccs-import.sh examples/lab02_timer_blink`.
2. **Bauen:** Rechtsklick auf das Projekt → **Build Project**; am Ende **0 errors**.
3. **Board:** USB am Port **DEBUG**; **Run → Debug**; dann **Resume**. **D1** blinkt.
4. **Haltepunkt in der ISR:** Doppelklick links neben die Zeile `TimerIntClear(...)` in
   `TIMER0A_Handler`, dann Resume – CCS hält bei jedem Interrupt an.
   Im Fenster **Registers** sehen Sie die Timer0-Register (`GPTM`), z. B. `GPTMRIS`.

---

## 5. Unterschied zu Lab 01

| | Lab 01 | Lab 02 |
|---|---|---|
| Zeitmessung | CPU zählt in der Schleife | Hardware-Timer |
| CPU während der Wartezeit | 100 % ausgelastet | schläft (`wfi`) |
| Genauigkeit | ungefähr | taktgenau (16 MHz) |
| Zusätzliche Hardware | – | Timer0, NVIC, Interrupt |

## 6. Aufgaben

1. Lassen Sie **D1 mit 1 Hz** und zusätzlich **D2 (PN0)** mit 2 Hz blinken – mit **einem** Timer.
   (Tipp: Der Timer löst alle 125 ms aus; D2 wird bei jedem 2., D1 bei jedem 4. Aufruf umgeschaltet – mit einem Zähler in der ISR.)
2. Verwenden Sie statt `TIMER_CFG_PERIODIC` den Modus `TIMER_CFG_ONE_SHOT`. Was passiert?
3. Berechnen Sie den Startwert für 250 ms und für 5 s (Achtung: der Startwert muss in 32 Bit passen).

## 7. Hinweise zum Simulator

- Zeitverhalten: Timer sind **taktgenau** in Simulationszeit; auf dem PC läuft sie in etwa
  Echtzeit. Schleifen-Wartezeiten wie in Lab 01 sind ungenauer.
- Modelliert sind 32-/16-Bit-Betrieb A/B, periodisch und One-Shot, Time-out-Interrupt. Nicht
  modelliert: Capture, PWM, Match, Aufwärtszählen, ADC-Trigger.
