// Oszilloskop für die Web-Konsole: zeichnet die Pegelwechsel ausgewählter Pins mit virtueller Zeit auf.
//
// Gemessen wird, was ein Tastkopf am Pin sehen würde (TivaGPIOPort.PadLevel): getriebener Ausgang,
// von außen getriebener Eingang (Taster, Sensor, Pendel-Sync, ...), Pull-up/Pull-down oder offen.
// Pins mit alternativer Funktion liefert das Peripheriemodell (UART: Bitstrom mit Baudrate und Format).
// Alle Signale sind 3,3-V-Logik: 0 = LOW (0 V), 1 = HIGH (3,3 V), 2 = offen (hochohmig).
// Aufgezeichnet werden nur die angeforderten Pins (die Web-Konsole meldet die Quellen aller Browser).
//
// Bedienung im Renode-Monitor:
//   sysbus.scope Probe "PD0,PD1,PL0"   diese Pins aufzeichnen (höchstens 16, "" = keine)
//   sysbus.scope Probes                aktuell aufgezeichnete Pins
//   sysbus.scope GetEvents             -> "SC:<jetzt ns>:<Pin>,...:<Pegel>,...:<i>,<dt ns>,<Pegel>;...:<verworfen>"
//       Jetzt-Zeit (virtuell, ns seit Start), aufgezeichnete Pins, ihr aktueller Pegel und alle Wechsel seit
//       dem letzten Aufruf (danach geleert): i = Nummer des Pins in der Liste, dt = Zeit seit dem vorigen
//       Wechsel der Liste (beim ersten: seit Start). Zeitauflösung 1 us (Renode). Wechsel mit Zeitpunkt in der Zukunft (UART-Rahmen) kommen erst, wenn die
//       Simulation dort angekommen ist. verworfen = Anzahl Wechsel, die wegen vollem Puffer fehlen.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.GPIOPort;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class Oscilloscope : IDoubleWordPeripheral, IKnownSize
    {
        public const int MaxProbes = 16;
        public const int MaxEvents = 10000;   // je Abruf (100 ms): darüber werden die ältesten verworfen

        public Oscilloscope(IMachine machine)
        {
            this.machine = machine;
        }

        public long Size { get { return 0x100; } }

        public uint ReadDoubleWord(long offset) { return 0; }

        public void WriteDoubleWord(long offset, uint value) { }

        public void Reset()
        {
            lock(sync)
            {
                events.Clear();
                pending.Clear();
                dropped = 0;
            }
        }

        public string Probes { get { lock(sync) { return string.Join(",", probes.Keys); } } }

        // Pins wie "PD0" (Port A..Q, Pin 0..7), durch Komma getrennt
        public void Probe(string pins)
        {
            Attach();
            var wanted = new List<string>();
            foreach(var raw in (pins ?? "").Split(new[] { ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string name = raw.Trim().ToUpperInvariant();
                TivaGPIOPort port;
                int pin;
                if(!Parse(name, out port, out pin))
                {
                    throw new ArgumentException("Oscilloscope: unbekannter Pin " + raw);
                }
                if(!wanted.Contains(name)) wanted.Add(name);
            }
            if(wanted.Count > MaxProbes)
            {
                throw new ArgumentException("Oscilloscope: höchstens " + MaxProbes + " Pins");
            }
            lock(sync)
            {
                foreach(var name in probes.Keys.Where(k => !wanted.Contains(k)).ToList())
                {
                    probes.Remove(name);
                    events.RemoveAll(e => e.Pin == name);
                    pending.RemoveAll(e => e.Pin == name);
                }
                foreach(var name in wanted)
                {
                    if(probes.ContainsKey(name)) continue;
                    TivaGPIOPort port;
                    int pin;
                    Parse(name, out port, out pin);
                    probes[name] = new ProbeState { Port = port, Pin = pin, Level = port.PadLevel(pin) };
                }
                UpdateSubscriptions();
            }
        }

        public string GetEvents()
        {
            lock(sync)
            {
                long now = NowNs();
                // fällige Ereignisse aus der Zukunft übernehmen
                var sorted = pending.OrderBy(x => x.Ns).ToList();
                pending.Clear();
                pending.AddRange(sorted);
                int due = 0;
                while(due < pending.Count && pending[due].Ns <= now) due++;
                if(due > 0)
                {
                    var list = pending.GetRange(0, due);
                    pending.RemoveRange(0, due);
                    foreach(var e in list) Add(e);  // sortiert: letzter Pegel gewinnt
                }
                var names = probes.Keys.ToList();
                var sb = new StringBuilder("SC:");
                sb.Append(now).Append(':').Append(string.Join(",", names)).Append(':');
                sb.Append(string.Join(",", names.Select(n => probes[n].Level.ToString()))).Append(':');
                long last = 0;
                foreach(var e in events.OrderBy(x => x.Ns))   // stabil: gleiche Zeit in Reihenfolge
                {
                    sb.Append(names.IndexOf(e.Pin)).Append(',').Append(e.Ns - last).Append(',').Append(e.Level).Append(';');
                    last = e.Ns;
                }
                sb.Append(':').Append(dropped);
                events.Clear();
                dropped = 0;
                return sb.ToString();
            }
        }

        private struct Event
        {
            public string Pin;
            public long Ns;
            public int Level;
        }

        private class ProbeState
        {
            public TivaGPIOPort Port;
            public int Pin;
            public int Level;     // Pegel jetzt (letzter fällige Wechsel)
        }

        private void OnPad(TivaGPIOPort port, int pin, double us, int level)
        {
            string name = "P" + port.PortName + pin;
            lock(sync)
            {
                ProbeState p;
                if(!probes.TryGetValue(name, out p)) return;
                long ns = (long)Math.Round(us * 1000);
                var e = new Event { Pin = name, Ns = ns, Level = level };
                if(ns > NowNs()) pending.Add(e);
                else Add(e);
            }
        }

        private void Add(Event e)
        {
            if(events.Count >= MaxEvents)
            {
                int n = MaxEvents / 4;
                events.RemoveRange(0, n); // niemand holt ab: Älteste verwerfen
                dropped += n;
            }
            events.Add(e);
            ProbeState p;
            if(probes.TryGetValue(e.Pin, out p)) p.Level = e.Level;
        }

        private long NowNs()
        {
            return (long)Math.Round(machine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds * 1000);
        }

        private bool Parse(string name, out TivaGPIOPort port, out int pin)
        {
            port = null;
            pin = -1;
            if(name.Length != 3 || name[0] != 'P' || name[2] < '0' || name[2] > '7') return false;
            pin = name[2] - '0';
            return ports.TryGetValue(name[1].ToString(), out port);
        }

        // GPIO-Ports der Maschine suchen (einmalig)
        private void Attach()
        {
            if(attached) return;
            attached = true;
            foreach(var port in machine.GetPeripheralsOfType<TivaGPIOPort>())
            {
                ports[port.PortName] = port;
            }
            this.Log(LogLevel.Debug, "Oszilloskop: {0} GPIO-Ports", ports.Count);
        }

        // Nur bei Ports mit Tastkopf angemeldet sein (die anderen führen dann keine Pegel nach)
        private void UpdateSubscriptions()
        {
            var needed = new HashSet<TivaGPIOPort>(probes.Values.Select(p => p.Port));
            foreach(var port in handlers.Keys.Where(p => !needed.Contains(p)).ToList())
            {
                port.PadChanged -= handlers[port];
                handlers.Remove(port);
            }
            foreach(var port in needed.Where(p => !handlers.ContainsKey(p)))
            {
                var p = port;
                Action<int, double, int> h = (pin, us, level) => OnPad(p, pin, us, level);
                handlers[p] = h;
                p.PadChanged += h;
            }
        }

        private readonly IMachine machine;
        private readonly object sync = new object();
        private readonly Dictionary<string, TivaGPIOPort> ports = new Dictionary<string, TivaGPIOPort>();
        private readonly Dictionary<string, ProbeState> probes = new Dictionary<string, ProbeState>();
        private readonly List<Event> events = new List<Event>();
        private readonly List<Event> pending = new List<Event>();
        private readonly Dictionary<TivaGPIOPort, Action<int, double, int>> handlers = new Dictionary<TivaGPIOPort, Action<int, double, int>>();
        private long dropped;
        private bool attached;
    }
}
