# Installation unter Linux

Diese Anleitung richtet alles ein, was Sie für das Mikrocontroller-Praktikum brauchen:

| Was | Wofür |
|---|---|
| **Code Composer Studio (CCS)** | Programmieren, Übersetzen, Programm auf das Board laden, Debuggen |
| **Renode + `ucsim`** | Simulator: Programm ohne Board ausführen, LEDs im Browser anzeigen |
| **udev-Regel** | Erlaubt Ihnen den USB-Zugriff auf das Board (ohne `sudo`) |

Die Beispiele greifen **direkt auf die Register** zu (Datenblatt statt Bibliothek) – TivaWare/driverlib
wird **nicht** benötigt.

Getestet mit: CCS 20.4 (Linux x64), Renode 1.17.0, Ubuntu/Debian-artiges Linux.
Rechnen Sie mit ca. 1 h und rund 6 GB freiem Plattenplatz. Die Anleitung geht davon aus, dass Sie
alles in Ihrem Home-Verzeichnis unter `~/ti` installieren – das braucht keine Administratorrechte
(nur Schritt 5 benötigt `sudo`).

> Alle Befehle werden in einem **Terminal** eingegeben. Zeilen, die mit `$` beginnen, tippen Sie
> ohne das `$`.

---

## 1. Benötigte Pakete

```bash
sudo apt update
sudo apt install git make curl libusb-1.0-0 libgtk-3-0 gdb-multiarch xdg-utils
```

`gdb-multiarch` wird nur für das Debuggen im Simulator gebraucht (Schritt 8). Auf anderen
Distributionen heißen die Pakete ähnlich (Fedora: `dnf install git make curl libusb gtk3 gdb`).

## 2. Dieses Repository holen

```bash
$ mkdir -p ~/praktikum && cd ~/praktikum
$ git clone https://github.com/tedeler/renode4mc-haw.git
$ cd renode4mc-haw
```

(Das Repository ist derzeit **privat** – Sie brauchen Zugriff und müssen bei GitHub angemeldet
sein, z. B. über `gh auth login`.)

## 3. Code Composer Studio installieren

1. Auf <https://www.ti.com/tool/CCSTUDIO> den **Linux-Installer** (`CCS…_linux-x64.tar.gz`) laden
   (kostenloser TI-Account nötig).
2. Entpacken und Installer starten:
   ```bash
   $ cd ~/Downloads
   $ tar xf CCS*_linux-x64.tar.gz
   $ cd CCS*_linux-x64
   $ ./ccs_setup_*.run          # Name kann abweichen; im Ordner nachsehen mit: ls
   ```
3. **Installationsordner:** `~/ti` (Vorschlag des Installers übernehmen oder `~/ti` eintragen).
   Danach liegt CCS in `~/ti/ccs2040` (Zahl = Version, bei Ihnen evtl. anders).
4. Bei „Select Components“ genügt **Tiva C Series Arm Cortex-M4 MCUs** (spart Platz).
5. Bei „Debug Probes“ den **Stellaris/Tiva ICDI** (bzw. „TI XDS/ICDI“) angehakt lassen.

Die Programmiersprache C wird von **TI Arm Clang** übersetzt; er ist in CCS enthalten
## 4. Datenblatt besorgen (statt TivaWare)

Im Praktikum programmieren Sie **ohne Bibliothek** direkt über die Register. Dafür brauchen Sie das
Datenblatt: <https://www.ti.com/product/TM4C1294NCPDT> → *Technical documents* →
„Tiva TM4C1294NCPDT Microcontroller Data Sheet“ (PDF). Adressen und Bitnummern in den Beispielen
stammen von dort. Zusätzlich hilfreich: das Board-Handbuch „EK-TM4C1294XL User's Guide“.

## 5. USB-Zugriff auf das Board (udev-Regel)

Ohne diese Regel darf nur `root` mit dem Board sprechen. Ein Debug-Fehler wie
„Could not open device“ deutet darauf hin.

```bash
$ cd ~/ti/ccs2040/ccs/install_scripts
$ sudo ./ti_permissions_install.sh
```

Alternativ (nur für das EK-TM4C1294XL; Datei `99-tiva-launchpad.rules`):

```bash
$ echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="1cbe", ATTRS{idProduct}=="00fd", MODE="0666"' \
    | sudo tee /etc/udev/rules.d/99-tiva-launchpad.rules
$ sudo udevadm control --reload-rules && sudo udevadm trigger
```

Board neu einstecken. **Kontrolle:** `lsusb | grep -i 1cbe` zeigt dann eine Zeile
„Texas Instruments … In-Circuit Debug Interface“.

## 6. Renode (der Simulator) installieren

```bash
$ cd ~
$ curl -L -o renode.tar.gz \
    https://github.com/renode/renode/releases/download/v1.17.0/renode-1.17.0.linux-portable.tar.gz
$ mkdir -p ~/renode && tar xf renode.tar.gz -C ~/renode --strip-components=1
$ rm renode.tar.gz
$ ~/renode/renode --version
```

Die letzte Zeile muss `Renode, version 1.17.0 …` ausgeben. (Auf ARM-Rechnern: die Datei
`linux-arm64-portable` verwenden.) Die „portable“-Version bringt alles Nötige mit (Mono/.NET).

## 7. `ucsim` einrichten

`ucsim` ist das Startskript des Simulators (Datei `sim/ucsim` in diesem Repository).

```bash
$ mkdir -p ~/bin
$ ln -sf ~/praktikum/renode4mc-haw/sim/ucsim ~/bin/ucsim
$ echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
$ source ~/.bashrc
```

`ucsim` findet Renode automatisch unter `~/renode/renode`. Liegt Renode woanders, setzen Sie
`export RENODE=/pfad/zu/renode`.

## 8. Alles prüfen (5 Minuten)

**a) Simulator:** Ein fertiges Beispielprogramm bauen und simulieren (Details in
`examples/lab01_blinky/README.md`):

```bash
$ cd ~/praktikum/renode4mc-haw/examples/lab01_blinky
$ make
$ ucsim lab01_blinky.out
```

Der Browser öffnet die LED-Anzeige; **D1 und D2 blinken abwechselnd**. Beenden: `Strg+C`.

**b) CCS:** Starten Sie `~/ti/ccs2040/ccs/theia/ccstudio` bzw. das CCS-Symbol im Startmenü. Beim ersten
Start fragt CCS nach einem Workspace-Ordner – den Vorschlag übernehmen.

**c) Board:** Das EK-TM4C1294XL per USB-Kabel am Port **„DEBUG“** anschließen (nicht „USER“).
`lsusb` muss das Gerät zeigen (Schritt 5).

Wenn a)–c) funktionieren, ist die Installation fertig. Weiter mit
[Lab 01 – Blinky](../examples/lab01_blinky/README.md).

---

## Häufige Probleme

| Meldung / Problem | Lösung |
|---|---|
| `make: tiarmclang: Datei nicht gefunden` | `CCS_ROOT` stimmt nicht: `make CCS_ROOT=$HOME/ti/ccs2040/ccs` |
| `renode nicht gefunden` | Schritt 6 wiederholen oder `export RENODE=…` |
| Browser zeigt „Nicht verbunden“ | `ucsim` läuft nicht (mehr); Terminal prüfen |
| CCS: „Could not open device“ / Board nicht gefunden | udev-Regel (Schritt 5), anderes Kabel, Port „DEBUG“ benutzen |
| Simulator-Warnung „Zugriff … ohne Takt“ | Im Programm fehlt das Einschalten des Takts (`SYSCTL_RCGCGPIO \|= …`) – genau der Fehler, der auf dem Board einen HardFault auslösen würde |

> **Hinweis zum Test-Stand:** Die Installation von CCS/Renode, das Bauen mit CCS (ohne
> Oberfläche) und die Simulation wurden getestet. Das Programmieren und Debuggen des echten
> Boards und die Klickfolgen der CCS-Oberfläche in dieser Anleitung wurden von uns noch nicht am
> realen Gerät geprüft – bei Abweichungen bitte melden.
