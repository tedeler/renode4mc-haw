# Lab 01 – Blinky: LEDs blinken lassen

**Ziel:** Ihr erstes Mikrocontroller-Programm. Die LEDs **D1** und **D2** des Boards blinken
abwechselnd im Halbsekundentakt – zuerst im **Simulator**, dann auf dem **echten Board**.

**Vorher:** [Installation unter Linux](../../docs/INSTALL_LINUX.md) abgeschlossen.

| | |
|---|---|
| Board | EK-TM4C1294XL (Mikrocontroller TM4C1294NCPDT, ARM Cortex-M4F) |
| LEDs | D1 = Pin **PN1**, D2 = Pin **PN0** (Port N, Pin 1 bzw. 0) |
| Takt | 16 MHz (der Takt direkt nach dem Einschalten; wir ändern ihn nicht) |
| Dateien | `main.c` (Programm), `lab01_blinky.projectspec` (CCS-Projekt), `Makefile` (Terminal-Build) |

---

## 1. Was Sie lernen

- Ein Mikrocontroller-Pin ist ein Anschluss, den das Programm über **Register** steuert. Ein Register
  ist ein 32-Bit-Wert an einer festen Adresse; Schreiben auf diese Adresse stellt Hardware um.
- Bevor man ein Peripherie-Modul (z. B. einen GPIO-Port) benutzt, muss man seinen **Takt
  einschalten** („Clock Gating“, Register `RCGCGPIO`). Ohne Takt löst jeder Zugriff einen Fehler aus.
- Pins müssen als **Ausgang** (`DIR`) und **digital** (`DEN`) konfiguriert werden, bevor man sie schreibt (`DATA`).
- **Bitoperationen** (`|=`, `&= ~`, `^=`) ändern einzelne Bits, ohne die anderen anzufassen.
- Mit einer **Warteschleife** verzögert man den Ablauf – die CPU ist dabei
  voll beschäftigt (das verbessert Lab 02 mit einem Timer).

## 2. Das Programm verstehen (`main.c`)

Es wird **keine Bibliothek** verwendet. Oben in `main.c` stehen die Registeradressen als `#define`;
jede Adresse ist **Basisadresse + Offset** aus dem Datenblatt:

| Register | Adresse | Wirkung hier |
|---|---|---|
| `RCGCGPIO` | `0x400FE608` | Bit 12 = 1: Port N bekommt Takt (Bit *n* = Port *n*, A = 0 … N = 12) |
| `PRGPIO` | `0x400FEA08` | Bit 12 = 1: Port N ist bereit |
| `GPIODIR` (Port N) | `0x40064400` | Bit = 1: Pin ist Ausgang |
| `GPIODEN` (Port N) | `0x4006451C` | Bit = 1: Pin digital aktiv |
| `GPIODATA` (Port N) | `0x400643FC` | Pegel der Pins (Bit 0 = PN0, Bit 1 = PN1) |

```c
SYSCTL_RCGCGPIO |= PORT_N;                        // 1. Takt für Port N an (Bit 12 setzen)
while ((SYSCTL_PRGPIO & PORT_N) == 0) {}          // 2. warten, bis Port bereit
GPION_DIR |= PIN0 | PIN1;                         // 3. PN0, PN1 = Ausgänge
GPION_DEN |= PIN0 | PIN1;                         //    und digital
GPION_DATA = PIN1;                                // Start: D1 an, D2 aus
while (1) {
    warten(HALBE_SEKUNDE);                        // 4. ca. 0,5 s warten
    GPION_DATA ^= PIN0 | PIN1;                    // 5. beide LEDs umschalten (XOR)
}
```

Die Wartezeit ist eine leere Zählschleife (`volatile`, damit der Compiler sie nicht entfernt). Ein
Durchlauf braucht etwa 12 Takte, bei 16 MHz sind `HALBE_SEKUNDE` ≈ 700 000 Durchläufe knapp eine halbe Sekunde.
Die genaue Zeit hängt vom Compiler und von der Optimierung ab – deshalb nimmt man in Lab 02 einen Timer.

---

## 3. Variante A: Im Simulator (ohne Board)

Der Simulator führt **dieselbe `.out`-Datei** aus wie das Board.

### 3.1 Übersetzen

Im Terminal:

```bash
$ cd ~/praktikum/renode4mc-haw/examples/lab01_blinky
$ make
```

Ergebnis: Datei `lab01_blinky.out`. Fehlermeldung „tiarmclang nicht gefunden“ → Abschnitt
*Häufige Probleme* in der Installationsanleitung.

*Alternativ* können Sie die `.out`-Datei in CCS bauen (Abschnitt 4) und diese simulieren.

### 3.2 Simulator starten

```bash
$ ucsim lab01_blinky.out
```

Es öffnet sich die Seite **„EK-TM4C1294XL – LEDs“** im Browser (falls nicht: Datei
`sim/visualizer/ek-tm4c1294xl.html` selbst im Browser öffnen). Unten steht „Verbunden mit
Simulator“, und **D1 und D2 blinken abwechselnd**. Mit `Strg+C` im Terminal beenden.

Die vier LEDs der Anzeige entsprechen den vier User-LEDs des Boards (D1 PN1, D2 PN0, D3 PF4, D4 PF0).

### 3.3 Selbst ausprobieren

- Ändern Sie `HALBE_SEKUNDE` auf `70000u` (ca. 0,05 s), `make`, `ucsim` neu starten.
- Entfernen Sie testweise die Zeile `SYSCTL_RCGCGPIO |= PORT_N;` und simulieren Sie erneut: Im
  Terminal erscheint die Warnung *„GPIO Port N: Zugriff … ohne Takt!“*, die LEDs bleiben aus. Auf dem
  Board würde das Programm im HardFault landen – ein sehr häufiger Anfängerfehler.

---

## 4. Variante B: Auf dem echten Board mit CCS

### 4.1 Projekt in CCS importieren

1. CCS starten (`~/ti/ccs2040/ccs/theia/ccstudio`).
2. Menü **File → Import Projects…** (bzw. in der Ansicht „CCS Project Explorer“ → *Import*), den
   Typ **CCS Projects** wählen und die Datei
   `~/praktikum/renode4mc-haw/examples/lab01_blinky/lab01_blinky.projectspec` auswählen.
3. Das Projekt braucht keine weiteren Einstellungen (keine Bibliothek, keine Pfadvariablen).

**Wenn die Oberfläche nicht wie beschrieben reagiert**, importieren Sie im Terminal – das
funktioniert ohne Klicken und ist von uns getestet:

```bash
$ cd ~/praktikum/renode4mc-haw
$ tools/ccs-import.sh examples/lab01_blinky
```

Das Projekt liegt danach im Workspace `~/ccs_workspace`; in CCS starten Sie mit
`-data`/„Switch Workspace“ auf diesen Ordner.

### 4.2 Bauen

Rechtsklick auf das Projekt **lab01_blinky → Build Project** (Hammer-Symbol). In der Konsole muss
am Ende `Finished building target: "lab01_blinky.out"` und **0 errors** stehen.

### 4.3 Board anschließen und Programm laden

1. Board mit dem USB-Kabel an Port **DEBUG** anschließen (nicht USER). Die Power-LED leuchtet.
2. Menü **Run → Debug** (oder Käfer-Symbol). CCS lädt das Programm über die Debug-Verbindung
   „Stellaris ICDI“ und hält am Anfang von `main` an.
3. **Run → Resume** (grüner Pfeil/`F8`): D1 und D2 blinken abwechselnd.
4. Zum Beenden **Terminate** (rotes Quadrat).

Das Programm liegt danach im Flash des Boards: Nach Aus- und Einstecken des USB-Kabels startet es
von selbst wieder.

---

## 5. Im Simulator debuggen (Zusatz)

Sie können den Ablauf Schritt für Schritt verfolgen:

```bash
$ ucsim --debug lab01_blinky.out      # Terminal 1: Simulator wartet auf den Debugger
$ gdb-multiarch lab01_blinky.out      # Terminal 2
(gdb) target remote localhost:3333
(gdb) break main
(gdb) continue
(gdb) next                            # Zeile für Zeile
(gdb) quit
```

Das Debuggen mit der CCS-Oberfläche gegen den Simulator ist in `docs/TOOLCHAIN.md` beschrieben
(noch nicht fertig integriert).

---

## 6. Wie genau ist der Simulator?

- Das **Zeitverhalten** von Warteschleifen ist ungefähr (±30 %), nicht taktgenau.
- Modelliert sind: Clock-Gating (SYSCTL), GPIO (Ports A–Q), Timer 0–7, Interrupts (SysTick ist im Prozessormodell enthalten, aber noch nicht gesondert getestet).
  UART und ADC folgen (siehe `docs/ROADMAP.md`).

## 7. Aufgaben

1. Lassen Sie **D3 (PF4)** und **D4 (PF0)** zusätzlich blinken (Port F = Bit 5 in `RCGCGPIO`,
   Basisadresse `0x4005D000`; Offsets von `DIR`/`DEN`/`DATA` wie bei Port N – im Datenblatt nachschlagen). Welche Zeile fehlt, wenn die LEDs dunkel bleiben?
2. Erzeugen Sie ein **Lauflicht** über alle vier LEDs.
3. Messen Sie mit einer Stoppuhr, wie genau 0,5 s auf dem Board sind. Warum weicht der Wert ab?
