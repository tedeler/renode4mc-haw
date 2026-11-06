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

- Ein Mikrocontroller-Pin ist ein Anschluss, den das Programm über **Register** steuert.
- Bevor man ein Peripherie-Modul (z. B. einen GPIO-Port) benutzt, muss man seinen **Takt
  einschalten** („Clock Gating“, Register `RCGCGPIO`). Ohne Takt löst jeder Zugriff einen Fehler aus.
- Pins müssen als **Ausgang** konfiguriert werden, bevor man sie schreibt.
- Mit einer **Warteschleife** (`SysCtlDelay`) verzögert man den Ablauf – die CPU ist dabei
  voll beschäftigt (das verbessert Lab 02 mit einem Timer).

## 2. Das Programm verstehen (`main.c`)

```c
SysCtlPeripheralEnable(SYSCTL_PERIPH_GPION);           // 1. Takt für Port N an
while(!SysCtlPeripheralReady(SYSCTL_PERIPH_GPION)) {}  // 2. warten, bis Port bereit
GPIOPinTypeGPIOOutput(GPIO_PORTN_BASE, GPIO_PIN_0 | GPIO_PIN_1); // 3. PN0, PN1 = Ausgänge
GPIOPinWrite(..., GPIO_PIN_1);                         // Start: D1 an, D2 aus
while(1) {
    SysCtlDelay(HALBE_SEKUNDE);                        // 4. 0,5 s warten
    ... beide Pins invertieren ...                     // 5. LEDs umschalten
}
```

`SysCtlPeripheralEnable`, `GPIOPinTypeGPIOOutput` usw. kommen aus **TivaWare/driverlib**, der
Bibliothek von TI. `SysCtlDelay(n)` ist eine kleine Schleife, die 3 Taktzyklen pro Durchlauf
braucht; bei 16 MHz sind `16 000 000 / 3 / 2` Durchläufe etwa eine halbe Sekunde.

---

## 3. Variante A: Im Simulator (ohne Board)

Der Simulator führt **dieselbe `.out`-Datei** aus wie das Board.

### 3.1 Übersetzen

Im Terminal:

```bash
$ cd ~/praktikum/renode4mc-haw/examples/lab01_blinky
$ make
```

Ergebnis: Datei `lab01_blinky.out`. Fehlermeldung „tiarmclang nicht gefunden“ oder „inc/hw_memmap.h
nicht gefunden“ → Abschnitt *Häufige Probleme* in der Installationsanleitung.

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

- Ändern Sie `HALBE_SEKUNDE` auf `(16000000u / 3u / 10u)` (0,1 s), `make`, `ucsim` neu starten.
- Entfernen Sie testweise die Zeile `SysCtlPeripheralEnable(...)` und simulieren Sie erneut: Im
  Terminal erscheint die Warnung *„GPIO Port N: Zugriff … ohne Takt!“*, die LEDs bleiben aus. Auf dem
  Board würde das Programm im HardFault landen – ein sehr häufiger Anfängerfehler.

---

## 4. Variante B: Auf dem echten Board mit CCS

### 4.1 Projekt in CCS importieren

1. CCS starten (`~/ti/ccs2040/ccs/theia/ccstudio`).
2. Menü **File → Import Projects…** (bzw. in der Ansicht „CCS Project Explorer“ → *Import*), den
   Typ **CCS Projects** wählen und die Datei
   `~/praktikum/renode4mc-haw/examples/lab01_blinky/lab01_blinky.projectspec` auswählen.
3. **Pfadvariable `TIVAWARE_ROOT`** setzen, falls CCS danach fragt oder Dateien als „nicht
   gefunden“ markiert: Wert `~/ti/TivaWare_C_Series-2.2.0.295` (ausgeschrieben, z. B.
   `/home/IHRNAME/ti/TivaWare_C_Series-2.2.0.295`).

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

1. Lassen Sie **D3 (PF4)** und **D4 (PF0)** zusätzlich blinken (Port F: `SYSCTL_PERIPH_GPIOF`,
   `GPIO_PORTF_BASE`). Welche Zeile fehlt, wenn die LEDs dunkel bleiben?
2. Erzeugen Sie ein **Lauflicht** über alle vier LEDs.
3. Messen Sie mit einer Stoppuhr, wie genau 0,5 s auf dem Board sind. Warum weicht der Wert ab?
