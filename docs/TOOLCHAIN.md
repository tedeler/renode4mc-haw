# Konzept: Toolchain für Board **und** Simulator

Ziel: Studierende installieren **eine** Toolchain, bauen **ein** ELF-Image und können es
wahlweise (a) auf das EK-TM4C1294XL-Board flashen oder (b) im Renode-Simulator starten –
ohne Quelltext- oder Linker-Script-Änderung.

## Grundprinzip
Der TM4C1294 führt Code ab Flash-Adresse `0x0000_0000` aus, SRAM liegt bei `0x2000_0000`.
Renode bildet exakt dieses Speicherlayout ab (siehe `tm4c1294ncpdt.repl`). Ein produktives
ELF ist damit ohne Änderung im Simulator lauffähig:

```
 Quellcode ──► Compiler/Linker ──► build/<name>.elf ──┬─► make flash  → OpenOCD → ICDI → Board
 (+ startup, + linker script)                          └─► make sim    → Renode (LoadELF)
```

Es gibt **kein** simulatorspezifisches Linker-Script. Das heutige `tm4c1294.cmd` und die
Mini-Vektortabelle in `main.c` (nur 4 Einträge, kein `.data`-Kopieren, kein `.bss`-Nullen)
sind Vorversuche und werden durch die gemeinsamen Dateien unten ersetzt.

## Bausteine (im Repo unter `toolchain/` und `labs/common/`)

| Baustein | Inhalt | Quelle |
|---|---|---|
| **Linker-Script** `labs/common/tm4c1294.ld` | Flash 1 MB @ `0x0`, SRAM 256 KB @ `0x20000000`; `.isr_vector` zuerst, `.text/.rodata`, `.data` (LMA im Flash, VMA im SRAM), `.bss`, Heap/Stack-Symbole, `_estack` | **selbst geschrieben** (Layout aus Datenblatt) |
| **Startup** `labs/common/startup.c` | Vollständige Vektortabelle (155 Einträge: Cortex-M + IRQ 0–112 des TM4C129x, schwache Default-Handler), `Reset_Handler`: `.data` kopieren, `.bss` nullen, FPU aktivieren (`CPACR`), `SystemInit` (optional), `main()`; Namen wie in TivaWare (`SysTick_Handler`, `UART0_Handler`, `GPIOA_Handler` …), damit Studierende das Schema kennen | selbst geschrieben, IRQ-Liste aus `tm4c1294ncpdt.h` |
| **Register-Header** | `tm4c1294ncpdt.h` (TI) | wird aus der Installation von TivaWare/CCS referenziert, **nicht** ins Repo kopiert |
| **Makefile-Include** `labs/common/rules.mk` | Variablen `CPU_FLAGS`, Targets `all`, `flash`, `sim`, `debug`, `clean`; Labs binden es mit einer Zeile ein | selbst geschrieben |
| **Flash-Konfig** `toolchain/openocd.cfg` | `source [find board/ti_ek-tm4c1294xl.cfg]`, Programmiergeschwindigkeit | OpenOCD enthält die Board-Konfiguration bereits |
| **Sim-Skript** `labs/common/sim.resc` | lädt Plattform, Bridge, ELF aus `$ELF` | Renode |
| **Installer** `toolchain/install.sh` (Linux/WSL), `install.ps1` (Windows) | siehe unten | selbst geschrieben |

TI-Linker-Scripts/Startup-Dateien (`blinky.ld`, `startup_gcc.c`, `tm4c1294ncpdt.cmd`) stehen
unter einer TI-Lizenz mit Einschränkungen und werden **nicht** weiterverteilt; wir schreiben
eigene, funktional gleichwertige Dateien. Die TivaWare-Beispiele dienen als Referenz.

## Compiler-Wahl

| | **GNU Arm Embedded (`arm-none-eabi-gcc`)** (Empfehlung) | TI Arm Clang (`tiarmclang`, heute genutzt) |
|---|---|---|
| Installation | `apt install gcc-arm-none-eabi` / Arm-Download, ca. 150 MB, kein Login | Teil von Code Composer Studio oder Einzel-Download (TI-Konto/Lizenzbestätigung), mehrere GB bei CCS |
| Linker-Script | GNU `.ld` – Standard, viele Vorlagen | TI-`.cmd` – eigenes Format |
| Debugging mit GDB | nativ | möglich |
| Passt zu TivaWare-`driverlib`? | ja (`driverlib/gcc/libdriver.a`) | ja (`driverlib/ccs/`) |
| Verfügbar auf Linux/Windows/macOS | ja | Linux/Windows/macOS |

Empfehlung: **GCC als Standard**, `tiarmclang` bleibt optional (`TOOLCHAIN=ti` in `rules.mk`,
zweites Linker-Script `tm4c1294.cmd`). Wichtig: Beide Varianten müssen dasselbe Speicherlayout
und dieselben Symbolnamen verwenden.

Compiler-Flags (beide Toolchains): `-mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16`.

## Werkzeuge und Installation

| Werkzeug | Zweck | Installation |
|---|---|---|
| `arm-none-eabi-gcc` + `binutils` | Übersetzen/Linken | Paketmanager / Arm-Archiv |
| `make` | Build | Paketmanager |
| **OpenOCD** (≥ 0.12) | Flashen und Debuggen über den On-Board-ICDI (`ti_ek-tm4c1294xl.cfg` ist enthalten) | Paketmanager |
| `arm-none-eabi-gdb` / `gdb-multiarch` | Debugging (Board **und** Simulator) | Paketmanager |
| **Renode** (portable, feste Version) | Simulator | Download durch `install.sh` nach `bin/renode/` (nicht im Git) |
| TivaWare 2.2.0 (optional) | Header, `driverlib` | TI-Download (Lizenzbestätigung), Pfad in `TIVAWARE` |
| USB-Zugriff (Linux) | ICDI ohne root | udev-Regel `toolchain/99-icdi.rules` (VID `1CBE`, PID `00FD`) und Gruppe `plugdev` |

Der `install.sh` prüft/installiert jedes Werkzeug, lädt Renode in der gepinnten Version, legt
die udev-Regel an und schreibt am Ende `make doctor` aus: Versionen, Compiler-Test,
ICDI-Erkennung (`lsusb`), Renode-Start.

### Verteilungsvarianten (zu entscheiden)
1. **Skript-Installation** auf Linux/WSL2 (`install.sh`) – geringste Hürde in den Rechnerräumen.
2. **Dev-Container / Docker-Image** mit allen Werkzeugen (Compiler, Renode, OpenOCD, GDB);
   USB-Durchreichung für den ICDI nötig, daher für das Flashen nur unter Linux zuverlässig.
3. **Fertige VM** (z. B. für Windows/macOS-Rechner) – größter Download, aber ohne Setup.
4. Windows nativ: Arm-GCC, OpenOCD und Renode existieren als Windows-Builds; als
   Alternative ist aber WSL2 + `usbipd` einfacher zu betreuen.

## Studierenden-Workflow

```bash
git clone https://github.com/tedeler/renode4mc-haw.git && cd renode4mc-haw
./toolchain/install.sh          # einmalig
source scripts/env.sh
cd labs/lab01_blinky
make                            # → build/blinky.elf
make sim                        # Simulator + Browser-Visualizer
make flash                      # Board per OpenOCD
make debug                      # GDB-Session (TARGET=sim oder board)
```

`make flash` = `openocd -f toolchain/openocd.cfg -c "program build/blinky.elf verify reset exit"`.

Debugging: Renode öffnet einen GDB-Server (`machine StartGdbServer 3333`), OpenOCD ebenfalls auf
Port 3333 – dasselbe `.gdbinit` funktioniert für beide Ziele. Alternativ kann
`dslite.sh` aus CCS (UniFlash) zum Flashen benutzt werden, ist aber nicht nötig.

## Unterschiede Simulator ↔ Board (den Studierenden erklären)
- Peripherie nur im Umfang des Fahrplans (`ROADMAP.md`); andere Zugriffe loggen eine Warnung.
- Zeitverhalten nicht zyklengenau (Busy-Loops).
- Der Simulator startet immer aus dem Flash bei `0x0`; Bootloader, ROM-`driverlib`
  (`ROM_*`) und Flash-Schreiben fehlen. Labs verwenden deshalb **nicht** die `ROM_`-Varianten.
- Der Reset-Zustand der Takte stimmt (16-MHz-PIOSC); `SysCtlClockFreqSet` ist Teil von M1.

## Umsetzungsschritte
1. `startup.c` und `tm4c1294.ld` schreiben, Blinky darauf umstellen; auf Board **und** in Renode testen.
2. `rules.mk`, `flash`/`sim`/`debug`-Targets, `openocd.cfg`, udev-Regel.
3. `install.sh` und `make doctor`, Renode-Version fest pinnen (Download-URL + Prüfsumme).
4. Optional TI-Clang-Variante (`.cmd`) und Windows/WSL-Anleitung.
5. Test mit einem frischen Rechner/Container nach der Anleitung (Akzeptanzkriterium: ein Student kann
   in < 30 min Blinky simulieren und flashen).

## Offene Entscheidungen
- GCC als Standard-Toolchain (Empfehlung) oder weiter TI Arm Clang?
- Welche Betriebssysteme müssen die Studierenden-Rechner abdecken?
- Wird TivaWare (`driverlib`) in den Labs genutzt oder nur Registerzugriff?
- Soll das Board-Flashen in den Rechnerräumen ohne root möglich sein (udev/Gruppen durch IT)?
