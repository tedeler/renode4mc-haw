# Lab 04 – LEDs per UART schalten, SW1-Interrupt (Musterlösung IE4-MCL UART)

Musterlösung zu „Controlling a microcontroller with the PC via UART protocol“. Im Simulator:
Web-Konsole, Versuch **lab4_uart**. Das Terminal ist dort wie Tera Term im Skript eingestellt:
9600 Bit/s 7N1, lokales Echo, CR → CR+LF ([docs/LABORE.md](../../docs/LABORE.md)).

| | |
|---|---|
| UART0 | PA0 = U0RX, PA1 = U0TX, `IBRD = 104`, `FBRD = 11`, `LCRH = 0x40` (7N1, ohne FIFO) bei 16 MHz → 9600,2 Bit/s (+0,002 %) |
| LEDs | D1 = PN1, D2 = PN0, D3 = PF4, D4 = PF0 |
| SW1 | PJ0, interner Pull-up, Interrupt bei steigender Flanke (Loslassen) |

- **3.2:** Das Programm sendet den Prompt `>` und liest per Abfrage, ohne zu blockieren, in
  `cmdLineUart[16]`. Bei CR oder beim 16. Zeichen schließt es die Zeile mit `'\0'` ab und gibt sie
  mit `printf()` aus.
- **3.3/4.1:** `cmdToLed()` wertet `leds <+|-|~><1..4>…` aus. Bei einem Syntaxfehler bricht es ab
  dieser Stelle ab.
- **4.2:** `IntPortJHandler()` sendet `#`, die Nummern der leuchtenden LEDs und CR. Er steht per
  Alias als `GPIOJ_Handler` in der Vektortabelle von `common/startup_tm4c1294.c`.

Im Simulator ausprobieren: Wer `IBRD`/`FBRD`/`LCRH` falsch einstellt, bekommt wie am Board
Zeichensalat oder gar nichts und eine Diagnosemeldung. Die Einstellung des Terminals lässt sich im
UART-Monitor ändern (Baud, Daten, Parität, Stopp). Ohne `GPIO_PORTJ_AHB_PUR_R` kommt beim Loslassen von SW1 kein Interrupt, und
die Diagnose meldet den offenen Eingang PJ0.
