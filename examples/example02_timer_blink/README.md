# Example 02 – Timer-Blink: LED blinkt per Timer-Interrupt

**Ziel:** Die LED **D1** blinkt im Halbsekundentakt – diesmal ohne Warteschleife. Ein **Timer**
löst alle 0,5 s einen **Interrupt** aus, dessen Routine die LED umschaltet. Die CPU kann
währenddessen schlafen. Erst im **Simulator**, dann auf dem **echten Board**.

**Vorher:** [Installation](../../docs/INSTALL_LINUX.md) abgeschlossen und
[Example 01](../example01_blinky/README.md) verstanden (Clock-Gating, GPIO-Ausgang).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT) |
| LED | D1 = Pin **PN1** |
| Takt | 16 MHz (unverändert) |
| Timer | Timer0, Hälfte A, 32 Bit, periodisch |
| Dateien | `main.c`, `example02_timer_blink.projectspec`, `Makefile` |

---

## 1. Was Sie lernen

- Ein **Timer** zählt mit dem Systemtakt von einem Startwert auf 0 herunter und meldet das
  („Time-out“). Im **periodischen Modus** beginnt er danach selbst wieder von vorn.
- Ein **Interrupt** unterbricht das Hauptprogramm und ruft eine **Interrupt-Routine (ISR)** auf. Danach
  läuft das Hauptprogramm weiter.
- Die Freigabe eines Interrupts besteht aus **drei Schaltern**: im Peripherie-Modul (Register
  `GPTMIMR`), im Interrupt-Controller NVIC (Register `ISER0`) und global in der CPU (Befehl `cpsie i`).
- Das **Interrupt-Flag** muss in der ISR gelöscht werden (Register `GPTMICR`), sonst springt die CPU
  sofort wieder hinein.
- Timer haben – wie GPIO – ein **Clock-Gating** (Register `RCGCTIMER`, Bit 0 = Timer0).

## 2. Das Programm verstehen (`main.c`)

Registernamen und Bitkonstanten kommen wie in Example 01 aus `tm4c1294ncpdt.h` (siehe Datenblatt,
Kapitel „General-Purpose Timers“, Registerübersicht). Im Programm steht keine Adresse.

| Register (Datenblatt) | Name in `tm4c1294ncpdt.h` | Adresse | Wirkung hier |
|---|---|---|---|
| `RCGCTIMER` | `SYSCTL_RCGCTIMER_R` | `0x400FE604` | `SYSCTL_RCGCTIMER_R0` (Bit 0): Timer0 bekommt Takt |
| `PRTIMER` | `SYSCTL_PRTIMER_R` | `0x400FEA04` | `SYSCTL_PRTIMER_R0` (Bit 0): Timer0 ist bereit |
| `GPTMCFG` | `TIMER0_CFG_R` | `0x40030000` | `TIMER_CFG_32_BIT_TIMER` (0): ein 32-Bit-Timer |
| `GPTMTAMR` | `TIMER0_TAMR_R` | `0x40030004` | `TIMER_TAMR_TAMR_PERIOD` (Bits 1:0 = 2): periodisch (zählt abwärts) |
| `GPTMCTL` | `TIMER0_CTL_R` | `0x4003000C` | `TIMER_CTL_TAEN` (Bit 0): Timer läuft |
| `GPTMIMR` | `TIMER0_IMR_R` | `0x40030018` | `TIMER_IMR_TATOIM` (Bit 0): Time-out löst Interrupt aus |
| `GPTMICR` | `TIMER0_ICR_R` | `0x40030024` | `TIMER_ICR_TATOCINT` (Bit 0) schreiben: Time-out-Flag löschen |
| `GPTMTAILR` | `TIMER0_TAILR_R` | `0x40030028` | Startwert |
| NVIC `EN0` | `NVIC_EN0_R` | `0xE000E100` | Bit 19 = 1: Interrupt Nr. 19 (Timer0A) freigeben |

**Interrupt-Nummer:** Die Headerdatei zählt die Einträge der Vektortabelle: `INT_TIMER0A` = 35.
Die ersten 16 Einträge sind Prozessor-Ausnahmen (Reset, HardFault, SysTick …), im NVIC ist
Timer0A deshalb der Interrupt 35 − 16 = **19** (`IRQ_TIMER0A` in `main.c`).

Startwert für 0,5 s: **16 000 000 Takte/s × 0,5 s = 8 000 000** Takte. Der Timer zählt
von `Startwert` bis 0, das sind `Startwert + 1` Takte; deshalb `8 000 000 − 1`.

```c
SYSCTL_RCGCGPIO_R  |= PORT_N;                  // Takt für Port N
SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;     // Takt für Timer0
while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R12) == 0 ||
       (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0) {}                  // bereit?
GPIO_PORTN_DIR_R |= PIN1;  GPIO_PORTN_DEN_R |= PIN1;   // PN1 = digitaler Ausgang

TIMER0_CTL_R   = 0;                            // Timer zum Konfigurieren ausschalten
TIMER0_CFG_R   = TIMER_CFG_32_BIT_TIMER;       // 32 Bit
TIMER0_TAMR_R  = TIMER_TAMR_TAMR_PERIOD;       // periodisch
TIMER0_TAILR_R = 8000000 - 1;                  // 0,5 s
TIMER0_IMR_R  |= TIMER_IMR_TATOIM;             // Schalter 1: im Timer
NVIC_EN0_R     = 1u << IRQ_TIMER0A;            // Schalter 2: im NVIC (Bit 19)
__asm volatile("cpsie i");                     // Schalter 3: in der CPU
TIMER0_CTL_R  |= TIMER_CTL_TAEN;               // los!

while (1) { __asm volatile("wfi"); }           // CPU schläft bis zum Interrupt

void TIMER0A_Handler(void)                     // die ISR
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;         // Flag löschen
    GPIO_PORTN_DATA_R ^= PIN1;                 // PN1 umschalten
}
```

Der Name **`TIMER0A_Handler`** ist kein Zufall: Er steht in der **Vektortabelle** in
`common/startup_tm4c1294.c`. Wenn Timer0A einen Interrupt auslöst, springt die CPU über diese
Tabelle zur Funktion mit genau diesem Namen. Alle Namen der Tabelle finden Sie in der Datei
(z. B. `GPIOA_Handler`, `UART0_Handler`, `SysTick_Handler`).

---

## 3. Variante A: Im Simulator

```bash
cd ~/praktikum/renode4mc-haw/examples/example02_timer_blink
make
ucsim example02_timer_blink.out
```

Im Browser blinkt **D1** (die linke LED) im 0,5-s-Takt (also 1 s Periodendauer). Mit `Strg+C` beenden.

### Selbst ausprobieren

- Ändern Sie `/ 2u` in `/ 10u` (0,1 s): `make`, `ucsim` neu starten.
- Entfernen Sie die Zeile `TIMER0_ICR_R = TIMER_ICR_TATOCINT;` in der ISR: Sie wird dauernd neu aufgerufen (die LED flimmert). Warum?
- Entfernen Sie `SYSCTL_RCGCTIMER_R |= …`: Der Simulator warnt
  *„Timer: Zugriff ohne Takt!“*.

### Debuggen im Simulator (Haltepunkt in der ISR)

```bash
ucsim --debug example02_timer_blink.out       # Terminal 1
gdb-multiarch example02_timer_blink.out       # Terminal 2
(gdb) target remote localhost:3333
(gdb) break TIMER0A_Handler
(gdb) continue                              # hält nach 0,5 s in der ISR
(gdb) bt                                    # Aufrufkette
(gdb) quit
```

---

## 4. Variante B: Auf dem Board mit CCS

1. **Import:** In CCS **File → Import Projects…** und
   `examples/example02_timer_blink/example02_timer_blink.projectspec` wählen. Es sind keine weiteren
   Einstellungen nötig (keine Bibliothek).
   Ohne Oberfläche: `tools/ccs-import.sh examples/example02_timer_blink`.
2. **Bauen:** Rechtsklick auf das Projekt → **Build Project**; am Ende **0 errors**.
3. **Board:** USB am Port **DEBUG**; **Run → Debug**; dann **Resume**. **D1** blinkt.
4. **Haltepunkt in der ISR:** Doppelklick links neben die Zeile `GPIO_PORTN_DATA_R ^= PIN1;` in
   `TIMER0A_Handler`, dann Resume – CCS hält bei jedem Interrupt an.
   Im Fenster **Registers** sehen Sie die Timer0-Register (`GPTM`), z. B. `GPTMRIS`.
5. **Alternativ ohne CCS:** `.out`-Datei im Terminal laden (nach `sudo apt install openocd`):
   ```bash
   openocd -f board/ti_ek-tm4c1294xl.cfg -c "program example02_timer_blink.out verify reset exit"
   ```
   Details: [Installationsanleitung, Schritt 9](../../docs/INSTALL_LINUX.md).

---

## 5. Unterschied zu Example 01

| | Example 01 | Example 02 |
|---|---|---|
| Zeitmessung | CPU zählt in der Schleife | Hardware-Timer |
| CPU während der Wartezeit | 100 % ausgelastet | schläft (`wfi`) |
| Genauigkeit | ungefähr | taktgenau (16 MHz) |
| Zusätzliche Hardware | – | Timer0, NVIC, Interrupt |

## 6. Aufgaben

1. Lassen Sie **D1 mit 1 Hz** und zusätzlich **D2 (PN0)** mit 2 Hz blinken – mit **einem** Timer.
   (Tipp: Der Timer löst alle 125 ms aus; D2 wird bei jedem 2., D1 bei jedem 4. Aufruf umgeschaltet – mit einem Zähler in der ISR.)
2. Stellen Sie `GPTMTAMR` auf den Modus **One-Shot** (Wert 1). Was passiert?
3. Berechnen Sie den Startwert für 250 ms und für 5 s (Achtung: der Startwert muss in 32 Bit passen).

## 7. Hinweise zum Simulator

- Zeitverhalten: Timer sind **taktgenau** in Simulationszeit; auf dem PC läuft sie in etwa
  Echtzeit. Schleifen-Wartezeiten wie in Example 01 sind ungenauer.
- Modelliert sind 32-/16-Bit-Betrieb A/B, periodisch und One-Shot, Time-out-Interrupt. Nicht
  modelliert: Capture, PWM, Match, Aufwärtszählen, ADC-Trigger.
