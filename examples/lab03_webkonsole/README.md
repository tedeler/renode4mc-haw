# Lab 03 – Web-Konsole: UART, I2C, Keypad und Taster

**Ziel:** Ein Programm, das alle Bedienelemente der [Web-Konsole](../../docs/WEBCONSOLE.md)
benutzt. Es gibt Meldungen über **UART0** aus, liest einen **Ultraschallsensor** und beschreibt ein
**OLED-Display** über **I2C**. Ein **Keypad** wird im Multiplexverfahren abgefragt, die **Taster**
lösen Interrupts aus. Erst im **Simulator** (Web-Konsole), dann auf dem **Board** mit
Zusatz-Hardware.

**Vorher:** [Lab 01](../lab01_blinky/README.md) (GPIO, Clock-Gating) und
[Lab 02](../lab02_timer_blink/README.md) (Timer, Interrupt).

| | |
|---|---|
| Board | EK-TM4C1294XL (TM4C1294NCPDT), Takt 16 MHz (unverändert) |
| LEDs | D1 = PN1 (Abstand < 50 cm), D2 = PN0 (Herzschlag 1 Hz), D3 = PF4 / D4 = PF0 (Taster) |
| Taster | USR_SW1 = PJ0, USR_SW2 = PJ1 (gedrückt = LOW), Interrupt bei fallender Flanke |
| UART0 | PA0 RX / PA1 TX, 115200 Baud, 8N1 (virtueller COM-Port des Boards) |
| I2C0 | PB2 SCL / PB3 SDA, 100 kHz |
| OLED | SSD1306 128×64, I2C-Adresse 0x3C |
| Ultraschall | MaxBotix MB1242 (I2CXL-MaxSonar), I2C-Adresse 0x70 |
| Keypad 4×3 | Zeilen PK0–PK3 (Ausgang), Spalten PK4–PK6 (Eingang, Pull-down, Interrupt) |
| Timer | Timer0A, 100 ms periodisch |
| Dateien | `main.c`, `lab03_webkonsole.projectspec`, `Makefile` |

---

## 1. Was Sie lernen

- **UART:** Baudrate aus dem Takt berechnen (`IBRD`/`FBRD`), Pins auf die alternative Funktion
  umschalten (`AFSEL`, `PCTL`), Senden mit Abfrage von `TXFF`, Empfangen mit `RXFE`.
- **I2C-Master:** Adresse in `MSA`, Daten in `MDR`, Ablauf über `MCS` (START, RUN, STOP, ACK).
  Danach auf das Ende warten und den Fehler prüfen (`BUSY`, `ERROR`).
- **Gerät am Bus:** Das OLED bekommt pro Übertragung ein Steuerbyte (`0x00` = Befehle,
  `0x40` = Bilddaten). Der Sensor misst nach dem Befehl `0x51` und liefert 2 Bytes.
- **Multiplexing:** Mit 4 + 3 Leitungen lassen sich 12 Tasten abfragen. Die Firmware treibt eine
  Zeile HIGH und liest die Spalten.
- **Interrupts von mehreren Quellen** (Timer, Port J, Port K): Die ISR setzt nur ein Flag, die
  Arbeit erledigt die Hauptschleife.

## 2. Das Programm verstehen (`main.c`)

Alle Register und Bits kommen aus `tm4c1294ncpdt.h` (siehe Lab 01); im Programm steht keine Adresse.

| Register (Datenblatt) | Name in `tm4c1294ncpdt.h` | Adresse | Wirkung hier |
|---|---|---|---|
| `RCGCUART` / `PRUART` | `SYSCTL_RCGCUART_R` / `SYSCTL_PRUART_R` | `0x400FE618` / `0x400FEA18` | `…_R0` (Bit 0): Takt für UART0 |
| `RCGCI2C` / `PRI2C` | `SYSCTL_RCGCI2C_R` / `SYSCTL_PRI2C_R` | `0x400FE620` / `0x400FEA20` | `…_R0` (Bit 0): Takt für I2C0 |
| `UARTIBRD` / `UARTFBRD` | `UART0_IBRD_R` / `UART0_FBRD_R` | `0x4000C024` / `0x4000C028` | 8 / 44 → 115200 Baud bei 16 MHz |
| `UARTLCRH` | `UART0_LCRH_R` | `0x4000C02C` | `UART_LCRH_WLEN_8 \| UART_LCRH_FEN`: 8 Datenbits, FIFO an |
| `UARTCTL` | `UART0_CTL_R` | `0x4000C030` | `UART_CTL_UARTEN`, `UART_CTL_TXE`, `UART_CTL_RXE` |
| `I2CMCR` | `I2C0_MCR_R` | `0x40020020` | `I2C_MCR_MFE`: Master einschalten |
| `I2CMTPR` | `I2C0_MTPR_R` | `0x4002000C` | 7 → 100 kHz bei 16 MHz |
| `I2CMSA` / `I2CMDR` / `I2CMCS` | `I2C0_MSA_R` / `I2C0_MDR_R` / `I2C0_MCS_R` | `0x40020000` / `…08` / `…04` | Adresse+R/W, Datenbyte, Befehl/Status (`I2C_MCS_RUN`, `…_START`, `…_STOP`, `…_ACK`) |
| `GPIOIEV` (Port K) | `GPIO_PORTK_IEV_R` | `0x4006140C` | Spalten: Interrupt bei steigender Flanke |

Zwei Dinge, die die Headerdatei **nicht** enthält und die deshalb in `main.c` stehen:
- die Pin-Funktionen für `GPIOPCTL` (Datenblatt, Tabelle „GPIO Pins and Alternate Functions“:
  PA0/PA1 → Funktion 1 = U0RX/U0TX, PB2/PB3 → Funktion 2 = I2C0SCL/I2C0SDA) und
- die NVIC-Nummern: `IRQ_GPIOJ = INT_GPIOJ − 16 = 51` → Bit 19 in `NVIC_EN1_R` (51 − 32).

**Einzelne Pins schreiben:** `GPIO_PORTK_DATA_BITS_R[maske] = wert` ändert nur die Pins, deren Bit in
`maske` gesetzt ist (Adressmaskierung des `GPIODATA`-Registers, Datenblatt Kapitel GPIO, „Data Register Operation“).

**Baudrate:** `BRD = 16 000 000 / (16 · 115 200) = 8,6806` → `IBRD = 8`,
`FBRD = round(0,6806 · 64) = 44`.

**I2C-Takt:** `TPR = 16 MHz / (2 · (6 + 4) · 100 kHz) − 1 = 7`.

**Keypad-Abfrage:**

```c
// Ruhezustand: alle Zeilen HIGH -> ein Tastendruck macht seine Spalte HIGH -> Interrupt (GPIOK_Handler)
for (zeile = 0; zeile < 4; zeile++) {
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << zeile;          // nur diese Zeile HIGH
    spalten = (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) >> 4;
    if (spalten) { taste = keymap[zeile][erste gesetzte Spalte]; break; }
}
GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;                  // wieder alle Zeilen HIGH
```

## 3. Variante A: Im Simulator (Web-Konsole)

1. Bauen: in CCS (Import wie in Lab 01, `lab03_webkonsole.projectspec`) oder
   ```bash
   cd ~/praktikum/renode4mc-haw/examples/lab03_webkonsole
   make
   ```
2. Web-Konsole starten (einmalig bauen dauert einige Minuten):
   ```bash
   cd ~/praktikum/renode4mc-haw/webconsole
   docker compose up --build
   ```
3. http://localhost:3000 öffnen, **Versuch 1** wählen, `lab03_webkonsole.out` auswählen, **Start**.

Was Sie sehen sollten:

- Im **Terminal**: `renode4mc-haw - Lab 03 Web-Konsole`, danach `Abstand: 100 cm`.
- Auf dem **OLED**: Titel, `ABSTAND: 100 CM`, `TASTE: -`, `UART: -`.
- **D2** blinkt mit 1 Hz.
- **Schieberegler** unter 50 cm: **D1** geht an, Terminal und OLED zeigen den neuen Abstand.
- **Keypad** „5“ drücken: `Taste: 5`, beim Loslassen `Taste losgelassen`.
- **USR_SW1**/**USR_SW2**: **D3**/**D4** werden umgeschaltet.
- Ins **Terminal** tippen: Die Zeichen kommen zurück (Echo), das letzte steht auf dem OLED.

`make sim` (also `ucsim`) startet nur den einfachen Simulator: Dort blinkt D2, aber OLED, Sensor
und Keypad fehlen. Der Simulator meldet einmal je Adresse *„kein Gerät unter Adresse 0x3C“*.

### Selbst ausprobieren

- Entfernen Sie `SYSCTL_RCGCI2C_R |= …`. Das Programm bleibt in der Warteschleife auf `PRI2C`
  hängen, und es erscheint keine Ausgabe. Warum? Entfernen Sie zusätzlich `(SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0`
  aus der Bedingung. Jetzt warnt der Simulator *„I2C0: Zugriff … ohne Takt!“*.
- Ändern Sie `OLED_ADDR` auf `0x3D`. Was gibt `i2c_wait()` zurück?
- Entfernen Sie in `keypad_scan()` das Setzen der Zeile (`GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << zeile`).
  Welche Taste wird erkannt?

## 4. Variante B: Auf dem Board

Zusätzlich zum EK-TM4C1294XL nötig: SSD1306-OLED-Modul (I2C, 3,3 V), MB1242-Sensor (3,3–5 V) und
ein 4×3-Folienkeypad. Anschluss laut Tabelle oben. Pull-up-Widerstände für SCL/SDA haben die
meisten OLED-Module bereits. Import, Bauen und Debuggen funktionieren wie in Lab 02, Abschnitt 4.
Den UART sehen Sie z. B. mit `picocom -b 115200 /dev/ttyACM0`.

> **Hinweis:** Auf der Hardware prellen Taster und Keypad. Das Programm entprellt nicht, weil der
> Simulator kein Prellen nachbildet. Ergänzen Sie dafür eine Sperrzeit (z. B. 50 ms über `ticks`).

## 5. Aufgaben

1. Geben Sie zusätzlich die Zeit seit dem Start (in Sekunden, aus `ticks`) auf OLED-Zeile 2 aus.
2. Senden Sie über das Terminal den Befehl `L` → alle LEDs aus, `H` → alle an.
3. Schalten Sie den UART-Empfang auf Interrupt um (`UART0_IM_R` mit `UART_IM_RXIM`/`UART_IM_RTIM`, `UART0_Handler`, NVIC IRQ `INT_UART0 − 16` = 5).
4. Bauen Sie eine Code-Sperre: Nach der Eingabe `1234#` auf dem Keypad leuchtet D1 für 2 s.

## 6. Hinweise zum Simulator

- UART und I2C übertragen ohne Zeitverzögerung. Busy-Abfragen sind trotzdem nötig, weil das
  Programm sonst auf der Hardware nicht läuft.
- Der Ultraschallsensor liefert sofort den eingestellten Wert. Die echte Messung dauert ca. 80 ms,
  deshalb liest das Programm erst beim nächsten 100-ms-Takt.
- Details zu den Modellen: [docs/WEBCONSOLE.md](../../docs/WEBCONSOLE.md), Abschnitt 2.
