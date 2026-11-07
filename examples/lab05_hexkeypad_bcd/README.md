# Lab 05 – Hex-Keypad und BCD-Anzeige (Musterlösung MCL Lab Session 1)

Musterlösung zu Teil 2 von Lab Session 1: Tasten des HAW-Hex-Keypads abfragen, mit `printf()`
ausgeben und auf der 7-Segment-Anzeige zeigen. Im Simulator: Web-Konsole, Versuch **lab1_gpio**
(Beschreibung der Umgebung: [docs/LABORE.md](../../docs/LABORE.md)).

| | |
|---|---|
| Keypad | Spalten X1–X4 = PM0–PM3 (Ausgang), Zeilen Y1–Y4 = PM4–PM7 (Eingang, Pull-up auf dem Keypad) |
| BCD-Anzeige | D0–D7 = PK0–PK7, EN rechts = PL0, EN links = PL1 |
| Ausgabe | `printf()` in der CCS-Konsole (Heap 2048 Byte im Linker eingestellt) |
| Dateien | `main.c`, `lab05_hexkeypad_bcd.projectspec`, `Makefile` |

- **Abfrage:** `keypad_scan()` setzt nacheinander eine Spalte auf 0, wartet mit `wait()` die
  Laufzeit der Leitungen ab und liest die Zeilen. Eine 0 in Zeile r bei Spalte x heißt: Taste
  `tastenname[r][x]` ist gedrückt.
- **Anforderung 1:** Ein Zustandswechsel wird nur einmal ausgegeben (entprellt über acht gleiche
  Abfragen).
- **Anforderung 2:** Bei mehr als einer Taste kommt eine Fehlermeldung.
- **Anzeige:** Rechts steht die zuletzt gedrückte Taste, links davon die drei davor.

Ausprobieren: Ohne `wait()` (`WAIT_SCAN 0`) meldet das Programm im Simulator falsche bzw. mehrere
Tasten. Das liegt an der nachgebildeten Anstiegszeit der Zeilen, so wie es das Laborskript
beschreibt.

```bash
make            # tiarmclang (CCS), dann lab05_hexkeypad_bcd.out in der Web-Konsole hochladen
```
