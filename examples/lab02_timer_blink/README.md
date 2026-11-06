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
- Die Freigabe eines Interrupts besteht aus **drei Schaltern**: im Peripherie-Modul (Register
  `GPTMIMR`), im Interrupt-Controller NVIC (Register `ISER0`) und global in der CPU (Befehl `cpsie i`).
- Das **Interrupt-Flag** muss in der ISR gelöscht werden (Register `GPTMICR`), sonst springt die CPU
  sofort wieder hinein.
- Timer haben – wie GPIO – ein **Clock-Gating** (Register `RCGCTIMER`, Bit 0 = Timer0).

## 2. Das Programm verstehen (`main.c`)

Alle Registeradressen stehen oben in `main.c` als `#define`. Jede Adresse ist **Basisadresse + Offset**
aus dem Datenblatt (Kapitel „General-Purpose Timers“, Registerübersicht).

| Register | Adresse | Wirkung hier |
|---|---|---|
| `RCGCTIMER` | `0x400FE604` | Bit 0 = 1: Timer0 bekommt Takt |
| `PRTIMER` | `0x400FEA04` | Bit 0 = 1: Timer0 ist bereit |
| `GPTMCFG` | `0x40030000` | 0 = ein 32-Bit-Timer |
| `GPTMTAMR` | `0x40030004` | Bits 1:0 = 2: periodisch (zählt abwärts) |
| `GPTMCTL` | `0x4003000C` | Bit 0 (`TAEN`) = 1: Timer läuft |
| `GPTMIMR` | `0x40030018` | Bit 0 (`TATOIM`) = 1: Time-out löst Interrupt aus |
| `GPTMICR` | `0x40030024` | Bit 0 = 1 schreiben: Time-out-Flag löschen |
| `GPTMTAILR` | `0x40030028` | Startwert |
| `NVIC ISER0` | `0xE000E100` | Bit 19 = 1: Interrupt Nr. 19 (Timer0A) freigeben |

Startwert für 0,5 s: **16 000 000 Takte/s × 0,5 s = 8 000 000** Takte. Der Timer zählt
von `Startwert` bis 0, das sind `Startwert + 1` Takte; deshalb `8 000 000 − 1`.

```c
SYSCTL_RCGCGPIO  |= PORT_N;                    // Takt für Port N
SYSCTL_RCGCTIMER |= 1;                         // Takt für Timer0
while ((SYSCTL_PRGPIO & PORT_N) == 0 || (SYSCTL_PRTIMER & 1) == 0) {}   // bereit?
GPION_DIR |= PIN1;  GPION_DEN |= PIN1;         // PN1 = digitaler Ausgang

TIMER0_CTL   = 0;                              // Timer zum Konfigurieren ausschalten
TIMER0_CFG   = 0;                              // 32 Bit
TIMER0_TAMR  = 2;                              // periodisch
TIMER0_TAILR = 8000000 - 1;                    // 0,5 s
TIMER0_IMR  |= 1;                              // Schalter 1: im Timer
NVIC_ISER0   = 1u << 19;                       // Schalter 2: im NVIC
__asm volatile("cpsie i");                     // Schalter 3: in der CPU
TIMER0_CTL  |= 1;                              // los!

while (1) { __asm volatile("wfi"); }           // CPU schläft bis zum Interrupt

void TIMER0A_Handler(void)                     // die ISR
{
    TIMER0_ICR = 1;                            // Flag löschen
    GPION_DATA ^= PIN1;                        // PN1 umschalten
}
```

Der Name **`TIMER0A_Handler`** ist kein Zufall: Er steht in der **Vektortabelle** in
`common/startup_tm4c1294.c`. Wenn Timer0A einen Interrupt auslöst, springt die CPU über diese
Tabelle zur Funktion mit genau diesem Namen. Alle Namen der Tabelle finden Sie in der Datei
(z. B. `GPIOA_Handler`, `UART0_Handler`, `SysTick_Handler`).

---

## 3. Variante A: Im Simulator

```bash
cd ~/praktikum/renode4mc-haw/examples/lab02_timer_blink
make
ucsim lab02_timer_blink.out
```

Im Browser blinkt **D1** (die linke LED) im 0,5-s-Takt (also 1 s Periodendauer). Mit `Strg+C` beenden.

### Selbst ausprobieren

- Ändern Sie `/ 2u` in `/ 10u` (0,1 s): `make`, `ucsim` neu starten.
- Entfernen Sie die Zeile `TIMER0_ICR = ICR_TATOCINT;` in der ISR: Sie wird dauernd neu aufgerufen (die LED flimmert). Warum?
- Entfernen Sie `SYSCTL_RCGCTIMER |= …`: Der Simulator warnt
  *„Timer: Zugriff ohne Takt!“*.

### Debuggen im Simulator (Haltepunkt in der ISR)

```bash
ucsim --debug lab02_timer_blink.out       # Terminal 1
gdb-multiarch lab02_timer_blink.out       # Terminal 2
(gdb) target remote localhost:3333
(gdb) break TIMER0A_Handler
(gdb) continue                              # hält nach 0,5 s in der ISR
(gdb) bt                                    # Aufrufkette
(gdb) quit
```

---

## 4. Variante B: Auf dem Board mit CCS

1. **Import:** In CCS **File → Import Projects…** und
   `examples/lab02_timer_blink/lab02_timer_blink.projectspec` wählen. Es sind keine weiteren
   Einstellungen nötig (keine Bibliothek).
   Ohne Oberfläche: `tools/ccs-import.sh examples/lab02_timer_blink`.
2. **Bauen:** Rechtsklick auf das Projekt → **Build Project**; am Ende **0 errors**.
3. **Board:** USB am Port **DEBUG**; **Run → Debug**; dann **Resume**. **D1** blinkt.
4. **Haltepunkt in der ISR:** Doppelklick links neben die Zeile `GPION_DATA ^= PIN1;` in
   `TIMER0A_Handler`, dann Resume – CCS hält bei jedem Interrupt an.
   Im Fenster **Registers** sehen Sie die Timer0-Register (`GPTM`), z. B. `GPTMRIS`.
5. **Alternativ ohne CCS:** `.out`-Datei im Terminal laden (nach `sudo apt install openocd`):
   ```bash
   openocd -f board/ti_ek-tm4c1294xl.cfg -c "program lab02_timer_blink.out verify reset exit"
   ```
   Details: [Installationsanleitung, Schritt 9](../../docs/INSTALL_LINUX.md).

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
2. Stellen Sie `GPTMTAMR` auf den Modus **One-Shot** (Wert 1). Was passiert?
3. Berechnen Sie den Startwert für 250 ms und für 5 s (Achtung: der Startwert muss in 32 Bit passen).

## 7. Hinweise zum Simulator

- Zeitverhalten: Timer sind **taktgenau** in Simulationszeit; auf dem PC läuft sie in etwa
  Echtzeit. Schleifen-Wartezeiten wie in Lab 01 sind ungenauer.
- Modelliert sind 32-/16-Bit-Betrieb A/B, periodisch und One-Shot, Time-out-Interrupt. Nicht
  modelliert: Capture, PWM, Match, Aufwärtszählen, ADC-Trigger.
