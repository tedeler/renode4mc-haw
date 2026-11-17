# Installation on Linux

This guide sets up everything you need for the microcontroller lab:

| What | For |
|---|---|
| **Code Composer Studio (CCS)** | writing and compiling programs, loading them onto the board, debugging |
| **Renode + `ucsim`** | simulator: run a program without a board, show the LEDs in the browser |
| **udev rule** | gives you USB access to the board (without `sudo`) |

The examples access the **registers directly** (data sheet instead of a library) – TivaWare/driverlib
is **not** needed.

Tested with: CCS 20.4 (Linux x64), Renode 1.17.0, Ubuntu/Debian-like Linux.
Plan for about 1 hour and about 6 GB of free disk space. This guide assumes that you install
everything in your home directory under `~/ti` – this needs no administrator rights
(only step 5 needs `sudo`).

> All commands are typed in a **terminal**; you can copy them directly from the code blocks.

---

## 1. Required packages

```bash
sudo apt update
sudo apt install git make curl libusb-1.0-0 libgtk-3-0 gdb-multiarch xdg-utils
```

`gdb-multiarch` is only needed for debugging in the simulator (step 8). On other distributions
the packages have similar names (Fedora: `dnf install git make curl libusb gtk3 gdb`).

## 2. Getting this repository

```bash
mkdir -p ~/lab && cd ~/lab
git clone https://github.com/tedeler/renode4mc-haw.git
cd renode4mc-haw
```


## 3. Installing Code Composer Studio

1. Download the **Linux installer** (`CCS…_linux-x64.tar.gz`) from <https://www.ti.com/tool/CCSTUDIO>
   (a free TI account is required).
2. Unpack it and start the installer:
   ```bash
   cd ~/Downloads
   tar xf CCS*_linux-x64.tar.gz
   cd CCS*_linux-x64
   ./ccs_setup_*.run          # the name may differ; check in the folder with: ls
   ```
3. **Installation folder:** `~/ti` (accept the installer's suggestion or enter `~/ti`).
   CCS is then in `~/ti/ccs2040` (the number is the version and may be different for you).
4. Under "Select Components", **Tiva C Series Arm Cortex-M4 MCUs** is enough (saves space).
5. Under "Debug Probes", leave **Stellaris/Tiva ICDI** (or "TI XDS/ICDI") ticked.

The C code is compiled by **TI Arm Clang**; it is included in CCS.

## 4. Getting the data sheet (instead of TivaWare)

In the lab you program **without a library**, directly via the registers. For this you need the
data sheet: <https://www.ti.com/product/TM4C1294NCPDT> → *Technical documents* →
"Tiva TM4C1294NCPDT Microcontroller Data Sheet" (PDF). The examples use the register names and bit
constants from the TI header file `common/tm4c1294ncpdt.h` (no addresses of their own); you look up
what they mean in the data sheet. Also useful: the board manual "EK-TM4C1294XL User's Guide".

## 5. USB access to the board (udev rule)

Without this rule only `root` may talk to the board. A debug error such as
"Could not open device" points to this.

```bash
cd ~/ti/ccs2040/ccs/install_scripts
sudo ./ti_permissions_install.sh
```

Alternative (only for the EK-TM4C1294XL; file `99-tiva-launchpad.rules`):

```bash
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="1cbe", ATTRS{idProduct}=="00fd", MODE="0666"' \
    | sudo tee /etc/udev/rules.d/99-tiva-launchpad.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug the board and plug it in again. **Check:** `lsusb | grep -i 1cbe` then shows a line
"Texas Instruments … In-Circuit Debug Interface".

## 6. Installing Renode (the simulator)

```bash
cd ~
curl -L -o renode.tar.gz \
    https://github.com/renode/renode/releases/download/v1.17.0/renode-1.17.0.linux-portable.tar.gz
mkdir -p ~/renode && tar xf renode.tar.gz -C ~/renode --strip-components=1
rm renode.tar.gz
~/renode/renode --version
```

The last line must print `Renode, version 1.17.0 …`. (On ARM computers use the file
`linux-arm64-portable`.) The "portable" version contains everything it needs (Mono/.NET).

## 7. Setting up `ucsim`

`ucsim` is the start script of the simulator (file `sim/ucsim` in this repository).

```bash
mkdir -p ~/bin
ln -sf ~/lab/renode4mc-haw/sim/ucsim ~/bin/ucsim
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

`ucsim` finds Renode automatically in `~/renode/renode`. If Renode is somewhere else, set
`export RENODE=/path/to/renode`.

## 8. Checking everything (5 minutes)

**a) Simulator:** build and simulate a finished example program (details in
`examples/example01_blinky/README.md`):

```bash
cd ~/lab/renode4mc-haw/examples/example01_blinky
make
ucsim example01_blinky.out
```

The browser opens the LED page; **D1 and D2 blink alternately**. Stop with `Ctrl+C`.

**b) CCS:** start `~/ti/ccs2040/ccs/theia/ccstudio` or the CCS icon in the start menu. On the first
start CCS asks for a workspace folder – accept the suggestion.

**c) Board:** connect the EK-TM4C1294XL with a USB cable to the port **"DEBUG"** (not "USER").
`lsusb` must show the device (step 5).

If a)–c) work, the installation is complete. Continue with
[Example 01 – Blinky](../examples/example01_blinky/README.md).

---

## 9. Loading an `.out` file onto the board manually (without CCS)

The `.out` file created by the compiler (ELF format) can also be written into the flash memory of
the board from the terminal – useful if you just want to try out a finished program, or if CCS is
not at hand. For this there is the program **OpenOCD**, which talks to the on-board debugger (ICDI).

Install it once (the udev rule from step 5 is required):

```bash
sudo apt install openocd
```

Connect the board to the **DEBUG** port, then in the folder with the `.out` file:

```bash
cd ~/lab/renode4mc-haw/examples/example01_blinky
make
openocd -f board/ti_ek-tm4c1294xl.cfg -c "program example01_blinky.out verify reset exit"
```

The output must contain `** Programming Finished **`, `** Verified OK **` and `** Resetting Target **`.
After that the program runs and D1/D2 blink. The message `Error: SRST error` is harmless with this
board. The program stays in flash until it is overwritten (also after unplugging the USB cable).

| Message / problem | Solution |
|---|---|
| `Error: no device found` / `LIBUSB_ERROR_ACCESS` | udev rule missing (step 5)? Cable in the port "DEBUG"? |
| `Error: Can't find board/ti_ek-tm4c1294xl.cfg` | OpenOCD too old; try the file `ek-tm4c1294xl.cfg` or update OpenOCD |
| `Address already in use` (port 3333) | OpenOCD, a CCS debug session or `ucsim --debug` is already running; stop it |

Important: the flash contents are the same in the simulator and on the board – you load the same
`.out` file that you also simulate with `ucsim`.

*Test status:* tested with an EK-TM4C1294XL and OpenOCD 0.12.0 (Ubuntu): programming, verifying
and starting `example01_blinky.out` work. The blinking of the LEDs was not checked visually but via
the program counter (it runs in the busy-wait loop). A TI tool with the same function is
**UniFlash** (GUI, ti.com/tool/UNIFLASH); we have not tested it.

---

## Common problems

| Message / problem | Solution |
|---|---|
| `tiarmclang not found …` / `make` builds `.elf` instead of `.out` | `make` looks for `tiarmclang` in PATH and in `~/ti`, `~/tmp/ti`, `/opt/ti`, `/Applications/ti` (newest version); if nothing is found it uses `arm-none-eabi-gcc`. What is found: `make toolchain`. Different location: `make CCS_ROOT=/path/to/ccs` or `make TIARMCLANG=/path/tiarmclang` |
| `renode not found` | repeat step 6 or `export RENODE=…` |
| the browser shows "Not connected" | `ucsim` is not running (any more); check the terminal |
| CCS: "Could not open device" / board not found | udev rule (step 5), another cable, use the port "DEBUG" |
| simulator warning "access … without clock" | the program does not switch on the clock (`SYSCTL_RCGCGPIO_R \|= …`) – exactly the mistake that would cause a HardFault on the board |

> **Note on the test status:** installing CCS/Renode, building with CCS (without the user
> interface) and the simulation were tested. Programming and debugging the real board and the
> click sequences of the CCS user interface in this guide have not yet been checked by us on the
> real device – please report any differences.
