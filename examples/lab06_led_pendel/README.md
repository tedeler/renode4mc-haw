# Lab 06 – LED-Pendel mit HC-SR04 (Musterlösung Exercise 6)

Musterlösung zu „LED pendulum with ultrasonic module“. Sie löst die Aufgaben 1, 2.b und 3.b mit
Abfrage (Polling), wie in diesem Versuch verlangt. Im Simulator: Web-Konsole, Versuch
**lab2_pendel** ([docs/LABORE.md](../../docs/LABORE.md)).

| | |
|---|---|
| Pendel | LEDs PM0–PM7 (PM7 = LED 7 oben), R/L an PL0 (steigend = linker, fallend = rechter Umkehrpunkt) |
| HC-SR04 | Trigger PD0, Echo PD1 |
| Timer | Timer2A, 32 Bit, frei laufend, Zeitbasis |
| Ausgabe | `printf()` in der CCS-Konsole, Abstand als Text „65cm“ auf dem Pendel |

**Ablauf:**
1. Linker Umkehrpunkt (Abfrage von R/L), danach im Schwung links → rechts das Bild ausgeben:
   Balken links, Text, Balken rechts.
2. Rechter Umkehrpunkt: die Dauer des Schwungs messen.
3. Im Schwung rechts → links messen: Trigger 12 µs HIGH, danach die Echo-Dauer bestimmen.

Die Zeitpunkte der Spalten folgen aus `x(t) = −cos(π·t/Th)`, also `t = Th·acos(−x)/π`. Sie stehen
als Tabelle `ereignisZeit_q16` im Programm, wie bei
[lab04_pendeldisplay](../lab04_pendeldisplay/README.md). Erzeugt wurde die Tabelle mit:

```bash
python3 -c "import math; c=40; d=1.6/(c-1); e=[-0.8-d/2+k*d for k in range(c+1)]; f=lambda x: round(math.acos(-x)/math.pi*65536); print([f(-0.985),f(-0.94)]+[f(x) for x in e]+[f(0.94),f(0.985)])"
```
