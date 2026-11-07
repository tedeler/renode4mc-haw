# Lab 03 – NVIC: LED-Pendel und HC-SR04 mit Interrupts (Musterlösung)

Musterlösung zum Lab „Nested Vectored Interrupt Controller“: dieselbe Anzeige wie
[lab02_led_pendel](../lab02_led_pendel/README.md), aber ohne aktives Warten und mit eigenen
Header-Dateien. Im Simulator: Web-Konsole, Versuch **lab3_nvic**
([docs/LABORE.md](../../docs/LABORE.md)).

| Datei | Inhalt |
|---|---|
| `ultrasonic_hcsr04.h/.c` | HC-SR04 (PD0/PD1). Timer2A periodisch (30 ms) schaltet den Trigger (Anf. 1.3). Die Port-D-ISR misst das Echo an beiden Flanken (Anf. 1.2, 1.4). |
| `pendulum_haw.h/.c` | LED-Pendel (PM0–PM7, PL0). Die Port-L-ISR bedient die Umkehrpunkte, Timer0A (16 Bit One-Shot, Prescaler 16 → 1 µs, einziger One-Shot) die Spaltenzeitpunkte (Anf. 3.1, 3.2). `updateDisplay()` zeigt nur Abstände in Reichweite (Anf. 2.2, 2.3). |
| `zeitbasis.h/.c` | Timer1A läuft frei als Zeitbasis. Das ist der eigene Timer für die Messung (Anf. 1.1). |
| `board.h` | Takt und NVIC-Nummern (aus `INT_…` abgeleitet). Alle Registernamen und Bitkonstanten kommen aus `common/tm4c1294ncpdt.h` – keine eigenen Adressen. |
| `main.c` | Genau eine `while(1)`-Schleife mit `wfi` (Anf. 3.3). Gibt neue Messwerte mit `printf()` aus. |

Das Bild steht in einem Doppelpuffer. Das Hauptprogramm füllt den freien Puffer, die ISR wechselt
am linken Umkehrpunkt.
