# Example 05 – Timer mit CCP-Pins: PWM, Puls, Tastendauer

**Ziel:** Drei Timer arbeiten direkt an Pins, ohne dass die CPU den Pin selbst umschaltet:

- **Timer0** erzeugt an **LED1** eine PWM mit ca. **30 Hz** – die LED wirkt gedimmt.
  Die Taster wählen den Tastgrad: **Taste 0 = 0 %, Taste 1 = 25 %, Taste 2 = 50 %, Taste 3 = 100 %**.
- **Timer1** erzeugt an **LED2** einen Puls: **100 ms HIGH, jede Sekunde**.
- **Timer2** misst, **wie lange Taste 0 gedrückt** ist (Capture), und gibt die Zeit über den **UART** aus.

Timer0 und Timer1 laufen im **16-Bit-Compare-Mode**, Timer2 im **16-Bit-Capture-Mode**.

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT) |
| Takt | 16 MHz (unverändert) |
| Web-Konsole | Versuch **„Example 3 – Timer“** (`sim/experiments/example3.json`), Knopf „Musterlösung“ startet diese Demo |
| Dateien | `main.c`, `example05_timer_ccp.projectspec`, `Makefile` |

## Anschlüsse

| Baustein | Pin | Funktion (GPIOPCTL) | Bedeutung |
|---|---|---|---|
| LED1 | PL4 | T0CCP0 (3) | PWM von Timer0 A |
| LED2 | PL6 | T1CCP0 (3) | Puls von Timer1 A |
| LED3, LED4 | PL0, PL1 | GPIO-Ausgang | gewählte Stufe binär (LED4 LED3: 00 = 0 %, 01 = 25 %, 10 = 50 %, 11 = 100 %) |
| Taste 0 | PM0 | T2CCP0 (3) | 0 %, Eingang des Capture von Timer2 A |
| Taste 1..3 | PM1..PM3 | GPIO-Eingang | 25 %, 50 %, 100 % (GPIO-Interrupt bei fallender Flanke) |
| UART0 | PA0/PA1 | U0RX/U0TX (1) | 115200 Bit/s 8N1 |

Die Taster schalten gegen GND; die Firmware schaltet die internen Pull-ups ein (GPIOPUR).
Welche Pins zu welchem Timer gehören, steht im Datenblatt in Tabelle 13-2 („General-Purpose Timers
Signals“): CCP0 gehört zu Timer A, CCP1 zu Timer B.

## 1. Compare-Mode (Timer0 und Timer1)

Im **Timer Compare Action Mode** (Datenblatt 13.3.3.1) zählt der Timer wie gewohnt periodisch
herunter. Beim Time-out ändert **die Hardware** den CCP-Pin nach dem Feld **TCACT** in GPTMTnMR:

| TCACT | Wirkung beim Time-out |
|---|---|
| `TIMER_TAMR_TCACT_TOGGLE` (0x1) | Pin umschalten |
| `TIMER_TAMR_TCACT_CLRTO` (0x2) | Pin LOW |
| `TIMER_TAMR_TCACT_SETTO` (0x3) | Pin HIGH |
| 0x4 … 0x7 | zusätzlich sofort setzen/löschen |

TCACT darf sich bei laufendem Timer ändern (als einziges Feld in GPTMTnMR). Die Interrupt-Routine
plant deshalb immer **eine Phase voraus**: Gerade hat Phase *n+1* begonnen; die ISR legt fest, auf
welchen Pegel der Pin am Ende von Phase *n+1* springt (TCACT) und wie lange Phase *n+2* dauert
(GPTMTnILR). Mit **TnILD = 1** übernimmt der Timer das neue TnILR erst beim nächsten Time-out – die
laufende Phase bleibt ungestört, und der Pin wechselt taktgenau, auch wenn die ISR etwas später
drankommt.

**Rechnung (16-Bit-Modus, abwärts: der Prescaler ist ein „echter“ Vorteiler):**

| | Prescaler GPTMTnPR | 1 Takt | Periode | HIGH |
|---|---|---|---|---|
| Timer0 (PWM) | 15 → ÷16 | 1 µs | 33 333 Takte = 33,333 ms (30 Hz) | 25 %: 8 333, 50 %: 16 666 |
| Timer1 (Puls) | 255 → ÷256 | 16 µs | 62 500 Takte = 1 s | 6 250 Takte = 100 ms |

Beide Werte passen in die 16 Bit von GPTMTnILR (≤ 65 535). Bei 0 % und 100 % gibt es keine
Wechsel: Die ISR wählt dann immer dieselbe Aktion (CLRTO bzw. SETTO).

Bei 30 Hz flimmert eine echte LED noch leicht; das Auge mittelt aber schon so weit, dass sie gedimmt
aussieht. Die Web-Konsole zeigt eine LED, die schnell umschaltet, deshalb mit der gemittelten
Helligkeit.

## 2. Capture-Mode (Timer2)

Timer2 A läuft im **Input Edge-Time Mode** (13.3.3.4): `TAMR = TIMER_TAMR_TAMR_CAP | TIMER_TAMR_TACMR`,
`TIMER_CTL_TAEVENT_BOTH` (beide Flanken). Bei jeder Flanke an T2CCP0 speichert die Hardware den
Zählerstand in **GPTMTAR** und setzt **CAERIS** – der Zeitpunkt stimmt also auf einen Takt (62,5 ns),
egal wann die ISR läuft.

Im 16-Bit-Modus ist der Prescaler hier eine **Erweiterung** des Zählers: GPTMTAPR = 0xFF und
GPTMTAILR = 0xFFFF ergeben einen 24-Bit-Zähler, der nach 2²⁴ Takten = **1,048576 s** überläuft. Für
längere Tastendrücke zählt **Timer2 B** (periodisch, (0xFFFF+1)·(0xFF+1) = 2²⁴ Takte, im selben
Schreibzugriff auf GPTMCTL gestartet) die Überläufe mit – so empfiehlt es die Anmerkung zu Bild 13-3.
Timer2 B hat die höhere Interrupt-Priorität. Die Funktion `zeitstempel()` prüft mit gesperrten
Interrupts, ob ein Überlauf zwischen Flanke und Auslesen lag. Dauer = Zeitstempel(loslassen) −
Zeitstempel(drücken).

Ausgabe im Terminal:

```
PWM: 0 %
Taste 0 gedrueckt: 1799,790 ms
```

## 3. Ausprobieren in der Web-Konsole

1. Versuch **„Example 3 – Timer …“** wählen, **Musterlösung** starten (oder `main.c` selbst bauen
   und hochladen).
2. **Oszi** einschalten: CH1 = PL4 (PWM), CH2 = PL6 (Puls), CH3 = PM0 (Taste 0). Zeitbasis 20 ms/div
   für die PWM, 200 ms/div für den Puls.
3. Taste 1, 2, 3 drücken: Tastgrad am Oszilloskop und Helligkeit von LED1 ändern sich, LED3/LED4
   zeigen die Stufe.
4. Taste 0 halten: LED1 geht aus, nach dem Loslassen steht die Dauer im UART-Monitor. Vergleichen
   Sie sie mit der LOW-Zeit von CH3 am Oszilloskop.

Im Renode-Monitor zeigt `sysbus.timer0 CcpPins`, welche CCP-Pins ein Timer gerade benutzt.

## 4. Bauen

```bash
make          # tiarmclang aus CCS (siehe Makefile), Ergebnis example05_timer_ccp.out
make sim      # im Simulator starten
```

Für die Web-Konsole baut `tools/build-solutions.sh` die Demo mit gcc nach
`sim/solutions/example05_timer_ccp.elf`.

## 5. Aufgaben

- Ändern Sie die PWM-Frequenz auf 100 Hz. Welche Prescaler-/Startwerte sind nötig? Wann ist das
  Flimmern nicht mehr zu sehen?
- Lösen Sie die PWM von Timer0 stattdessen mit dem **PWM-Modus** des Timers (TnAMS = 1,
  GPTMTnMATCHR, Datenblatt 13.3.3.5) – ganz ohne Interrupt. Was ist bei 0 % und 100 % zu beachten
  (Bild 13-5/13-6)?
- Messen Sie zusätzlich die Zeit zwischen zwei Drücken von Taste 0.
