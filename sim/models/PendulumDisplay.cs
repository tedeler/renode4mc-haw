// Pendeldisplay (POV, "persistence of vision"): 8 LEDs auf einem schwingenden Pendel.
//
// Aufbau (stehendes Pendel wie ein Metronom: Drehpunkt UNTEN, Spitze oben):
//   * 8 LED-Eingänge (0..7) kommen von GPIO-AUSGÄNGEN des Mikrocontrollers:
//       gpioM:  0 -> pendel@0  ...  7 -> pendel@7
//     LED 0 sitzt an der Pendelspitze (oben), LED 7 am nächsten zum Drehpunkt (unten).
//     So ist Bit 0 eines Bildbytes die oberste Bildzeile, wie beim OLED-Zeichensatz.
//   * Ausgang Sync geht auf einen GPIO-EINGANG (z.B.  Sync -> gpioL@0):
//       HIGH, solange das Pendel RECHTS von der Mitte steht, LOW, solange es LINKS steht.
//       Steigende Flanke = Pendel läuft nach rechts durch die Mitte,
//       fallende Flanke  = Pendel läuft nach links durch die Mitte.
//     Mit  syncMode: "direction"  (HAW-Pendel, Lab 2/3 des Mikrocontroller-Praktikums) gilt stattdessen:
//       HIGH, solange das Pendel von links nach rechts schwingt, LOW von rechts nach links.
//       Steigende Flanke = linker Umkehrpunkt, fallende Flanke = rechter Umkehrpunkt.
//       Frequenzwechsel gelten dann ab dem nächsten Umkehrpunkt (dort steht das Pendel still).
//   * Bewegung: Auslenkung u = sin(pi * phi), u = -1 (ganz links) .. +1 (ganz rechts).
//     phi zählt die halben Schwingungen: phi = 0, 1, 2, ... sind die Durchgänge durch die Mitte.
//     Eine halbe Schwingung dauert PeriodUs / 2 (Standard: Periode 100000 us = 10 Hz).
//     Das Pendel ist in der Mitte am schnellsten und an den Umkehrpunkten am langsamsten.
//
// Frequenz zur Laufzeit ändern:
//   sysbus.gpioM.pendel PeriodUs 80000      (Periode in us, 10000..20000000 = 100 Hz .. 0,05 Hz)
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
//   sysbus.gpioM.pendel GetFrame            -> "PD:<columns>:<periodUs>:<phase>:<leds>:<Base64>"
//       phase  = aktuelle Phase in 1/10000 halber Schwingungen, 0..19999 (0 = Mitte, nach rechts;
//                5000 = ganz rechts; 10000 = Mitte, nach links; 15000 = ganz links)
//       leds   = aktueller LED-Zustand (Bit n = LED n)
//       Base64 = Nachleuchtbild: alle Bytes links->rechts, dann rechts->links (Bit n = LED n)
//   sysbus.gpioM.pendel GetFrameIfChanged   -> wie oben oder "PD:SAME"
//   sysbus.gpioM.pendel GetEvents           -> "EV:<t>:<phi>:<leds>:<periodUs>:<Ereignisse>"
//       Jetzt-Zustand und alle LED-Wechsel seit dem letzten Aufruf (danach geleert), für die
//       zeitgenaue Wiedergabe im Browser (Stab, LEDs, Leuchtspur):
//       t = virtuelle Zeit in us seit Start, phi = Phase in 1/10000 halber Schwingungen (absolut,
//       nicht modulo), Ereignisse = "t,phi,leds,periodUs;" je LED-Wechsel bzw. Frequenzwechsel
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
        public const uint MaxPeriodUs = 20000000;  // 0,05 Hz

        // syncMode: "position" (Standard, HIGH = rechts von der Mitte) oder "direction" (siehe oben)
        public PendulumDisplay(IMachine machine, uint periodUs = 100000, int columns = 120, string syncMode = "position")
        {
            if(columns < 8 || columns > 512)
            {
                throw new ArgumentException("PendulumDisplay: 8..512 Spalten");
            }
            if(syncMode != "position" && syncMode != "direction")
            {
                throw new ArgumentException("PendulumDisplay: syncMode muss \"position\" oder \"direction\" sein");
            }
            this.machine = machine;
            directionSync = syncMode == "direction";
            // Zeitpunkte des Sync-Wechsels: Nulldurchgänge (phi = 0, 1, 2, ...) bzw. Umkehrpunkte (phi = 0,5; 1,5; ...)
            phaseOffset = directionSync ? 0.5 : 0.0;
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
                Record();
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
                if(version == lastReported && Phase() == lastReportedPhase)
                {
                    return "PD:SAME";
                }
                lastReported = version;
                return Encode();
            }
        }

        public void Reset()
        {
            // Timer nie anfassen, während "sync" gesperrt ist (siehe OnZeroCrossing)
            halfPeriod.Enabled = false;
            halfPeriod.Value = 0;
            halfPeriod.Limit = initialHalfUs;
            lock(sync)
            {
                halfUs = initialHalfUs;
                pendingHalfUs = 0;
                halfCount = 0;
                anchorUs = ClockUs();
                anchorPhase = phaseOffset;
                events.Clear();
                leds = 0;
                lastPaintPhase = phaseOffset;
                Array.Clear(image, 0, image.Length);
                version++;
            }
            // phi = 0: Pendel in der Mitte, läuft nach rechts (HIGH = rechts);
            // direction: phi = 0,5: rechter Umkehrpunkt, läuft jetzt nach links (LOW)
            Sync.Set(!directionSync);
            halfPeriod.Enabled = true;
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

        // Wird vom Timer im Simulationsthread aufgerufen, während der Timer intern gesperrt ist.
        // Deshalb gilt im ganzen Modell: Solange "sync" gesperrt ist, wird der Timer NICHT benutzt
        // (kein halfPeriod.Value usw.) und kein GPIO gesetzt - sonst können sich Monitor-Abfrage
        // und Simulation gegenseitig blockieren (Deadlock, Renode bleibt stehen).
        private void OnZeroCrossing()
        {
            uint newHalfUs = 0;
            bool level;
            lock(sync)
            {
                // Zeitpunkt des Durchgangs exakt aus der Phase (nicht von der Uhr lesen)
                double crossingPhase = phaseOffset + halfCount + 1;
                double crossingUs = anchorUs + (crossingPhase - anchorPhase) * halfUs;
                PaintUntil(crossingPhase); // bis genau zum Durchgang (alte Periode)
                halfCount++;
                if(pendingHalfUs != 0)
                {
                    anchorUs = crossingUs;
                    anchorPhase = crossingPhase;
                    halfUs = pendingHalfUs;
                    newHalfUs = pendingHalfUs;
                    pendingHalfUs = 0;
                    version++; // Periode ist Teil des Frames
                    Record(crossingUs);  // Frequenzwechsel: neue Geschwindigkeit ab hier
                }
                level = (halfCount % 2 == 0) != directionSync;
            }
            if(newHalfUs != 0)
            {
                halfPeriod.Value = 0;
                halfPeriod.Limit = newHalfUs;
            }
            Sync.Set(level);
        }

        public string GetEvents()
        {
            lock(sync)
            {
                var sb = new System.Text.StringBuilder();
                double now = ClockUs();
                sb.Append("EV:").Append((long)Math.Round(now)).Append(':').Append((long)Math.Round(PhaseAt(now) * 10000))
                  .Append(':').Append(leds).Append(':').Append(2 * halfUs).Append(':');
                foreach(var e in events)
                {
                    sb.Append(e.Us).Append(',').Append(e.PhaseQ).Append(',').Append(e.Leds).Append(',').Append(e.PeriodUs).Append(';');
                }
                events.Clear();
                return sb.ToString();
            }
        }

        private struct Event
        {
            public long Us;
            public long PhaseQ;
            public byte Leds;
            public uint PeriodUs;
        }

        // Merkt sich den aktuellen Zustand als Ereignis (gleicher Zeitpunkt: überschreiben, denn
        // ein Byte-Schreibzugriff auf Port M kommt als 8 einzelne Pin-Wechsel an)
        private void Record()
        {
            Record(ClockUs());
        }

        private void Record(double us)
        {
            var e = new Event { Us = (long)Math.Round(us), PhaseQ = (long)Math.Round(PhaseAt(us) * 10000), Leds = leds, PeriodUs = 2 * halfUs };
            if(events.Count > 0 && events[events.Count - 1].Us == e.Us)
            {
                events[events.Count - 1] = e;
                return;
            }
            if(events.Count >= MaxEvents)
            {
                events.RemoveRange(0, MaxEvents / 4); // niemand holt ab: Älteste verwerfen
            }
            events.Add(e);
        }

        // Virtuelle Zeit in us (Uhr der Maschine; braucht keine Sperre des Timers)
        private double ClockUs()
        {
            return machine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds;
        }

        // phi zur virtuellen Zeit us: Anzahl halber Schwingungen seit dem Start (stetig, auch über
        // Frequenzwechsel). Ab dem letzten Frequenzwechsel (anchor) läuft phi mit 1/halfUs.
        private double PhaseAt(double us)
        {
            return anchorPhase + Math.Max(0, us - anchorUs) / halfUs;
        }

        private double Phase()
        {
            return PhaseAt(ClockUs());
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
            double phase = Phase();
            lastReportedPhase = phase;
            int phaseQ = (int)Math.Floor((phase % 2.0) * 10000) % 20000;
            var bytes = new byte[2 * Columns];
            for(int d = 0; d < 2; d++)
            {
                for(int c = 0; c < Columns; c++)
                {
                    bytes[d * Columns + c] = image[d, c];
                }
            }
            return "PD:" + Columns + ":" + (2 * halfUs) + ":" + phaseQ + ":" + leds + ":" + Convert.ToBase64String(bytes);
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
        private double lastReportedPhase = -1;
        private readonly IMachine machine;
        private readonly bool directionSync;
        private readonly double phaseOffset;
        private double anchorUs;
        private double anchorPhase;
        private const int MaxEvents = 20000;
        private readonly System.Collections.Generic.List<Event> events = new System.Collections.Generic.List<Event>();
    }
}
