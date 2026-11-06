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

## Debuggen des Simulators aus CCS

Wunsch: Im CCS dieselbe Debug-Ansicht (Breakpoints, Einzelschritt, Variablen, Register)
benutzen, egal ob Board oder Simulator.

### Was CCS 20.4 (lokale Installation) hergibt – geprüft
- CCStudio 20 basiert auf Theia. In der mitgelieferten Erweiterungsliste gibt es keinen
  GDB-Debug-Adapter (nur `ms-vscode.js-debug`), und die Installation enthält weder `gdb` noch `lldb`.
- Der native TI-Debugger spricht über den **TI Debug Server** (`ccs_base/DebugServer`) mit
  Treibern für echte Hardware: `libicdi_emu.so`/`libstellaris_emu.so` (ICDI per USB),
  `libjlinkarm.so` (Segger J-Link), XDS-Treiber. Eine „Simulator“- oder „GDB-Remote“-Verbindung
  für den TM4C1294 gibt es nicht (Verbindungen u. a. `Stellaris_ICDI_Connection.xml`, `segger_j-link_connection.xml`).
- Renode stellt einen GDB-Server bereit (`machine StartGdbServer 3333`).

### Varianten

| # | Variante | Aufwand/Risiko | Bewertung |
|---|---|---|---|
| 1 | **GDB-Remote-Debug-Erweiterung in CCS-Theia** (z. B. Cortex-Debug oder C/C++-Debug aus Open VSX) → Renode-GDB-Server; `arm-none-eabi-gdb` bzw. `gdb-multiarch` wird im ucsim-Paket mitgeliefert | gering; hängt davon ab, ob CCS-Theia das Nachinstallieren von Erweiterungen erlaubt (**vor Festlegung testen**) | **Empfohlen.** Gleiche IDE, gleiche Projekte, ein Klick „Debug Simulator“ (`launch.json` als Vorlage im Lab-Projekt). Oberfläche ist die allgemeine VS-Code-Debugansicht, nicht TIs eigene (z. B. keine TI-Peripherieregister-Ansicht). |
| 2 | **Standalone VS Code** mit mitgelieferter `launch.json` (Cortex-Debug) für dasselbe `.out` | gering | Fallback, falls 1 in CCS nicht geht. |
| 3 | **Virtuelles ICDI-Gerät** (USB/IP/Gadget), damit der native TI-Debugger glaubt, ein Board zu sehen | sehr hoch: proprietäres USB-Protokoll nachbauen, Kernelmodule und Root-Rechte, nur Linux | Nicht empfohlen. |
| 4 | **J-Link-Shim** (eigene `libjlinkarm` ersetzen) oder TI-GTI-Remote-Proxy | sehr hoch, undokumentiert, lizenzrechtlich heikel | Nicht empfohlen. |
| 5 | Debug nur über die Renode-Konsole/GDB-CLI | minimal | Zusätzlich für Fortgeschrittene, nicht für den Regelbetrieb. |

### Empfehlung
Variante 1 mit Variante 2 als Rückfallebene. Ablauf für Studierende:
`ucsim --debug` (oder Task „Debug Simulator“) startet Renode **angehalten** mit GDB-Server auf Port 3333,
die Debug-Konfiguration verbindet sich, lädt Symbole aus dem `.out` (TI Arm Clang erzeugt DWARF)
und hält an `main`. Bei Variante 1 sollte gleichzeitig der Board-Debug mit TIs Standardkonfiguration
unverändert bleiben (zwei Konfigurationen im selben Projekt: „Board“ und „Simulator“).

### Machbarkeitstest (durchgeführt)

Getestet mit TIs vorgebautem `blinky.out` (TI Arm Clang, DWARF) aus den TivaWare-Beispielen,
Renode 1.17.0, `gdb-multiarch` 17.1:

| Prüfung | Ergebnis |
|---|---|
| Renode mit `machine StartGdbServer 3333` (ohne `start`) → GDB `target remote :3333` | ✅ verbindet; Simulation steht angehalten am Reset-Vektor (`ResetISR`, SP `0x20000200`) |
| Symbole und Quellzeilen aus TI-Clang-DWARF | ✅ `ResetISR () at ../startup_ccs.c:207`, `main () at ../blinky.c:73` |
| Breakpoint auf `main`, `continue`, `bt`, `info locals` | ✅ Halt an `main`, Backtrace und Variable `ui32Loop = 0` |
| `next`, `stepi`, `x/4i $pc`, Register lesen | ✅ |
| `monitor <Renode-Befehl>` über GDB | ✅ (z. B. Konsolenbefehle direkt aus der Debug-Sitzung) |
| `.out` ohne Änderung, TI-Startcode `_c_int00` | ✅ |

Hinweis: Renode beendet sich, wenn seine Standardeingabe geschlossen wird; `ucsim` startet es deshalb
mit offener Eingabe bzw. `--plain`/Skriptmodus und hält den Prozess am Leben.
Quelldateien meldet GDB als „nicht gefunden“, weil die Pfade im `.out` relativ zum CCS-Build-Ordner
stehen; im Debug-Konfig `substitutePath`/`sourceFileMap` auf das Projektverzeichnis setzen.

**CCS-Seite (nur teilweise geprüft):** Die CCS-20.4-Theia-App enthält `@theia/vsx-registry`,
`@theia/plugin-ext-vscode` und `@theia/debug` – die Bausteine für den Extensions-Katalog (Open VSX)
und VS-Code-Debug-Adapter sind also vorhanden, und es ist nichts dagegen konfiguriert. **Nicht
getestet** (GUI nötig): das tatsächliche Installieren und Starten einer GDB-Debug-Erweiterung
(Cortex-Debug / C/C++-Debug) innerhalb von CCS. Das ist der letzte offene Schritt, ca. 30 Minuten
manuell: Extension suchen → installieren → `launch.json` mit `gdbPath`, `target remote :3333`,
`executable: ${workspaceFolder}/Debug/<projekt>.out` → Debug starten.

### Folgerung
Technisch trägt die Variante „GDB-Remote gegen Renode“; was noch fehlt, ist der GUI-Test in CCS.
Falls CCS-Theia die Erweiterung nicht annimmt, bleibt Variante 2 (VS Code mit identischer `launch.json`).

## Unterschiede Simulator ↔ Board (den Studierenden erklären)
- Peripherie nur im Umfang des Fahrplans (SYSCTL, SysTick, GPIO, Timer, UART, ADC); anderes loggt eine Warnung.
- Zeitverhalten nicht zyklengenau (Busy-Loops).
- Kein Bootloader, kein ROM-`driverlib` (`ROM_*`-Aufrufe), kein Flash-Schreiben zur Laufzeit.
- Programme dürfen nicht von der Simulation wissen: derselbe Code läuft auf Board und Simulator.

## Umsetzungsschritte
1. Bit-Banding im Simulator ergänzen; TI-`blinky.out` und weitere TivaWare-Beispiele
   (Timer, UART, ADC) als **Regressionstests** in Renode (`renode-test`) einsetzen.
2. `ucsim`-Startskript (Linux zuerst) mit generischem `sim.resc` (`$ELF` als Parameter) und Visualizer-Start.
3. CCS-Lab-Projekte und „Simulate“-/„Debug Simulator“-Tasks bauen; Verfügbarkeit in CCS 20.x klären (Machbarkeitstest GDB-Erweiterung, siehe oben).
4. Paketierung pro OS mit fest gepinnter Renode-Version, Installationsanleitung.
5. Test auf einem frischen Rechner (Akzeptanz: CCS-Projekt importieren, bauen, flashen **und** simulieren in < 30 min).

## Offene Entscheidungen
- Welche Betriebssysteme müssen zuerst funktionieren (Renode-Pakete für alle drei existieren)?
- Reicht ein Browser-Visualizer pro Lab, oder ein universelles Board-Abbild (LEDs, Taster, UART-Konsole, ADC-Regler)?
- Ist die allgemeine Debugansicht (GDB-Remote) im CCS akzeptabel, auch wenn sie nicht TIs eigene Debug-Oberfläche ist?
