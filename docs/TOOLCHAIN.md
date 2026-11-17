# Concept: keep the TI workflow, add simulation as a "one-click" extra

Goal: students work **exactly as TI recommends**: Code Composer Studio (CCStudio),
TI Arm Clang, TivaWare, TI linker script, flashing/debugging via the on-board ICDI.
In addition there is a simple way to start the program built by CCS **unchanged** in the
simulator. There is no second build, no second linker script and no simulator-specific
project settings.

## Basic principle

```
 CCS project (TivaWare, startup_ccs.c, tm4c1294ncpdt.cmd)
        │  build (TI Arm Clang)
        ▼
   Debug/<project>.out  (ELF)
        ├─► CCS "Debug"/"Flash"  → ICDI → EK-TM4C1294XL      (TI standard, unchanged)
        └─► "Simulate"           → ucsim <project>.out → Renode + browser visualizer
```

The simulator only **consumes the ELF file**. It reproduces the memory layout of the chip
(flash `0x0`, 1 MB; SRAM `0x20000000`, 256 KB) and starts like the hardware: stack pointer and
reset vector from the vector table at `0x0`.

### Evidence (test)
The pre-built `blinky.out` supplied by TI with TivaWare
(`examples/boards/ek-tm4c1294xl/blinky/ccs/Debug/`) was loaded into Renode without any change:
vector table and reset (`_c_int00` of the TI run-time library, SP `0x20000200`) work; after that,
`driverlib` accesses registers that the simulator did not know yet:
- **bit-banding alias** (`0x42000000–0x43FFFFFF`, used by `driverlib` for peripheral bits)
  → must be added to the simulator (new item in M0 of `ROADMAP.md`).
- SYSCTL/GPIO registers → M1/M3.

This confirms: the TI start-up file, the TI linker script and `driverlib` work in the simulator
as soon as the peripheral models are complete enough.

## What students install

| Component | Source | Purpose |
|---|---|---|
| **CCStudio** (Linux/macOS/Windows) incl. TI Arm Clang | TI | editor, build, debug, flash – as before |
| **TivaWare 2.2.0** | TI | `driverlib`, headers, examples |
| **ucsim package** (new, this repository) | release archive per OS | Renode (fixed version), C# models, platform description, visualizer, start script `ucsim` |

The ucsim package is provided per operating system as an archive/installer
(Linux: `.tar.gz` + `install.sh`; Windows: `.zip` or installer; macOS: `.tar.gz`/`.pkg`); it contains
Renode in a fixed version and adds `ucsim` to the `PATH`. It contains no compiler, no linker
script and no OpenOCD – CCS provides all of these.

## The simple way to simulate

`ucsim <file.out>` – one command that
1. starts Renode in the background (platform, models, load ELF, `start`),
2. opens the browser visualizer (`http://127.0.0.1:…`, see below),
3. restarts the running simulation when called again (new ELF without restarting Renode).

Integration into CCS, from most to least convenient (**check which variant is available in
CCS 20.x before committing to it**):

1. **Own task/run command in CCStudio** ("Simulate") that calls `ucsim ${projectName}/Debug/${projectName}.out`.
   It is put into the lab project as a template (CCStudio is based on Theia, where VS Code style
   tasks are common).
2. **Post-build step** in the project properties (Build → Steps) that calls `ucsim` –
   then every build is simulated automatically. Only as an optional switch, because it gets in the way when flashing.
3. **Without IDE integration:** drag & drop the `.out` file onto the ucsim icon, a file association
   for `.out`, or `ucsim` in the console.

The lab projects are provided as **CCS projects** (importable, based on the TivaWare example
projects of the EK-TM4C1294XL); the simulation only depends on the output file, not on the project.

## Debugging the simulator from CCS

Wish: use the same debug view in CCS (breakpoints, single step, variables, registers),
no matter whether it is the board or the simulator.

### What CCS 20.4 (local installation) offers – checked
- CCStudio 20 is based on Theia. The bundled extension list has no GDB debug adapter (only
  `ms-vscode.js-debug`), and the installation contains neither `gdb` nor `lldb`.
- The native TI debugger talks via the **TI Debug Server** (`ccs_base/DebugServer`) to drivers for
  real hardware: `libicdi_emu.so`/`libstellaris_emu.so` (ICDI via USB), `libjlinkarm.so`
  (Segger J-Link), XDS drivers. There is no "simulator" or "GDB remote" connection for the
  TM4C1294 (connections include `Stellaris_ICDI_Connection.xml`, `segger_j-link_connection.xml`).
- Renode provides a GDB server (`machine StartGdbServer 3333`).

### Variants

| # | Variant | Effort/risk | Assessment |
|---|---|---|---|
| 1 | **GDB remote debug extension in CCS-Theia** (e.g. Cortex-Debug or C/C++ Debug from Open VSX) → Renode GDB server; `arm-none-eabi-gdb` or `gdb-multiarch` is shipped in the ucsim package | low; depends on whether CCS-Theia allows installing extensions (**test before deciding**) | **Recommended.** Same IDE, same projects, one click "Debug Simulator" (`launch.json` as template in the lab project). The user interface is the general VS Code debug view, not TI's own (e.g. no TI peripheral register view). |
| 2 | **Standalone VS Code** with a supplied `launch.json` (Cortex-Debug) for the same `.out` | low | Fallback if 1 does not work in CCS. |
| 3 | **Virtual ICDI device** (USB/IP/gadget), so that the native TI debugger thinks it sees a board | very high: re-implement a proprietary USB protocol, kernel modules and root rights, Linux only | Not recommended. |
| 4 | **J-Link shim** (replace `libjlinkarm`) or TI GTI remote proxy | very high, undocumented, legally delicate | Not recommended. |
| 5 | Debug only via the Renode console/GDB CLI | minimal | Additionally for advanced users, not for normal use. |

### Recommendation
Variant 1 with variant 2 as fallback. Workflow for students:
`ucsim --debug` (or the task "Debug Simulator") starts Renode **paused** with a GDB server on port 3333;
the debug configuration connects, loads the symbols from the `.out` (TI Arm Clang produces DWARF)
and stops at `main`. With variant 1, debugging the board with TI's standard configuration should
stay unchanged at the same time (two configurations in the same project: "Board" and "Simulator").

### Feasibility test (carried out)

Tested with TI's pre-built `blinky.out` (TI Arm Clang, DWARF) from the TivaWare examples,
Renode 1.17.0, `gdb-multiarch` 17.1:

| Check | Result |
|---|---|
| Renode with `machine StartGdbServer 3333` (without `start`) → GDB `target remote :3333` | ✅ connects; the simulation is paused at the reset vector (`ResetISR`, SP `0x20000200`) |
| symbols and source lines from TI Clang DWARF | ✅ `ResetISR () at ../startup_ccs.c:207`, `main () at ../blinky.c:73` |
| breakpoint on `main`, `continue`, `bt`, `info locals` | ✅ stops at `main`, backtrace and variable `ui32Loop = 0` |
| `next`, `stepi`, `x/4i $pc`, reading registers | ✅ |
| `monitor <Renode command>` via GDB | ✅ (e.g. console commands directly from the debug session) |
| `.out` unchanged, TI start-up code `_c_int00` | ✅ |

Note: Renode exits when its standard input is closed; that is why `ucsim` starts it with an open
input or in `--plain`/script mode and keeps the process alive.
GDB reports the source files as "not found" because the paths in the `.out` are relative to the
CCS build folder; set `substitutePath`/`sourceFileMap` in the debug configuration to the project folder.

**CCS side (only partly checked):** the CCS 20.4 Theia app contains `@theia/vsx-registry`,
`@theia/plugin-ext-vscode` and `@theia/debug` – so the building blocks for the extension catalogue
(Open VSX) and VS Code debug adapters are there, and nothing is configured against them. **Not
tested** (needs the GUI): actually installing and starting a GDB debug extension
(Cortex-Debug / C/C++ Debug) inside CCS. This is the last open step, about 30 minutes of manual
work: search for the extension → install it → `launch.json` with `gdbPath`, `target remote :3333`,
`executable: ${workspaceFolder}/Debug/<project>.out` → start debugging.

### Conclusion
Technically the variant "GDB remote against Renode" works; what is still missing is the GUI test in CCS.
If CCS-Theia does not accept the extension, variant 2 remains (VS Code with an identical `launch.json`).

## Differences simulator ↔ board (explain them to the students)
- Peripherals only as far as the roadmap goes (SYSCTL, SysTick, GPIO, timer, UART, ADC); anything else logs a warning.
- The timing is not cycle-accurate (busy loops).
- No boot loader, no ROM `driverlib` (`ROM_*` calls), no flash programming at run time.
- Programs must not know about the simulation: the same code runs on the board and in the simulator.

## Implementation steps
1. Add bit-banding to the simulator; use TI's `blinky.out` and further TivaWare examples
   (timer, UART, ADC) as **regression tests** in Renode (`renode-test`).
2. `ucsim` start script (Linux first) with a generic `sim.resc` (`$ELF` as parameter) and starting the visualizer.
3. Build CCS lab projects and "Simulate"/"Debug Simulator" tasks; clarify availability in CCS 20.x (feasibility test of the GDB extension, see above).
4. Packaging per OS with a pinned Renode version, installation guide.
5. Test on a fresh computer (acceptance: import, build, flash **and** simulate a CCS project in < 30 min).

## Open decisions
- Which operating systems must work first (Renode packages exist for all three)?
- Is one browser visualizer per lab enough, or a universal board picture (LEDs, push buttons, UART console, ADC slider)?
- Is the general debug view (GDB remote) in CCS acceptable, even though it is not TI's own debug interface?


## Addendum: implementation in this repository

- The start-up file (`common/startup_tm4c1294.c`) and the linker script (`common/tm4c1294.cmd`) are
  our own files and are used by CCS **and** by the Makefile alike; the resulting `.out` runs
  unchanged in the simulator.
- The examples use **direct register access** (teaching concept: students work with the
  data sheet); TivaWare/`driverlib` is not included and does not need to be installed. (The
  simulator still supports `driverlib` programs: TI's `blinky.out` and an earlier `driverlib`-based
  version of the labs ran.)
- Starting the simulator: `ucsim [--debug] program.out`; `--debug` opens the GDB server (port 3333).
