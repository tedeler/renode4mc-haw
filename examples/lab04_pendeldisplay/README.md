# Lab 04 – Pendeldisplay: UART, Ultraschall und POV-Anzeige

**Ziel:** Ein **Pendel mit 8 LEDs** schwingt 10-mal pro Sekunde. Schaltet die Firmware die LEDs
genau im richtigen Moment, sieht das Auge ein stehendes Bild („persistence of vision“, POV).
Auf dem Pendel erscheint der Abstand, den der **Ultraschallsensor** misst, z. B. `123CM`. Der
Abstand wird außerdem über **UART0** ausgegeben. Erst im **Simulator** (Web-Konsole), dann auf
dem **Board** mit Zusatz-Hardware.

**Vorher:** [Lab 02](../lab02_timer_blink/README.md) (Timer, Interrupt) und
[Lab 03](../lab03_webkonsole/README.md) (UART, I2C, Ultraschallsensor).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT), Takt 16 MHz (unverändert) |
| Pendel-LEDs | PM0–PM7 (Ausgang), PM0 = LED am Drehpunkt (oben), PM7 = LED an der Spitze |
| Pendel-Signal | PL0 (Eingang): **HIGH = Pendel rechts von der Mitte**, LOW = links; Interrupt bei beiden Flanken |
| Pendel | 10 Schwingungen pro Sekunde (Periode T = 100 ms); in der Web-Konsole 2–25 Hz einstellbar |
| UART0 | PA0 RX / PA1 TX, 115200 Baud, 8N1 (virtueller COM-Port des Boards) |
| I2C0 | PB2 SCL / PB3 SDA, 100 kHz |
| Ultraschall | MaxBotix MB1242 (I2CXL-MaxSonar), I2C-Adresse 0x70 |
| LED D2 | PN0, Herzschlag 1 Hz |
| Timer | Timer0A 100 ms (Sensor), Timer1A Einmal-Timer (Spalten), Timer2A freilaufend (Zeitbasis) |
| Dateien | `main.c`, `lab04_pendeldisplay.projectspec`, `Makefile` |

---

## 1. Was Sie lernen

- **Zeitkritische Ausgabe mit Timern:** Ein **Einmal-Timer** löst zum Beginn jeder Bildspalte
  einen Interrupt aus. Ein zweiter, **freilaufender** Timer dient als Uhr.
- **Absolute statt relativer Zeitpunkte:** Startet man den nächsten Timer immer relativ zum
  letzten Interrupt, addieren sich die Verzögerungen der Interrupt-Routine. Hier wird jeder
  Spaltenbeginn absolut auf der Uhr berechnet.
- **Synchronisation auf ein externes Signal:** Die Flanken an PL0 markieren den Durchgang des
  Pendels durch die Mitte. Aus dem Abstand zweier steigender Flanken misst die Firmware die
  Periode und passt den Zeitplan an.
- **Nichtlineare Bewegung:** Das Pendel ist in der Mitte schnell und an den Umkehrpunkten
  langsam. Gleich breite Spalten brauchen deshalb unterschiedlich lange Zeiten (Tabelle mit
  `asin`, in Ganzzahlen vorberechnet).
- **Bild als Bytes:** Eine Bildspalte ist ein Byte auf Port M (Bit n = LED n). Der 5×7-Zeichensatz
  aus Lab 03 passt direkt.

## 2. Das Prinzip

Die Auslenkung des Pendels folgt einer Sinusschwingung:

```
x(t) = sin(2·π·t / T)        x = −1: ganz links,  x = 0: Mitte,  x = +1: ganz rechts

Zeit t        0         25 ms        50 ms        75 ms        100 ms
Auslenkung    Mitte  →  ganz rechts → Mitte    →  ganz links → Mitte
Bewegung      nach rechts (0 … 25 ms), nach links (25 … 75 ms), nach rechts (75 … 100 ms)
PL0           ↑ HIGH ──────────────── ↓ LOW ─────────────────  ↑ HIGH
```

Die steigende Flanke an PL0 bedeutet also „Pendel läuft nach rechts durch die Mitte“, die
fallende Flanke „Pendel läuft nach links durch die Mitte“.

Das Bild hat **40 Spalten**. Sie verteilen sich gleichmäßig über die inneren 90 % des
Schwenkbereichs (`x` von −0,9 bis +0,9). Ganz außen ist das Pendel so langsam, dass die Spalten
zu breit würden. Spalte k beginnt bei `x(k) = −0,9 + 1,8·k/40`, also zur Zeit

```
t(k) = asin(x(k)) / (2·π) · T          (gemessen ab dem Durchgang durch die Mitte)
```

Für T = 100 ms dauert ein Bild von `t(0) = −17,8 ms` bis `t(40) = +17,8 ms`. Die Spalten in der
Mitte sind 0,72 ms lang, die äußersten 1,5 ms.

**Wichtig:** Die Flanke an PL0 liegt **mitten** im Bild. Die Firmware plant deshalb immer den
**nächsten** Durchgang durch die Mitte. Er liegt eine halbe Periode nach der letzten Flanke, in
der Gegenrichtung:

- PL0 HIGH (Pendel rechts) → der nächste Durchgang geht nach **links**: Spalten 39 … 0.
- PL0 LOW (Pendel links) → der nächste Durchgang geht nach **rechts**: Spalten 0 … 39.

Das Bild wird also bei jedem Schwung gezeichnet, 20-mal pro Sekunde.

## 3. Das Programm verstehen (`main.c`)

| Teil | Aufgabe |
|---|---|
| `spaltenZeit_q16[]` | `t(k)/T` in Einheiten von 1/65536 der Periode (mit Python vorberechnet, Befehl im Kommentar) |
| `zeitplan_berechnen()` | rechnet die Tabelle mit der gemessenen Periode in Timer-Takte um (`spaltenTakte[]`) |
| `GPIOL_Handler()` | Flanke an PL0: Zeitpunkt merken, bei steigender Flanke die Periode messen |
| `schwung_planen()` | nächsten Durchgang durch die Mitte berechnen (`mitte`), Richtung festlegen, Timer1A auf Spalte 0 |
| `spaltentimer_auf(k)` | Timer1A so stellen, dass er bei `mitte + t(k)` auslöst |
| `TIMER1A_Handler()` | Spalte auf Port M ausgeben, Timer auf die nächste Spalte; nach Spalte 39 LEDs aus, nächsten Schwung planen |
| `bild_text()` | Text zentriert ins Bild schreiben (5×7-Zeichensatz, Bit 0 = oben) |
| Hauptschleife | alle 200 ms Sensor messen, bei Änderung Bild und UART aktualisieren |

| Register | Adresse | Wirkung hier |
|---|---|---|
| `GPIOIBE` (Port L) | `0x40062408` | Bit 0: Interrupt bei **beiden** Flanken von PL0 |
| `GPIODATA` (Port M) | `0x400633FC` | alle 8 Bits auf einmal: eine Bildspalte |
| `GPTMTAMR` (Timer1) | `0x40031004` | `1`: Einmal-Modus |
| `GPTMTAILR` (Timer1) | `0x40031028` | Wartezeit bis zur nächsten Spalte (Takte − 1) |
| `GPTMCTL` (Timer1) | `0x4003100C` | Bit 0 (`TAEN`): Start; im Einmal-Modus schaltet der Timer sich danach ab |
| `GPTMTAV` (Timer2) | `0x40032050` | aktueller Stand der freilaufenden Uhr (zählt **abwärts**) |

Die Uhr (Timer2) zählt abwärts. „Später“ heißt deshalb „kleinerer Zählerstand“. Mit
vorzeichenlosen 32-Bit-Zahlen stimmt die Differenz `früher − später` auch über den Überlauf hinweg:

```c
uint32_t ziel  = mitte - (uint32_t)spaltenTakte[k];          // Zeitpunkt der Spalte k
int32_t warten = (int32_t)(TIMER_TAV(TIMER2_BASE) - ziel);   // Takte bis dahin
```

## 4. Variante A: Im Simulator (Web-Konsole)

1. Bauen: in CCS (Import wie in Lab 01, `lab04_pendeldisplay.projectspec`) oder
   ```bash
   cd ~/praktikum/renode4mc-haw/examples/lab04_pendeldisplay
   make
   ```
   Liegt CCS nicht unter `~/ti/ccs2040/ccs`, geben Sie den Pfad an, z. B.
   `make CCS_ROOT=~/tmp/ti/ccs2040/ccs`.
2. Web-Konsole starten:
   ```bash
   cd ~/praktikum/renode4mc-haw/webconsole
   docker compose up --build
   ```
3. http://localhost:3000 öffnen, **Versuch 2** wählen, `lab04_pendeldisplay.out` auswählen, **Start**.

Was Sie sehen sollten:

- Im **Terminal**: `renode4mc-haw - Lab 04 Pendeldisplay`, `Abstand: 100 cm`,
  `Pendelperiode: 100,0 ms`.
- Auf dem **Pendeldisplay**: `100CM`, als Kreisbogen wie auf einem echten Pendel.
- **D2** blinkt mit 1 Hz.
- **Schieberegler** des Sensors: Terminal und Pendel zeigen den neuen Abstand.
- **Pendelfrequenz** (Schieberegler am Pendel, 2–25 Hz): Das Terminal meldet die neu gemessene
  Periode, z. B. `Pendelperiode: 66,6 ms` bei 15 Hz, und das Bild bleibt stehen. Direkt nach dem
  Umstellen erscheint einmal ein Zwischenwert: Die erste Messung reicht über den Wechsel hinweg.
- Die Auswahl unter dem Pendel zeigt **beide Schwünge** (wie das Auge) oder nur einen. Zeichnet
  die Firmware nur in einer Richtung oder passen beide Richtungen nicht übereinander, sehen Sie
  das hier sofort.

### Selbst ausprobieren

- Stellen Sie `zeitplan_berechnen(t)` im `GPIOL_Handler()` still (auskommentieren) und ändern Sie
  die Pendelfrequenz. Was passiert mit dem Bild bei 5 Hz, was bei 20 Hz? Warum?

- Ersetzen Sie die `asin`-Tabelle durch gleich lange Spalten (`t(k)` linear in k). Wie sieht der
  Text jetzt aus?
- Kommentieren Sie in `schwung_planen()` die Zeile mit `nachLinks = …` aus (immer
  links → rechts ausgeben). Was passiert beim Rückschwung?

## 5. Variante B: Auf dem Board

Zusätzlich zum EK-TM4C1294XL nötig: ein Pendel mit 8 LEDs (je mit Vorwiderstand, z. B. 330 Ω
an 3,3 V; bei mehr Strom über Transistoren oder einen Treiber-Baustein), ein Sensor für den
Durchgang durch die Mitte (Gabellichtschranke oder Hallsensor; Ausgang so beschalten, dass PL0
HIGH ist, solange das Pendel rechts steht) und der MB1242-Sensor wie in Lab 03.

> **Hinweis:** Ein echtes Pendel schwingt nicht genau mit 10 Hz und verliert Amplitude. Die
> Firmware misst die Periode deshalb laufend. Weicht die Amplitude ab, wird das Bild schmaler oder
> breiter; die Tabelle gilt für eine feste Amplitude.

## 6. Aufgaben

1. Zeigen Sie unter 50 cm statt der Zahl `NAH` an (Zeichensatz um `N`, `A`, `H` erweitern).
2. Lassen Sie den Text im Takt von 0,2 s von rechts nach links durchlaufen (Laufschrift).
3. Messen Sie mit Timer2, wie lange `TIMER1A_Handler()` dauert, und geben Sie den größten Wert per
   UART aus.
4. Zeichnen Sie einen Balken, dessen Länge dem Abstand entspricht (0–400 cm → 0–40 Spalten).

## 7. Hinweise zum Simulator

- Das Pendelmodell (`sim/models/PendulumDisplay.cs`) rechnet in **virtueller Zeit**. Das Bild
  stimmt also auch dann, wenn der Rechner die Simulation langsamer ausführt.
- Versuch 2 stellt Renode auf 10-µs-Zeitscheiben (`emulation SetGlobalQuantum`), damit die
  LED-Wechsel genau genug erfasst werden.
- Eine neue Pendelfrequenz gilt ab dem nächsten Durchgang durch die Mitte. Ein echtes Pendel
  ändert seine Frequenz nicht sprunghaft; hier dient der Regler zum Testen der Periodenmessung.
- Das Modell zeigt pro Schwungrichtung den **letzten** Schwung. Helligkeitsverläufe, Nachglühen
  der LEDs und Dämpfung des Pendels werden nicht nachgebildet.
- Details zum Modell: [docs/WEBCONSOLE.md](../../docs/WEBCONSOLE.md), Abschnitt 2.
