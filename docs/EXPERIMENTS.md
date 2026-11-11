# Versuche beschreiben (`sim/experiments/<id>.json`)

Ein Versuch der Web-Konsole ist **eine JSON-Datei** in `sim/experiments/`. Sie zählt die Bedienelemente
(LEDs, Taster, Keypad, Anzeigen, Sensoren …) auf und legt für jedes fest, **an welchen Pins** des
TM4C1294 es hängt. Mehr braucht es nicht: Datei ablegen, und der Versuch erscheint in der Auswahlliste
der Web-Konsole (nach dem Neuladen der Seite). Der Dateiname ohne `.json` ist die Versuchs-ID
(Buchstaben, Ziffern, `_`, `-`).

Aus der Datei erzeugt das Backend beim Start des Versuchs die Renode-Plattform (`.repl`: Geräte und
Verdrahtung) und das Startskript (`.resc`). Beide liegen nur im temporären Verzeichnis
(`GENERATED_DIR`, Standard `/tmp/renode4mc-experiments`) und werden nicht von Hand bearbeitet.

## Prüfen

```bash
node tools/check_experiment.js                    # alle Versuche in sim/experiments/
node tools/check_experiment.js mein_versuch.json  # eine Datei, auch außerhalb des Repositorys
node tools/check_experiment.js --types            # Elementtypen, Felder und Anschlüsse
node tools/check_experiment.js --repl --resc lab1_gpio   # zeigen, was erzeugt wird
```

Das Werkzeug macht dieselbe Prüfung wie das Backend (Code: `webconsole/backend/lib/experimentSpec.js`)
und zusätzlich: Gibt es die Gerätemodelle in `sim/models/` und das Beispiel der Musterlösung in
`examples/`? Exit-Code 0 = gültig (Hinweise erlaubt), 1 = Fehler. Ein ungültiger Versuch erscheint in
der Web-Konsole nicht; der Grund steht dann im Server-Log.

Geprüft wird unter anderem:

| Fehler | Beispiel |
|---|---|
| Pin gibt es auf dem Chip nicht | `PN7` (Port N hat nur PN0–PN5), `PZ1` |
| Pin doppelt belegt | `EN_R` und `D0` beide an `PK0` |
| Pin fest belegt | RX/TX des Terminal-UARTs (Standard PA0/PA1), PC0–PC3 (JTAG), PB2/PB3 sobald ein I2C0-Gerät da ist |
| UART-Pin nicht möglich | `"rx": "PK2"` (kein UxRx-Pin), `"rx": "PA4", "tx": "PA1"` (U3Rx und U0Tx – verschiedene UARTs) |
| Anschluss fehlt oder unbekannt | `"EN"` statt `"EN_L"` beim BCD-Display |
| unbekanntes Feld, Tippfehler | `"colour"` statt `"color"`, Typ `"pendel"` statt `"pendulum"` |
| Widget mehrfach | zwei Sensoren (die Web-Konsole hat je ein Keypad, eine 7-Segment-Anzeige, ein Pendel, ein OLED, einen Sensor) |
| I2C-Adresse doppelt | zwei Geräte an `i2c0` mit `0x70` |
| zu viele LEDs | mehr als 8 (die LED-Brücke hat 8 Eingänge) |

Hinweise (kein Fehler): Pin ist auf dem Board schon mit einer LED/einem Taster verbunden, PD7 ist
geschützt (GPIOLOCK nötig), Taster-Polarität passt nicht zum Pull-Widerstand, Oszilloskop-Kanal an
einem unbenutzten Pin.

## Aufbau

```jsonc
{
  "title": "Mein Versuch",                 // Pflicht: Name in der Auswahlliste
  "description": "…",                      // optional
  "quantumUs": 10,                         // Renode-Zeitscheibe in µs (Standard 10; 100 = Renode-Standard)
  "uart": {                                // PC-Terminal, optional (Standard: UART0 an PA0/PA1)
    "rx": "PA0", "tx": "PA1",             // Pins des UARTs, siehe „UART-Pins“ unten
    "baud": 115200, "format": "8N1",      // Standard-Einstellung des Terminals
    "label": "…", "localEcho": false, "crlf": false
  },
  "solution": { "example": "lab01_hexkeypad_bcd", "label": "Musterlösung (…)" },   // optional
  "elements": [ … ],                       // Pflicht: Bedienelemente, siehe unten
  "scope": {                               // Oszilloskop, optional
    "channels": ["PM0", "PM4", "PL0", "PL1"],  // Startbelegung CH1..CH4 (Standard: die ersten 4 Signale)
    "trigger": { "source": "PM0", "edge": "falling" },
    "signals": [ { "pin": "PB0", "label": "eigener Name" } ]  // Beschriftungen ändern/ergänzen
  }
}
```

Felder, die mit `_` beginnen, sind Kommentare und werden überall ignoriert
(`"_pins": "LED0 ist die oberste LED"`).

Immer vorhanden (nicht beschreiben): ein UART mit PC-Terminal (siehe „UART-Pins“), Reset-Knopf, Simulations-Anzeige,
Debugger, Oszilloskop. Die Oszilloskop-Auswahl „Signale dieses Versuchs“ entsteht aus den Pins der
Elemente; mit `"labels": { "<Anschluss>": "Text" }` in einem Element oder `scope.signals` lässt sich
die Beschriftung ändern.

## Elemente

Jedes Element hat `"type"`. Elemente mit einem Pin haben `"pin"`, Elemente mit mehreren Anschlüssen
`"pins": { "<Anschluss>": "<Pin>" }`. Pins schreibt man wie im Datenblatt: `"PK0"`, `"PL1"`.

| Typ | Gerät | Anschlüsse | Felder (außer `type`, `pin(s)`, `labels`) |
|---|---|---|---|
| `led` | LED, HIGH = an (mehrere) | `pin` | `id` (Pflicht), `label`, `color` (`"#22c55e"`) |
| `button` | Taster (mehrere) | `pin` | `id` (Pflicht), `label`, `activeLow` (Standard `true`: gedrückt = GND), `pull` (`"up"`, `"down"`, `"none"`) |
| `bcd` | 7-Segment-Anzeige mit BCD-Eingängen (HAW, Lab 1) | `D0`–`D7`, `EN_R`, `EN_L` | `label` |
| `hexkeypad` | Hex-Keypad 4×4 der HAW (aktiv LOW, Lab 1) | `X1`–`X4` (Spalten, MCU-Ausgänge), `Y1`–`Y4` (Zeilen, MCU-Eingänge) | `title`, `label`, `layout`, `riseTimeUs` (Standard 20) |
| `keypad` | Tastenmatrix, aktiv HIGH | `R0`… (Zeilen, MCU-Ausgänge), `C0`… (Spalten, MCU-Eingänge); Anzahl nach `layout` | `title`, `label`, `layout` (Standard 4×3 Telefon) |
| `pendulum` | LED-Pendel / Pendeldisplay | `LED0`–`LED7` (`LED0` = oberste LED an der Spitze), `SYNC` (MCU-Eingang) | `label`, `frequency`, `minFrequency`, `maxFrequency` (Hz, Schieberegler), `afterglowMs`, `syncMode` (`"position"`: HIGH = rechts; `"direction"`: HAW-Pendel, HIGH = Schwung nach rechts), `periodUs`, `columns` |
| `hcsr04` | Ultraschall HC-SR04 (Lab 2/3) | `TRIG` (MCU-Ausgang), `ECHO` (MCU-Eingang) | `initial` (cm), `min`, `max`, `unit`, `title`, `label` |
| `mb1242` | Ultraschall MaxBotix MB1242, I2C | – | `bus` (Standard `"i2c0"`), `address` (Standard `"0x70"`), `initial`, `min`, `max`, `unit`, `title`, `label` |
| `oled` | OLED SSD1306, I2C | – | `bus` (Standard `"i2c0"`), `address` (Standard `"0x3C"`), `width`, `height`, `label` |
| `cio` | printf()-Konsole wie in CCS | – | `label` |

### UART-Pins

Das PC-Terminal hängt an dem UART, zu dem `uart.rx` und `uart.tx` gehören. Welche Pins ein UART
benutzen kann, legt der Chip fest (Datenblatt Tabelle 10-2, GPIOPCTL-Funktion 1 für alle):

| UART | RX | TX |
|---|---|---|
| UART0 | PA0 | PA1 |
| UART1 | PB0, PQ4 | PB1 |
| UART2 | PA6, PD4 | PA7, PD5 |
| UART3 | PA4, PJ0 | PA5, PJ1 |
| UART4 | PA2, PK0 | PA3, PK1 |
| UART5 | PC6 | PC7 |
| UART6 | PP0 | PP1 |
| UART7 | PC4 | PC5 |

RX und TX müssen zum selben UART gehören, dürfen aber an verschiedenen Ports liegen (z. B. UART2:
RX PA6, TX PD5). Die Firmware muss genau diese Pins schalten (GPIOAFSEL, GPIODEN, GPIOPCTL = 1) und
den UART takten; sonst kommt wie auf dem Board nichts an, und die Diagnose meldet es. Auf dem
EK-TM4C1294XL hängt nur UART0 (PA0/PA1) am virtuellen COM-Port – für einen anderen UART braucht echte
Hardware einen USB-Seriell-Adapter (das Prüfwerkzeug gibt einen Hinweis). Im Simulator:
`sysbus.uart3 SetPins "PJ1" "PJ0"` (TX, RX), abfragen mit `sysbus.uart3 Pins`.

```json
"uart": { "rx": "PJ0", "tx": "PJ1", "baud": 9600, "format": "8N1" }
```

### Pull-Widerstände

`"pull": "up"` bei einem Taster bedeutet einen Widerstand **auf der Platine**: Losgelassen liest der Pin
HIGH, auch wenn die Firmware GPIOPUR nicht setzt, und es gibt keine Warnung „offener Eingang“. Ohne
`pull` (wie USR_SW1/2 auf dem EK-TM4C1294XL) muss die Firmware den internen Pull-up einschalten – der
Simulator meldet es sonst wie bisher. Ein Pull der Firmware in die Gegenrichtung hat Vorrang.
Im Modell: `TivaGPIOPort.ExternalPullUp` / `ExternalPullDown` (Bitmaske je Port).

Die Pull-Widerstände von Keypad (`hexkeypad`: Pull-up der Zeilen, `keypad`: Pull-down der Spalten)
sind Teil des Gerätemodells und werden nicht angegeben.

## Beispiel

```json
{
  "title": "Mein Versuch: Zähler auf der 7-Segment-Anzeige",
  "quantumUs": 10,
  "uart": { "baud": 115200, "format": "8N1" },
  "elements": [
    { "type": "bcd", "label": "D0–D7 = PK0–PK7, EN rechts = PL0, EN links = PL1",
      "pins": { "D0": "PK0", "D1": "PK1", "D2": "PK2", "D3": "PK3",
                "D4": "PK4", "D5": "PK5", "D6": "PK6", "D7": "PK7",
                "EN_R": "PL0", "EN_L": "PL1" } },
    { "type": "button", "id": "T1", "label": "Zählen (PE1)", "pin": "PE1", "pull": "up" },
    { "type": "led", "id": "L1", "label": "Überlauf (PE0)", "color": "#ef4444", "pin": "PE0" },
    { "type": "cio" }
  ],
  "scope": { "channels": ["PE1", "PL0", "PK0", "PE0"], "trigger": { "source": "PE1", "edge": "falling" } }
}
```

Die vorhandenen Versuche (`example1`, `example2`, `lab1_gpio` … `lab4_uart`) sind ebenfalls Vorlagen.
Die Board-LEDs D1–D4 (PN1, PN0, PF4, PF0) und Taster USR_SW1/2 (PJ0, PJ1) sind normale `led`- bzw.
`button`-Elemente; ein Versuch ohne sie zeigt sie nicht an.

## Ohne Web-Konsole starten

```bash
node tools/check_experiment.js --out /tmp/v lab1_gpio
cd sim && renode --console -e "\$elf=@../examples/lab01_hexkeypad_bcd/lab01_hexkeypad_bcd.out; s @/tmp/v/lab1_gpio.resc"
```

## Neuen Gerätetyp hinzufügen

Ein neuer Typ braucht ein C#-Modell (`sim/models/`), einen Eintrag im Katalog `TYPES` in
`webconsole/backend/lib/experimentSpec.js` (Anschlüsse mit Richtung und Index, Konstruktor-Parameter,
Widget-Einstellungen) sowie – für ein neues Widget – Abfrage/Befehl in `lib/controlBridge.js` und die
Komponente im Frontend (`ControlPanel.jsx`). Das Prüfwerkzeug kennt den neuen Typ dann automatisch.
