# Konzept: TI-Workflow beibehalten, Simulation als „Ein-Klick“-Zusatz

Ziel: Studierende arbeiten **genau wie von TI empfohlen**: Code Composer Studio (CCStudio),
TI Arm Clang, TivaWare, TI-Linker-Script, Flashen/Debuggen über den On-Board-ICDI.
Zusätzlich gibt es einen einfachen Weg, das von CCS gebaute Programm **unverändert** im
Simulator zu starten. Es gibt keinen zweiten Build, kein zweites Linker-Script, keine
Simulator-spezifischen Projekteinstellungen.

## Grundprinzip

```
 CCS-Projekt (TivaWare, startup_ccs.c, tm4c1294ncpdt.cmd)
        │  Build (TI Arm Clang)
        ▼
   Debug/<projekt>.out  (ELF)
        ├─► CCS „Debug“/„Flash“  → ICDI → EK-TM4C1294XL      (TI-Standard, unverändert)
        └─► „Simulieren“         → ucsim <projekt>.out → Renode + Browser-Visualizer
```

Der Simulator ist ein reiner **Konsument des ELF**. Er bildet das Speicherlayout des Chips ab
(Flash `0x0`, 1 MB; SRAM `0x20000000`, 256 KB) und startet wie die Hardware: Stackpointer und
Reset-Vektor aus der Vektortabelle bei `0x0`.

### Belegt (Test)
Das von TI mitgelieferte, vorgebaute `blinky.out` aus TivaWare
(`examples/boards/ek-tm4c1294xl/blinky/ccs/Debug/`) wurde ohne Änderung in Renode geladen:
Vektortabelle und Reset (`_c_int00` der TI-Runtime, SP `0x20000200`) laufen; danach greift
`driverlib` auf Register zu, die der Simulator noch nicht kennt:
- **Bit-Banding-Alias** (`0x42000000–0x43FFFFFF`, von `driverlib` für Peripherie-Bits genutzt)
  → muss im Simulator ergänzt werden (neuer Punkt in M0 des `ROADMAP.md`).
- SYSCTL/GPIO-Register → M1/M3.

Damit ist bestätigt: TI-Startup, TI-Linker-Script und `driverlib` funktionieren im Simulator,
sobald die Peripherie-Modelle vollständig genug sind.

## Was Studierende installieren

| Komponente | Quelle | Zweck |
|---|---|---|
| **CCStudio** (Linux/macOS/Windows) inkl. TI Arm Clang | TI | Editor, Build, Debug, Flash – wie bisher |
| **TivaWare 2.2.0** | TI | `driverlib`, Header, Beispiele |
| **ucsim-Paket** (neu, dieses Repo) | Release-Archiv pro OS | Renode (feste Version), C#-Modelle, Plattformbeschreibung, Visualizer, Startskript `ucsim` |

Das ucsim-Paket wird pro Betriebssystem als Archiv/Installer bereitgestellt
(Linux: `.tar.gz` + `install.sh`; Windows: `.zip` oder Installer; macOS: `.tar.gz`/`.pkg`), enthält
Renode in einer festen Version und trägt `ucsim` in den `PATH` ein. Kein Compiler, kein
Linker-Script, kein OpenOCD gehört dazu – das liefert alles CCS.

## Der einfache Weg zur Simulation

`ucsim <datei.out>` – ein Befehl, der
1. Renode im Hintergrund startet (Plattform, Modelle, ELF laden, `start`),
2. den Browser-Visualizer öffnet (`http://127.0.0.1:…`, siehe unten),
3. bei erneutem Aufruf die laufende Simulation neu startet (neues ELF ohne Renode-Neustart).

Einbindung in CCS, in absteigender Bequemlichkeit (**vor der Festlegung auf CCS 20.x
prüfen**, welche Variante dort verfügbar ist):

1. **Eigener Task/Run-Befehl in CCStudio** („Simulate“), der `ucsim ${projectName}/Debug/${projectName}.out`
   aufruft. Wird als Vorlage ins Lab-Projekt gelegt (CCStudio basiert auf Theia, Tasks im
   VS-Code-Stil sind dort üblich).
2. **Post-Build-Schritt** in den Projekteigenschaften (Build → Steps), der `ucsim` aufruft –
   dann simuliert jeder Build automatisch. Nur als optionaler Schalter, weil es beim Flashen stört.
3. **Ohne IDE-Integration:** Drag & Drop der `.out`-Datei auf das ucsim-Symbol bzw. Dateizuordnung
   für `.out`, oder `ucsim` in der Konsole.

Die Lab-Projekte werden als **CCS-Projekte** bereitgestellt (importierbar, auf Basis der
TivaWare-Beispielprojekte des EK-TM4C1294XL); die Simulationsaufgabe hängt nur an der
Ausgabedatei, nicht am Projekt.

## Debuggen im Simulator
Renode bietet einen GDB-Server; CCS kann sich per GDB-Remote anbinden oder es wird
`arm-none-eabi-gdb`/`gdb-multiarch` verwendet (nicht Teil des Pflichtumfangs). Primär
zählt zunächst: Ausgabe über UART-Terminal und Pins im Browser.

## Unterschiede Simulator ↔ Board (den Studierenden erklären)
- Peripherie nur im Umfang des Fahrplans (SYSCTL, SysTick, GPIO, Timer, UART, ADC); anderes loggt eine Warnung.
- Zeitverhalten nicht zyklengenau (Busy-Loops).
- Kein Bootloader, kein ROM-`driverlib` (`ROM_*`-Aufrufe), kein Flash-Schreiben zur Laufzeit.
- Programme dürfen nicht von der Simulation wissen: derselbe Code läuft auf Board und Simulator.

## Umsetzungsschritte
1. Bit-Banding im Simulator ergänzen; TI-`blinky.out` und weitere TivaWare-Beispiele
   (Timer, UART, ADC) als **Regressionstests** in Renode (`renode-test`) einsetzen.
2. `ucsim`-Startskript (Linux zuerst) mit generischem `sim.resc` (`$ELF` als Parameter) und Visualizer-Start.
3. CCS-Lab-Projekte und „Simulate“-Task bauen; Verfügbarkeit in CCS 20.x klären.
4. Paketierung pro OS mit fest gepinnter Renode-Version, Installationsanleitung.
5. Test auf einem frischen Rechner (Akzeptanz: CCS-Projekt importieren, bauen, flashen **und** simulieren in < 30 min).

## Offene Entscheidungen
- Welche Betriebssysteme müssen zuerst funktionieren (Renode-Pakete für alle drei existieren)?
- Reicht ein Browser-Visualizer pro Lab, oder ein universelles Board-Abbild (LEDs, Taster, UART-Konsole, ADC-Regler)?
- Wird auch GDB-Debugging im Simulator aus CCS gewünscht oder nur Ausführung?
