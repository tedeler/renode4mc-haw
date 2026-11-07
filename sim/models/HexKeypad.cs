// Hexadezimal-Keypad des HAW-IT-Labors (4x4, Tasten 0..F), Lab 1 des Mikrocontroller-Praktikums.
//
// Aufbau wie im Laborskript (Anhang 1, Bild 1 und 2):
//   * Eingänge X1..X4 (Spalten) kommen von GPIO-AUSGÄNGEN des Mikrocontrollers
//     ("strong digital output"):   gpioM:  0 -> hexkeypad@0  ...  3 -> hexkeypad@3
//   * Ausgänge Y1..Y4 (Zeilen) gehen auf GPIO-EINGÄNGE. Jede Zeile hat auf dem Keypad einen
//     schwachen Pull-up (100 kOhm) nach 3,3 V:   hexkeypad: Y0 -> gpioM@4 ... Y3 -> gpioM@7
//   * Eine gedrückte Taste verbindet ihre Spalte X mit ihrer Zeile Y:
//       Y = LOW, sobald mindestens eine gedrückte Taste der Zeile an einer Spalte mit X = LOW hängt,
//       sonst HIGH (Pull-up). Die Firmware setzt nacheinander je ein X auf 0 und liest die Y.
//
//          X1  X2  X3  X4
//     Y1    1   2   3   F
//     Y2    4   5   6   E
//     Y3    7   8   9   D
//     Y4    A   0   B   C
//
// Laufzeitverzögerung ("Runtime delays" im Skript): Der Wechsel einer Zeile auf LOW kommt sofort
// (der Ausgang treibt stark), der Wechsel zurück auf HIGH erst nach RiseTimeUs, weil nur der
// 100-kOhm-Pull-up die Leitungskapazität umlädt. Liest die Firmware Y ohne Wartezeit direkt nach
// dem Umschalten der Spalte, sieht sie also noch den Pegel der vorigen Spalte – genau der Fehler,
// den die Warteschleife wait() im Skript verhindern soll. RiseTimeUs = 0 schaltet das ab.
// Hinweis: Renode rechnet die CPU in Zeitscheiben (Quantum, in den Lab-Skripten 10 us); die
// Verzögerung ist deshalb nur auf etwa ein Quantum genau.
//
// Bedienung im Renode-Monitor (bzw. per Klick in der Web-Konsole):
//   sysbus.gpioM.hexkeypad SetKey 1 1 true     (Zeile Y2, Spalte X2 = Taste "5" drücken)
//   sysbus.gpioM.hexkeypad SetKey 1 1 false    (loslassen)
//   sysbus.gpioM.hexkeypad ReleaseAll
//   sysbus.gpioM.hexkeypad RiseTimeUs 50       (Anstiegszeit ändern)
//   sysbus.gpioM.hexkeypad Rows                (Pegel Y4..Y1 als Bitmaske, zur Kontrolle)
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class HexKeypad : IGPIOReceiver
    {
        public HexKeypad(IMachine machine, uint riseTimeUs = 20)
        {
            this.machine = machine;
            RiseTimeUs = riseTimeUs;
            Y0 = new GPIO();
            Y1 = new GPIO();
            Y2 = new GPIO();
            Y3 = new GPIO();
            outputs = new[] { Y0, Y1, Y2, Y3 };
            Reset();
        }

        // Zeilenausgänge Y1..Y4 (zum GPIO-Eingang des Mikrocontrollers)
        public GPIO Y0 { get; private set; }
        public GPIO Y1 { get; private set; }
        public GPIO Y2 { get; private set; }
        public GPIO Y3 { get; private set; }

        // Anstiegszeit LOW -> HIGH einer Zeile in us (0 = sofort)
        public uint RiseTimeUs { get; set; }

        // Aktuelle Pegel der Zeilen (Bit r = Y(r+1))
        public int Rows
        {
            get
            {
                int v = 0;
                for(int r = 0; r < Size; r++) if(outputs[r].IsSet) v |= 1 << r;
                return v;
            }
        }

        // Spalteneingänge X1..X4: number = Spalte 0..3, value = Pegel des GPIO-Ausgangs.
        // Nicht getriebene Leitungen gelten als LOW (so liefert sie auch der GPIO-Port).
        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number >= Size) return;
            lock(sync)
            {
                column[number] = value;
            }
            Update();
        }

        public void SetKey(int row, int column, bool pressed)
        {
            if(row < 0 || row >= Size || column < 0 || column >= Size)
            {
                throw new ArgumentException(string.Format("Taste ({0},{1}) existiert nicht", row, column));
            }
            lock(sync)
            {
                this.Log(LogLevel.Debug, "HexKeypad: Zeile Y{0}, Spalte X{1} {2}", row + 1, column + 1, pressed ? "gedrückt" : "losgelassen");
                pressedKeys[row, column] = pressed;
            }
            Update();
        }

        public void ReleaseAll()
        {
            lock(sync)
            {
                pressedKeys = new bool[Size, Size];
            }
            Update();
        }

        public void Reset()
        {
            lock(sync)
            {
                column = new bool[Size];
                pressedKeys = new bool[Size, Size];
                riseSince = new double[] { -1, -1, -1, -1 };
            }
            foreach(var y in outputs) y.Set(true); // Pull-up
        }

        // Soll-Pegel der Zeile r ohne Verzögerung
        private bool Target(int r)
        {
            for(int c = 0; c < Size; c++)
            {
                if(pressedKeys[r, c] && !column[c]) return false;
            }
            return true;
        }

        // GPIOs nie setzen, solange "sync" gesperrt ist (Monitor- und Simulationsthread)
        private void Update()
        {
            var falls = new bool[Size];
            bool schedule = false;
            double now = NowUs();
            lock(sync)
            {
                for(int r = 0; r < Size; r++)
                {
                    bool target = Target(r);
                    bool level = outputs[r].IsSet;
                    if(!target)
                    {
                        riseSince[r] = -1;           // stark nach LOW gezogen: sofort
                        if(level) falls[r] = true;
                    }
                    else if(!level)
                    {
                        if(riseSince[r] < 0)         // Pull-up beginnt jetzt umzuladen
                        {
                            riseSince[r] = now;
                            schedule = true;
                        }
                    }
                    else
                    {
                        riseSince[r] = -1;
                    }
                }
            }
            for(int r = 0; r < Size; r++)
            {
                if(falls[r]) outputs[r].Set(false);
            }
            if(schedule) ScheduleSettle(RiseTimeUs);
        }

        private void ScheduleSettle(double delayUs)
        {
            if(delayUs < 0.5)
            {
                Settle();
                return;
            }
            machine.ScheduleAction(TimeInterval.FromMicroseconds((ulong)Math.Ceiling(delayUs)), _ => Settle(), "HexKeypad rise");
        }

        // Zeilen, deren Anstiegszeit abgelaufen ist, auf HIGH setzen
        private void Settle()
        {
            var rises = new bool[Size];
            double rise = RiseTimeUs;
            double now = NowUs();
            double nextDelay = -1;
            lock(sync)
            {
                for(int r = 0; r < Size; r++)
                {
                    if(riseSince[r] < 0) continue;
                    if(!Target(r))
                    {
                        riseSince[r] = -1;
                        continue;
                    }
                    double left = riseSince[r] + rise - now;
                    if(left <= 0.5)
                    {
                        rises[r] = true;
                        riseSince[r] = -1;
                    }
                    else if(nextDelay < 0 || left < nextDelay)
                    {
                        nextDelay = left;
                    }
                }
            }
            for(int r = 0; r < Size; r++) if(rises[r]) outputs[r].Set(true);
            if(nextDelay >= 0) ScheduleSettle(Math.Max(1, nextDelay));
        }

        private double NowUs()
        {
            return machine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds;
        }

        private const int Size = 4;
        private readonly object sync = new object();
        private readonly IMachine machine;
        private readonly GPIO[] outputs;
        private bool[] column;
        private bool[,] pressedKeys;
        private double[] riseSince;
    }
}
