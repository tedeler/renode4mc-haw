# Praktikumsversuche im Simulator (Lab 1–4)

Für jeden Versuch des Mikrocontroller-Praktikums gibt es in der [Web-Konsole](WEBCONSOLE.md) eine
eigene Umgebung mit der Peripherie aus den Laborunterlagen. Dazu gehört je eine Musterlösung zum
Vergleich. Versuch 1 und 2 der Web-Konsole sowie die Beispiele `lab01`–`lab04` sind unverändert.

| Umgebung (`sim/experiments/`) | Laborunterlage | Peripherie | Musterlösung (`examples/`) |
|---|---|---|---|
| `lab1_gpio` | MCL Lab Session 1 (CCS, GPIO) | Hex-Keypad 4×4, 7-Segment-/BCD-Anzeige, LEDs, Taster | `lab05_hexkeypad_bcd` |
| `lab2_pendel` | Exercise 6 „LED pendulum with ultrasonic module“ | LED-Pendel (HAW), HC-SR04 | `lab06_led_pendel` (Abfrage/Polling) |
| `lab3_nvic` | „Nested Vectored Interrupt Controller“ | wie Lab 2, alle Timer-Interrupts | `lab07_nvic_pendel` (nur Interrupts, mehrere Dateien) |
| `lab4_uart` | „Controlling a microcontroller with the PC via UART“ | UART0-Terminal 9600 7N1, LEDs D1–D4, USR_SW1 | `lab08_uart_leds` |

In jeder Umgebung gibt es zusätzlich:

- **CCS-Konsole (printf):** `printf()`/`puts()` erscheinen wie in Code Composer Studio. Das
  TI-Laufzeitsystem schreibt dafür eine Nachricht in `_CIOBUF_` und läuft über die Marke `C$$IO$$`.
  Auf dem Board hält dort der Debugger an, im Simulator übernimmt das `sim/models/TiCioConsole.cs`
  über einen Renode-Hook. Für `printf()` braucht das Projekt einen Heap (`--heap_size=2048`, wie in
  Lab 4 beschrieben).
- **Diagnose:** Jede Warnung der Modelle erscheint oben in der Web-Konsole, ebenso jede Warnung und
  jeder Fehler von Renode. Das betrifft vor allem Fehlkonfigurationen von Registern (siehe unten).
  Auf dem Board würde das Programm in diesen Fällen einfach nicht funktionieren. Im Simulator steht
  dabei, warum.
- **Musterlösung starten:** Ein Knopf in der Kopfzeile lädt statt der eigenen `.out` die
  Musterlösung. So sehen Studierende, wie sich das fertige Programm verhalten soll. Neben dem
  Versuchstitel steht dann „Musterlösung läuft“.

## Die Umgebungen im Einzelnen

Die Pins sind eine mögliche Verdrahtung nach den Bildern der Laborunterlagen. Wer anders
verdrahtet, ändert nur die `.repl`-Datei des Versuchs.

### Lab 1 – Hex-Keypad und BCD-Anzeige

| Baustein | Pins | Modell |
|---|---|---|
| Hex-Keypad 4×4 (Tasten 0–F, Belegung wie Bild 1) | Spalten X1–X4 = PM0–PM3 (Ausgänge), Zeilen Y1–Y4 = PM4–PM7 (Eingänge) | `HexKeypad` |
| 7-Segment-Anzeige, 2 Module × 2 Ziffern (8421-BCD) | D0–D7 = PK0–PK7, EN rechts (Ziffern 1/0) = PL0, EN links (Ziffern 3/2) = PL1 | `BcdDisplay` |

- **Keypad:** Die Firmware setzt nacheinander eine Spalte auf 0. Eine gedrückte Taste zieht ihre
  Zeile dann auf 0, sonst hält der 100-kΩ-Pull-up des Keypads die Zeile auf 1 (Bild 2).
  **Laufzeitverzögerung:** Der Wechsel 0 → 1 einer Zeile braucht `riseTimeUs` = 20 µs, denn nur der
  schwache Pull-up lädt die Leitung um. Liest die Firmware ohne `wait()` gleich nach dem Umschalten,
  sieht sie noch den Pegel der vorigen Spalte. Dann erscheinen falsche oder mehrere Tasten, wie auf
  dem Board.
- **BCD-Anzeige:** Solange EN = 1 ist, übernimmt das Modul D0–D7. Mit EN = 0 hält es den Wert
  (Bild 4). A–F zeigt sie wie ein Hex-Decoder. Vor der ersten Übernahme bleibt ein Modul dunkel.

### Lab 2 und Lab 3 – LED-Pendel und HC-SR04

| Baustein | Pins | Modell |
|---|---|---|
| LED-Pendel „Swinging LED“, Drehpunkt unten | LEDs PM0–PM7 (HIGH = an), **LED 7 = PM7 ist die oberste** | `PendulumDisplay` mit `syncMode: "direction"` |
| Signal R/L | PL0: **steigende Flanke = linker Umkehrpunkt, fallende = rechter Umkehrpunkt** (HIGH beim Schwung links → rechts) | |
| Ultraschall HC-SR04 | Trigger = PD0, Echo = PD1 | `HcSr04` |

- **Pendel:** Es ist dasselbe Modell und Widget wie in Versuch 2 / Lab 04, nur mit dem Signal aus
  dem Skript (Bild 2). Es schwingt mit ca. 8,3 Hz, also ca. 60 ms je Schwung. Im Browser lässt sich
  die Frequenz von 2 bis 15 Hz einstellen, auf dem Board ist sie fest. Frequenzwechsel gelten ab
  dem nächsten Umkehrpunkt.
- **HC-SR04:** Die fallende Flanke am Trigger startet eine Messung (Bild 5). Echo geht ca. 450 µs
  danach auf HIGH, für 58,3 µs pro cm (Schall 343 m/s, hin und zurück). Außerhalb von 3–300 cm
  bleibt Echo 200 ms HIGH (Skript NVIC, Tabelle 2.1). Solange eine Messung läuft, ignoriert das
  Modul weitere Trigger.
- **Lab 3:** Der Aufbau ist derselbe. GPIO-Interrupts gibt es für Port D (IRQ 3), Port L (IRQ 53)
  und Port J (IRQ 51), Timer-Interrupts für Timer 0–7.

### Lab 4 – UART

UART0 an PA0/PA1. Das Terminal im Browser ist eingestellt wie Tera Term im Skript: 9600 Bit/s,
7N1, lokales Echo, empfangenes CR als neue Zeile. Dazu kommen die LEDs D1–D4 (PN1, PN0, PF4, PF0)
und USR_SW1/2 (PJ0/PJ1, gegen GND).

## Strenge Prüfung der Register (nach Datenblatt SPMS433)

Die Modelle bilden das Datenblatt genau nach und melden Fehlkonfigurationen in der Diagnose.
Fehler werden dabei nicht stillschweigend „repariert“:

| Bereich | Verhalten wie auf dem Chip | Meldung |
|---|---|---|
| GPIO | Eingang mit `DEN = 0` liest 0; Ausgang ohne `DEN` treibt nicht | „PM4 wird als Eingang gelesen, aber GPIODEN = 0 …“ |
| GPIO | Offener Eingang (nichts angeschlossen, Taster losgelassen, kein PUR/PDR) liest 0 | „PJ0 ist ein offener Eingang …“ (beim Lesen bzw. beim Freigeben des Interrupts) |
| GPIO | PDR setzen löscht PUR und umgekehrt; PC0–3, PD7, PE7 nur mit GPIOLOCK/GPIOCR änderbar | „… ist geschützt (JTAG/NMI) …“ |
| GPIO | Interrupt freigegeben, aber `DEN = 0` | „… es kommt nie ein Interrupt“ |
| Timer | TnR/TnV wie Tabelle 13-4 (abwärts: True Prescaler, aufwärts: lineare Erweiterung), Reset-Werte, TnILD | Konfiguration bei laufendem Timer, reservierte/nicht modellierte Modi (Capture, PWM, RTC, Match-Interrupt), ILR > 16 Bit, Prescaler > 8 Bit, Start mit ILR = 0 |
| UART | IBRD/FBRD gelten erst nach dem Schreiben von LCRH; nur WLEN Datenbits; ohne AFSEL/PCTL/DEN an PA0/PA1 kein Zeichen | „Zeichen verlässt den Chip nicht – UART0 TX-Pin falsch konfiguriert: PA1: GPIOPCTL PMC1 = 0 statt 1“ |
| UART | Baudrate/Format passen nicht zum Terminal (mehr als 2,5 % daneben) → **Zeichensalat** in beide Richtungen | „Firmware ist auf 115108 Baud 8N1 eingestellt …, das Terminal erwartet 9600 Baud 7N1“ |
| UART | Zeichen vom Terminal kommen im Takt der Leitung an (9600 Bit/s 7N1: ca. alle 0,94 ms), Overrun bei vollem FIFO | „Empfangs-FIFO voll …“ |
| alle | Zugriff ohne Takt (RCGC*) wird ignoriert | „Zugriff ohne Takt! …“ |

Taster in der Web-Konsole: Gedrückt verbindet den Pin mit GND. Losgelassen ist der Pin **offen**,
nur ein Pull-up der Firmware hält ihn dann auf 1. Das gilt jetzt in allen Versuchen. Die Beispiele
lab03/lab04 setzen den Pull-up und laufen unverändert.

## Musterlösungen bauen

Die Musterlösungen sind die Beispiele `examples/lab05`–`lab08`. Für CCS und das Board baut man sie
wie die anderen Beispiele (`make` mit tiarmclang oder `.projectspec` importieren). Die Web-Konsole
lädt gcc-Builds aus `sim/solutions/<Beispiel>.elf`:

```bash
tools/build-solutions.sh                               # arm-none-eabi-gcc aus dem PATH
CC=/pfad/arm-none-eabi-gcc tools/build-solutions.sh
```

Das Docker-Image baut sie selbst (Stufe `solutions` im `webconsole/Dockerfile`, Debian-Paket
`gcc-arm-none-eabi`). Statt des TI-Laufzeitsystems nutzt der gcc-Build newlib. `tools/gcc/cio_gcc.c`
schickt `printf()` dabei über dasselbe CIO-Protokoll, die Ausgabe erscheint also ebenfalls in der
CCS-Konsole. Welche Musterlösung zu welchem Versuch gehört, steht in der Versuchs-JSON:
`"solution": { "example": "lab05_hexkeypad_bcd", "label": "…" }`.

## Test

```bash
cd webconsole/backend && npm start &
# Musterlösungen und absichtlich falsche Varianten nach /tmp/fw/out bauen (siehe Kopf von e2e_labs.js)
node test/e2e_labs.js /tmp/fw/out              # ONLY=lab1,lab4,solution für einen Teil
```

`test/e2e_labs.js` prüft jede Umgebung mit ihrer Musterlösung:

- Keypad mit printf (Anforderungen 1 und 2) und BCD-Anzeige
- HC-SR04 bei 42/123/330/7 cm mit printf
- das Pendelbild Spalte für Spalte im Schwung links → rechts, auch bei 5 Hz
- UART-Befehle, LEDs, `#13<CR>` bei SW1 und Abbruch bei einem Syntaxfehler
- dass die Diagnose bei korrekter Firmware leer bleibt
- dass sie meldet: PM4 ohne DEN, fehlendes `wait()`, falsche Baudrate (Zeichensalat), PJ0 ohne Pull-up
- den Start aller Musterlösungen über `POST /api/solution`

## Grenzen

- **Nicht getestet:** mit tiarmclang gebaute Programme und das TI-Laufzeitsystem selbst (nur gcc
  mit nachgebildetem CIO-Protokoll), das Docker-Image (ohne Docker-Daemon in der Testumgebung) und
  echte Hardware.
- `scanf()` liest im Simulator nichts (CIO-read liefert Dateiende).
- Timer: Capture (Edge-Time/-Count über CCP-Pins), PWM, RTC und der Match-Interrupt sind nicht
  modelliert. Das Echo misst man deshalb mit einem GPIO-Interrupt an beiden Flanken und einem
  freilaufenden Timer, wie in `lab07_nvic_pendel`. Benutzt die Firmware einen dieser Modi, meldet
  die Diagnose es.
- Zugriff ohne Takt führt im Simulator nicht zum Bus-Fault wie auf dem Board, wird aber gemeldet.
- Zeiten sind auf ein Renode-Quantum genau (in den Lab-Umgebungen 10 µs). Busy-Wait-Programme
  laufen in der Simulation langsamer als in Echtzeit, die virtuelle Zeit stimmt trotzdem.
