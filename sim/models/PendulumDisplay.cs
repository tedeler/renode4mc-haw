// Pendeldisplay (POV, "persistence of vision"): 8 LEDs auf einem schwingenden Pendel.
//
// Aufbau:
//   * 8 LED-Eingänge (0..7) kommen von GPIO-AUSGÄNGEN des Mikrocontrollers:
//       gpioM:  0 -> pendel@0  ...  7 -> pendel@7
//     LED 0 sitzt am Drehpunkt, LED 7 an der Pendelspitze.
//   * Ausgang Sync geht auf einen GPIO-EINGANG (z.B.  Sync -> gpioL@0):
//       HIGH, solange das Pendel RECHTS von der Mitte steht, LOW, solange es LINKS steht.
//       Steigende Flanke = Pendel läuft nach rechts durch die Mitte,
//       fallende Flanke  = Pendel läuft nach links durch die Mitte.
//   * Bewegung: Auslenkung u(t) = sin(2*pi*t/T), u = -1 (ganz links) .. +1 (ganz rechts).
//     T = periodUs (Standard 100000 us = 10 Schwingungen pro Sekunde). Das Pendel ist in der
//     Mitte am schnellsten und an den Umkehrpunkten am langsamsten.
//
// Anzeige ("Nachleuchten"):
//   Der Schwenkbereich ist in "columns" gleich breite Winkelstücke geteilt. Für jede
//   Schwungrichtung (links->rechts, rechts->links) merkt sich das Modell, welche LEDs beim
//   letzten Überstreichen eines Winkelstücks an waren. Das Auge sieht beide Schwünge
//   überlagert: Zeichnet die Firmware nur in einer Richtung, erscheint das Bild halb so hell.
//   Alle Zeiten sind virtuelle Simulationszeit, die Anzeige ist also unabhängig davon,
//   wie schnell der Rechner die Simulation ausführt.
//
// Bedienung im Renode-Monitor:
//   sysbus.gpioM.pendel GetFrame            -> "PD:<columns>:<Base64>"  (alle Bytes links->rechts,
//                                               dann alle Bytes rechts->links; Bit n = LED n)
//   sysbus.gpioM.pendel GetFrameIfChanged   -> wie oben oder "PD:SAME"
//   sysbus.gpioM.pendel SyncLevel           -> aktueller Pegel des Sync-Ausgangs
//   sysbus.gpioM.pendel Leds                -> aktueller LED-Zustand (Bit n = LED n)
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class PendulumDisplay : IGPIOReceiver
    {
        public PendulumDisplay(IMachine machine, uint periodUs = 100000, int columns = 120)
        {
            if(periodUs < 1000 || periodUs % 2 != 0)
            {
                throw new ArgumentException("PendulumDisplay: periodUs muss gerade und >= 1000 sein");
            }
            if(columns < 8 || columns > 512)
            {
                throw new ArgumentException("PendulumDisplay: 8..512 Spalten");
            }
            PeriodUs = periodUs;
            Columns = columns;
            Sync = new GPIO();
            image = new byte[2, columns];

            // Zeitbasis 1 MHz; Ereignis bei jedem Nulldurchgang (alle T/2) schaltet Sync um
            halfPeriod = new LimitTimer(machine.ClockSource, 1000000, this, "halfPeriod", periodUs / 2,
                Direction.Ascending, enabled: false, workMode: WorkMode.Periodic, eventEnabled: true);
            halfPeriod.LimitReached += OnZeroCrossing;
            Reset();
        }

        public uint PeriodUs { get; private set; }
        public int Columns { get; private set; }

        // HIGH = Pendel rechts von der Mitte
        public GPIO Sync { get; private set; }

        public bool SyncLevel { get { return Sync.IsSet; } }

        public byte Leds { get { lock(sync) { return leds; } } }

        // LED-Eingänge: number = LED 0..7, value = Pegel des GPIO-Ausgangs
        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 7) return;
            lock(sync)
            {
                byte next = value ? (byte)(leds | (1 << number)) : (byte)(leds & ~(1 << number));
                if(next == leds) return;
                PaintUntil(NowUs());
                leds = next;
            }
        }

        public string GetFrame()
        {
            lock(sync)
            {
                PaintUntil(NowUs());
                lastReported = version;
                return Encode();
            }
        }

        public string GetFrameIfChanged()
        {
            lock(sync)
            {
                PaintUntil(NowUs());
                if(version == lastReported)
                {
                    return "PD:SAME";
                }
                lastReported = version;
                return Encode();
            }
        }

        public void Reset()
        {
            lock(sync)
            {
                halfPeriod.Enabled = false;
                halfPeriod.Value = 0;
                halfCount = 0;
                leds = 0;
                lastPaintUs = 0;
                Array.Clear(image, 0, image.Length);
                version++;
                Sync.Set(true); // t = 0: Pendel in der Mitte, läuft nach rechts
                halfPeriod.Enabled = true;
            }
        }

        private void OnZeroCrossing()
        {
            lock(sync)
            {
                halfCount++;
                PaintUntil(NowUs());
                Sync.Set(halfCount % 2 == 0);
            }
        }

        // Virtuelle Zeit in us seit Start (Nulldurchgänge * T/2 + Stand innerhalb der Halbperiode)
        private double NowUs()
        {
            return halfCount * (double)(PeriodUs / 2) + halfPeriod.Value;
        }

        // Überträgt den LED-Zustand des Zeitraums [lastPaintUs, until] auf das Bild
        private void PaintUntil(double until)
        {
            double from = lastPaintUs;
            if(until <= from) return;
            lastPaintUs = until;
            if(until - from > PeriodUs)
            {
                from = until - PeriodUs; // eine volle Periode überstreicht schon alles
            }

            // An den Umkehrpunkten (T/4 + k*T/2) in gleichsinnige Stücke teilen
            double quarter = PeriodUs / 4.0;
            double half = PeriodUs / 2.0;
            double a = from;
            while(a < until)
            {
                double nextTurn = quarter + Math.Floor((a - quarter) / half + 1) * half;
                double b = Math.Min(until, nextTurn);
                PaintPiece(a, b);
                a = b;
            }
        }

        private void PaintPiece(double a, double b)
        {
            double phaseMid = 2 * Math.PI * ((a + b) / 2) / PeriodUs;
            int dir = Math.Cos(phaseMid) >= 0 ? 0 : 1; // 0 = links->rechts, 1 = rechts->links
            int ca = ColumnAt(a);
            int cb = ColumnAt(b);
            int lo = Math.Min(ca, cb), hi = Math.Max(ca, cb);
            bool changed = false;
            for(int c = lo; c <= hi; c++)
            {
                if(image[dir, c] != leds)
                {
                    image[dir, c] = leds;
                    changed = true;
                }
            }
            if(changed) version++;
        }

        private int ColumnAt(double tUs)
        {
            double u = Math.Sin(2 * Math.PI * tUs / PeriodUs);
            int c = (int)Math.Floor((u + 1) / 2 * Columns);
            return Math.Max(0, Math.Min(Columns - 1, c));
        }

        private string Encode()
        {
            var bytes = new byte[2 * Columns];
            for(int d = 0; d < 2; d++)
            {
                for(int c = 0; c < Columns; c++)
                {
                    bytes[d * Columns + c] = image[d, c];
                }
            }
            return string.Format("PD:{0}:{1}", Columns, Convert.ToBase64String(bytes));
        }

        private readonly object sync = new object();
        private readonly LimitTimer halfPeriod;
        private readonly byte[,] image;
        private ulong halfCount;
        private byte leds;
        private double lastPaintUs;
        private ulong version;
        private ulong lastReported = ulong.MaxValue;
    }
}
