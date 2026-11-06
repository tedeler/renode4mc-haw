# renode4mc-haw – Mikrocontroller-Simulation mit Renode

Simulation eines **TI TM4C1294NCPDT** (ARM Cortex-M4F, Tiva C / EK-TM4C1294XL) mit
[Renode](https://renode.io). Eine auf dem PC kompilierte Firmware läuft unverändert im Emulator;
eine LED im **Webbrowser** zeigt den Zustand des GPIO-Pins live an.

## Funktionsweise

```
 Firmware (C, blinky.elf)          Renode                               Browser
┌──────────────────────┐   ┌───────────────────────────────┐   ┌───────────────────┐
│ main.c               │   │ Cortex-M4F + NVIC, Flash, SRAM│   │ visualizer/       │
│ toggelt PN0 via      │──▶│ TivaGPIOPort (Port N, C#)     │   │ index.html        │
│ GPIO_PORTN_DATA_R    │   │   │ Pin 0 (GPIO-Verbindung)   │   │ LED (SVG)         │
└──────────────────────┘   │   ▼                           │   │                   │
                           │ WebSocketBridge (C#, Port 9000)│◀─▶│ WebSocket         │
                           └───────────────────────────────┘   └───────────────────┘
```

1. **Firmware** (`labs/lab01_blinky/firmware/main.c`) aktiviert den Takt für GPIO Port N
   (`RCGCGPIO` Bit 12), setzt PN0/PN1 als digitale Ausgänge und toggelt PN0 in einer Endlosschleife.
   Es werden die echten Registeradressen des TM4C1294 verwendet; es gibt keine Bibliothek
   (`-nostdlib`), die Vektortabelle (SP, Reset, NMI, HardFault) steht in `.intvecs` bei `0x0`.
   `tm4c1294.cmd` ist das Linker-Script (Flash 1 MB @ `0x0`, SRAM 256 KB @ `0x20000000`).
2. **Plattform** (`renode_config/platforms/tm4c1294ncpdt.repl`) beschreibt den Chip: CPU, NVIC,
   Flash, SRAM, GPIO Port N bei `0x40064000`, SYSCTL als einfacher „immer bereit“-Stub
   (Reads liefern `0xFFFFFFFF`) und die WebSocketBridge bei `0x400FF000`.
   Pin 0 von Port N ist mit Pin 0 der Bridge verbunden (`0 -> wsBridge@0`).
3. **`renode_bridge/TivaGPIOPort.cs`** – vereinfachtes GPIO-Modell: `DATA` (inkl. Adressmaske
   über Bits 9:2), `DIR` (`0x400`) und `DEN` (`0x51C`). Pinänderungen werden geloggt und an
   verbundene Peripherie weitergegeben.
4. **`renode_bridge/WebSocketBridge.cs`** – minimaler WebSocket-Server (`ws://127.0.0.1:9000`,
   nur localhost):
   - GPIO-Änderung → JSON `{"type":"gpio","pin":0,"state":true}` an den Browser
   - Pin 1 steigende Flanke → `{"type":"angle","value":N}` (+15° je Schritt, Schrittmotor-Demo)
   - Register `0x00` lesen/schreiben = Drehwinkel (0..360)
   - Browser → Simulation: Textnachricht `PIN:<n>:<0|1>` setzt einen Bridge-Eingang (Taster)
5. **`visualizer/index.html`** – verbindet sich per WebSocket (Auto-Reconnect) und färbt die LED
   grün/grau bei `gpio` Pin 0.

Die C#-Dateien werden beim Start von `sim.resc` per `include` direkt in Renode kompiliert –
kein separater Build nötig.

## Verzeichnisstruktur

| Pfad | Inhalt |
|---|---|
| `scripts/env.sh` | Setzt `UCSIM_ROOT`, `PATH` (Renode) und `TI_BIN` (Compiler) |
| `labs/lab01_blinky/` | Blinky-Beispiel: `firmware/`, `Makefile`, `build.sh`, `sim.resc` |
| `renode_config/platforms/` | `tm4c1294ncpdt.repl` (Plattform), `mech_extension.repl` (Beispiel-Erweiterung, derzeit ungenutzt) |
| `renode_bridge/` | C#-Peripheriemodelle (GPIO, WebSocket) |
| `visualizer/index.html` | Browser-Oberfläche |
| `bin/` | **nicht im Repo** – hier wird Renode entpackt |

## Installation (Linux)

### 1. Renode
Portable Linux-Version von <https://github.com/renode/renode/releases> laden (getestet mit
v1.17.0, `renode-*.linux-portable.tar.gz`) und so entpacken, dass die Datei `bin/renode/renode` existiert:

```bash
git clone https://github.com/tedeler/renode4mc-haw.git && cd renode4mc-haw
mkdir -p bin/renode
tar xzf ~/Downloads/renode-*.linux-portable.tar.gz -C bin/renode --strip-components=1
source scripts/env.sh
renode --version
```
Das portable Paket bringt die .NET-Runtime mit; für die GUI-Fenster werden GTK3-Bibliotheken benötigt.

### 2. Compiler
**TI Arm Clang** (`tiarmclang`, getestet mit `ti-cgt-armllvm_4.0.4.LTS` aus Code Composer Studio 20.4)
installieren. Liegt er nicht unter `~/tmp/ti/ccs2040/.../bin`, den Pfad setzen:

```bash
export TI_BIN=/pfad/zu/ti-cgt-armllvm_x.y.z.LTS/bin
```
(Alternativ kann ein anderer Cortex-M-Compiler verwendet werden, wenn er ein ELF mit dem
gleichen Speicherlayout erzeugt; das Linker-Script `tm4c1294.cmd` ist TI-spezifisch.)

## Benutzung

```bash
source scripts/env.sh
cd labs/lab01_blinky
make            # baut build/blinky.elf  (oder ./build.sh)
make sim        # startet Renode mit sim.resc (Konsole)
```
Dann `visualizer/index.html` im Browser öffnen (Doppelklick genügt). Die Statuszeile wird grün
(„Verbunden mit Renode“) und die LED blinkt im Takt des Programms. Im Renode-Log erscheint
`gpioPortN: Pin 0 -> HIGH (LED AN)` / `LOW (LED AUS)`.

Hinweise:
- `sim.resc` verwendet relative Pfade und muss daher **aus `labs/lab01_blinky/`** gestartet werden.
- Warnungen wie `ReadDoubleWord from non existing peripheral at 0x400FE608` (SYSCTL) sind erwartet –
  der SYSCTL-Stub liefert nur „bereit“.
- Der Port 9000 muss frei sein; es kann sich immer nur ein Browser verbinden.

## Neue Labs / Erweiterungen
- Neues Lab als `labs/labNN_name/` anlegen (Firmware, Makefile, `sim.resc`).
- Weitere Peripherie als C#-Datei in `renode_bridge/` ablegen, in `sim.resc` per `include`
  laden und in der `.repl`-Datei einbinden.
- Das GPIO-Modell kennt bisher nur `DATA`, `DIR`, `DEN` – keine Interrupts, Pull-ups, AFSEL etc.
