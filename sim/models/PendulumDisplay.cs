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
//   * Bewegung: Auslenkung u = sin(pi * phi), u = -1 (ganz links) .. +1 (ganz rechts).
//     phi zählt die halben Schwingungen: phi = 0, 1, 2, ... sind die Durchgänge durch die Mitte.
//     Eine halbe Schwingung dauert PeriodUs / 2 (Standard: Periode 100000 us = 10 Hz).
//     Das Pendel ist in der Mitte am schnellsten und an den Umkehrpunkten am langsamsten.
//
// Frequenz zur Laufzeit ändern:
//   sysbus.gpioM.pendel PeriodUs 80000      (Periode in us, 10000..1000000 = 100 Hz .. 1 Hz)
//   Die neue Periode gilt ab dem nächsten Durchgang durch die Mitte. Dort ist die Auslenkung bei
//   jeder Frequenz null, das Pendel läuft also ohne Sprung weiter.
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
//   sysbus.gpioM.pendel GetFrame            -> "PD:<columns>:<periodUs>:<Base64>"  (alle Bytes
//                                               links->rechts, dann rechts->links; Bit n = LED n)
//   sysbus.gpioM.pendel GetFrameIfChanged   -> wie oben oder "PD:SAME"
//   sysbus.gpioM.pendel SyncLevel           -> aktueller Pegel des Sync-Ausgangs
//   sysbus.gpioM.pendel Leds                -> aktueller LED-Zustand (Bit n = LED n)
//   sysbus.gpioM.pendel PeriodUs            -> aktuelle Periode in us (setzen: siehe oben)
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class PendulumDisplay : IGPIOReceiver
    {
        public const uint MinPeriodUs = 10000;     // 100 Hz
        public const uint MaxPeriodUs = 1000000;   // 1 Hz

        public PendulumDisplay(IMachine machine, uint periodUs = 100000, int columns = 120)
        {
            if(columns < 8 || columns > 512)
            {
                throw new ArgumentException("PendulumDisplay: 8..512 Spalten");
            }
            initialHalfUs = HalfOf(periodUs);
            Columns = columns;
            Sync = new GPIO();
            image = new byte[2, columns];

            // Zeitbasis 1 MHz; Ereignis bei jedem Durchgang durch die Mitte (alle T/2) schaltet Sync um
            halfPeriod = new LimitTimer(machine.ClockSource, 1000000, this, "halfPeriod", initialHalfUs,
                Direction.Ascending, enabled: false, workMode: WorkMode.Periodic, eventEnabled: true);
            halfPeriod.LimitReached += OnZeroCrossing;
            Reset();
        }

        public int Columns { get; private set; }

        // Periode in us. Setzen wirkt ab dem nächsten Durchgang durch die Mitte.
        public uint PeriodUs
        {
            get { lock(sync) { return 2 * (pendingHalfUs != 0 ? pendingHalfUs : halfUs); } }
            set
            {
                lock(sync)
                {
                    pendingHalfUs = HalfOf(value);
                    this.Log(LogLevel.Info, "Pendel: neue Periode {0} us ({1:F2} Hz) ab dem nächsten Nulldurchgang",
                        2 * pendingHalfUs, 1e6 / (2 * pendingHalfUs));
                }
            }
        }

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
                PaintUntil(Phase());
                leds = next;
            }
        }

        public string GetFrame()
        {
            lock(sync)
            {
                PaintUntil(Phase());
                lastReported = version;
                return Encode();
            }
        }

        public string GetFrameIfChanged()
        {
            lock(sync)
            {
                PaintUntil(Phase());
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
                halfUs = initialHalfUs;
                pendingHalfUs = 0;
                halfPeriod.Value = 0;
                halfPeriod.Limit = halfUs;
                halfCount = 0;
                leds = 0;
                lastPaintPhase = 0;
                Array.Clear(image, 0, image.Length);
                version++;
                Sync.Set(true); // phi = 0: Pendel in der Mitte, läuft nach rechts
                halfPeriod.Enabled = true;
            }
        }

        private static uint HalfOf(uint periodUs)
        {
            if(periodUs < MinPeriodUs || periodUs > MaxPeriodUs)
            {
                throw new ArgumentException(string.Format(
                    "PendulumDisplay: Periode {0} us außerhalb {1}..{2} us", periodUs, MinPeriodUs, MaxPeriodUs));
            }
            return periodUs / 2;
        }

        private void OnZeroCrossing()
        {
            lock(sync)
            {
                PaintUntil(halfCount + 1.0); // bis genau zum Durchgang (alte Periode)
                halfCount++;
                if(pendingHalfUs != 0)
                {
                    halfUs = pendingHalfUs;
                    pendingHalfUs = 0;
                    halfPeriod.Value = 0;
                    halfPeriod.Limit = halfUs;
                    version++; // Periode ist Teil des Frames
                }
                Sync.Set(halfCount % 2 == 0);
            }
        }

        // phi: Anzahl halber Schwingungen seit dem Start (stetig, auch über Frequenzwechsel)
        private double Phase()
        {
            double frac = Math.Min(1.0, halfPeriod.Value / (double)halfUs);
            return halfCount + frac;
        }

        // Überträgt den LED-Zustand des Phasenbereichs [lastPaintPhase, until] auf das Bild
        private void PaintUntil(double until)
        {
            double from = lastPaintPhase;
            if(until <= from) return;
            lastPaintPhase = until;
            if(until - from > 2)
            {
                from = until - 2; // eine volle Periode überstreicht schon alles
            }

            // An den Umkehrpunkten (phi = k + 1/2) in gleichsinnige Stücke teilen
            double a = from;
            while(a < until)
            {
                double nextTurn = Math.Floor(a - 0.5) + 1.5;
                double b = Math.Min(until, nextTurn);
                PaintPiece(a, b);
                a = b;
            }
        }

        private void PaintPiece(double a, double b)
        {
            int dir = Math.Cos(Math.PI * (a + b) / 2) >= 0 ? 0 : 1; // 0 = links->rechts, 1 = rechts->links
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

        private int ColumnAt(double phase)
        {
            double u = Math.Sin(Math.PI * phase);
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
            return string.Format("PD:{0}:{1}:{2}", Columns, 2 * halfUs, Convert.ToBase64String(bytes));
        }

        private readonly object sync = new object();
        private readonly LimitTimer halfPeriod;
        private readonly byte[,] image;
        private readonly uint initialHalfUs;
        private uint halfUs;
        private uint pendingHalfUs;
        private ulong halfCount;
        private byte leds;
        private double lastPaintPhase;
        private ulong version;
        private ulong lastReported = ulong.MaxValue;
    }
}
