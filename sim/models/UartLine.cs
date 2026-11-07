// Gemeinsame Bausteine für eine UART-Leitung als Folge von Flanken (Signalwechseln).
//
// Statt Bytes übertragen die Modelle Pegelwechsel mit exaktem Zeitstempel in Nanosekunden
// virtueller Zeit. Der Sender rechnet die Flankenzeiten aus seiner Baudrate aus, der Empfänger
// dekodiert sie mit SEINER erwarteten Baudrate und seinem Format – wie zwei echte UARTs.
// Passt die Konfiguration nicht zusammen, entstehen falsche Zeichen und Framing-Fehler.
//
//   UartFrameFormat   Format (Datenbits, Parität, Stoppbits) und Bitdauer in ns
//   UartEncoder       Byte -> Flanken eines Frames
//   UartLineDecoder   Flanken -> Zeichen (Bitmitte ab der fallenden Flanke des Startbits)
//   SignalRecorder    Flankenpuffer für die Anzeige (Oszilloskop), Abholung mit Format()
//   IUartLineEndpoint Schnittstelle zwischen TivaUART und UartHostTerminal
//
// Muss vor TivaUART.cs und UartHostTerminal.cs geladen werden (include in tm4c1294.resc).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals;

namespace Antmicro.Renode.Peripherals.UART
{
    public struct SignalEdge
    {
        public SignalEdge(ulong ns, bool level)
        {
            Ns = ns;
            Level = level;
        }

        public ulong Ns;      // virtuelle Zeit in ns seit Simulationsstart
        public bool Level;    // Pegel NACH der Flanke
    }

    public enum UartParity { None, Odd, Even, Mark, Space }

    public enum UartErrors { None = 0, Framing = 1, Parity = 2, Break = 4 }

    // Ein Ende einer UART-Leitung (MCU-UART oder PC-Terminal)
    public interface IUartLineEndpoint : IPeripheral
    {
        // Gegenstelle wurde angeschlossen
        void AttachLine(IUartLineEndpoint partner);

        // Die Gegenstelle legt Flanken auf die Leitung, die zu DIESEM Endpunkt führt (aufsteigende
        // Zeiten, nur Pegelwechsel; Zeiten dürfen in der Zukunft liegen – der Sender kennt den
        // ganzen Frame schon beim Schreiben ins Datenregister).
        void LineEdges(IList<SignalEdge> edges);

        // Bis zu dieser Zeit (ns) hat der Endpunkt seine Empfangsleitung schon ausgewertet.
        // Ein Sender darf keinen Frame beginnen, der davor liegt.
        ulong DecodedUntilNs { get; }

        // Die Gegenstelle wurde zur Zeit ns zurückgesetzt: Flanken danach gelten nicht mehr, die
        // Leitung liegt ab ns auf Ruhepegel (HIGH)
        void LineReset(ulong ns);

        // Format, mit dem dieser Endpunkt SENDET (für Anzeige und Meldungen; ungültig = nicht
        // konfiguriert, Baudrate 0)
        UartFrameFormat TransmitFormat { get; }
    }

    public class UartFrameFormat
    {
        public UartFrameFormat(double baud, int dataBits, UartParity parity, int stopBits)
        {
            Baud = baud;
            DataBits = dataBits;
            Parity = parity;
            StopBits = stopBits;
        }

        // "8N1", "7E2", ... (Parität: N, O, E, M, S)
        public static UartFrameFormat Parse(double baud, string format)
        {
            if(format == null || format.Length != 3)
            {
                throw new ArgumentException("Format wie \"8N1\" angeben (Datenbits 5-8, Parität N/O/E/M/S, Stoppbits 1-2)");
            }
            int data = format[0] - '0';
            int stop = format[2] - '0';
            UartParity p;
            switch(char.ToUpperInvariant(format[1]))
            {
                case 'N': p = UartParity.None; break;
                case 'O': p = UartParity.Odd; break;
                case 'E': p = UartParity.Even; break;
                case 'M': p = UartParity.Mark; break;
                case 'S': p = UartParity.Space; break;
                default: throw new ArgumentException("Parität N, O, E, M oder S");
            }
            if(data < 5 || data > 8 || stop < 1 || stop > 2)
            {
                throw new ArgumentException("Datenbits 5-8, Stoppbits 1-2");
            }
            if(!(baud > 0))
            {
                throw new ArgumentException("Baudrate > 0");
            }
            return new UartFrameFormat(baud, data, p, stop);
        }

        public double Baud { get; private set; }
        public int DataBits { get; private set; }
        public UartParity Parity { get; private set; }
        public int StopBits { get; private set; }

        public bool Valid { get { return Baud > 0; } }

        public double BitNs { get { return 1e9 / Baud; } }

        // Bits pro Frame: Start + Daten + Parität + Stopp
        public int FrameBits { get { return 1 + DataBits + (Parity == UartParity.None ? 0 : 1) + StopBits; } }

        public string Name
        {
            get { return string.Format("{0}{1}{2}", DataBits, "NOEMS"[(int)Parity], StopBits); }
        }

        public string Describe()
        {
            return string.Format(CultureInfo.InvariantCulture, "{0:0.#} Baud {1}", Baud, Name);
        }

        public bool ParityBit(int value)
        {
            int ones = 0;
            for(int i = 0; i < DataBits; i++) ones += (value >> i) & 1;
            switch(Parity)
            {
                case UartParity.Even: return (ones & 1) != 0;   // Gesamtzahl der Einsen gerade
                case UartParity.Odd: return (ones & 1) == 0;
                case UartParity.Mark: return true;
                default: return false;                          // Space
            }
        }
    }

    public static class UartEncoder
    {
        // Flanken eines Frames, der zur Zeit startNs beginnt (Leitung vorher im Ruhepegel 1).
        // Jede Flankenzeit wird einzeln gerundet (floor), damit sich keine Fehler aufsummieren.
        // Rückgabe: Ende des Frames (nach dem letzten Stoppbit) als exakte Gleitkommazeit.
        public static double Encode(double startNs, int value, UartFrameFormat f, List<SignalEdge> edges)
        {
            var bits = new List<bool>();
            bits.Add(false);                                   // Startbit
            for(int i = 0; i < f.DataBits; i++) bits.Add(((value >> i) & 1) != 0); // LSB zuerst
            if(f.Parity != UartParity.None) bits.Add(f.ParityBit(value));
            for(int i = 0; i < f.StopBits; i++) bits.Add(true);

            bool level = true;
            double bit = f.BitNs;
            for(int k = 0; k < bits.Count; k++)
            {
                if(bits[k] != level)
                {
                    level = bits[k];
                    edges.Add(new SignalEdge((ulong)Math.Floor(startNs + k * bit), level));
                }
            }
            return startNs + bits.Count * bit;
        }
    }

    // Dekodiert eine Empfangsleitung aus ihren Flanken. Das Format wird beim Startbit jedes
    // Frames neu gelesen (Register können sich zwischen den Frames ändern).
    public class UartLineDecoder
    {
        public UartLineDecoder(Func<UartFrameFormat> format)
        {
            this.format = format;
            Reset();
        }

        public void Reset()
        {
            edges.Clear();
            baseLevel = true;
            resumeNs = 0;
            DecodedUntilNs = 0;
            inFrame = false;
        }

        public ulong DecodedUntilNs { get; private set; }

        // Flanken nach ns verwerfen; ab ns liegt die Leitung auf HIGH (Sender wurde zurückgesetzt)
        public void Truncate(ulong ns)
        {
            int n = edges.Count;
            while(n > 0 && edges[n - 1].Ns > ns) n--;
            edges.RemoveRange(n, edges.Count - n);
            bool last = n > 0 ? edges[n - 1].Level : baseLevel;
            if(!last) edges.Add(new SignalEdge(ns + 1, true));
        }

        public void AddEdges(IList<SignalEdge> list)
        {
            foreach(var e in list)
            {
                if(edges.Count > 0 && e.Ns < edges[edges.Count - 1].Ns)
                {
                    continue; // darf nicht vorkommen (Sender beginnt nie vor DecodedUntilNs)
                }
                edges.Add(e);
            }
        }

        // Wertet alles aus, was bis nowNs feststeht. onFrame(Daten, Fehler, Frame-Beginn, Messpunkt
        // des Stoppbits) wird für jedes fertige Zeichen aufgerufen. Rückgabe: Zeitpunkt (ns), zu dem
        // der nächste Aufruf etwas Neues ergibt, oder null, wenn erst neue Flanken kommen müssen.
        public ulong? Process(ulong nowNs, Action<int, UartErrors, ulong, ulong> onFrame)
        {
            if(nowNs > DecodedUntilNs) DecodedUntilNs = nowNs;
            while(true)
            {
                if(!inFrame)
                {
                    // nächste fallende Flanke (Beginn eines Startbits) ab resumeNs
                    Prune(resumeNs);
                    int i = 0;
                    while(i < edges.Count && edges[i].Level) i++;
                    if(i >= edges.Count)
                    {
                        return null;
                    }
                    frameStart = edges[i].Ns;
                    frameFormat = format();
                    if(frameFormat == null || !frameFormat.Valid)
                    {
                        // Empfänger nicht konfiguriert: Flanke ignorieren
                        resumeNs = frameStart + 1;
                        continue;
                    }
                    inFrame = true;
                }

                double bit = frameFormat.BitNs;
                int dataBits = frameFormat.DataBits;
                bool parity = frameFormat.Parity != UartParity.None;
                int stopIndex = 1 + dataBits + (parity ? 1 : 0);
                double stopSample = frameStart + (stopIndex + 0.5) * bit;
                if(stopSample > nowNs)
                {
                    return (ulong)Math.Ceiling(stopSample);
                }

                inFrame = false;
                if(LevelAt(frameStart + 0.5 * bit))
                {
                    // Startbit in der Bitmitte schon wieder HIGH: Störimpuls, kein Zeichen
                    resumeNs = frameStart + 1;
                    continue;
                }
                int value = 0;
                bool allLow = true;
                for(int b = 0; b < dataBits; b++)
                {
                    if(LevelAt(frameStart + (1 + b + 0.5) * bit))
                    {
                        value |= 1 << b;
                        allLow = false;
                    }
                }
                var errors = UartErrors.None;
                if(parity)
                {
                    bool p = LevelAt(frameStart + (1 + dataBits + 0.5) * bit);
                    if(p) allLow = false;
                    if(p != frameFormat.ParityBit(value)) errors |= UartErrors.Parity;
                }
                bool stop = LevelAt(stopSample);
                if(!stop)
                {
                    errors |= UartErrors.Framing;
                    if(allLow) errors |= UartErrors.Break;
                }
                ulong stopNs = (ulong)Math.Ceiling(stopSample);
                resumeNs = stopNs;
                onFrame(value, errors, frameStart, stopNs);
            }
        }

        // Pegel zur Zeit t: Pegel nach der letzten Flanke mit Zeit <= t
        private bool LevelAt(double t)
        {
            bool level = baseLevel;
            foreach(var e in edges)
            {
                if(e.Ns > t) break;
                level = e.Level;
            }
            return level;
        }

        // Flanken vor t werden nicht mehr gebraucht; ihr Pegel bleibt als baseLevel erhalten
        private void Prune(ulong t)
        {
            int n = 0;
            while(n < edges.Count && edges[n].Ns < t)
            {
                baseLevel = edges[n].Level;
                n++;
            }
            if(n > 0) edges.RemoveRange(0, n);
        }

        private readonly Func<UartFrameFormat> format;
        private readonly List<SignalEdge> edges = new List<SignalEdge>();
        private bool baseLevel;
        private ulong resumeNs;
        private bool inFrame;
        private ulong frameStart;
        private UartFrameFormat frameFormat;
    }

    // Flankenpuffer einer Leitung für die Anzeige. Thread-sicher (eigene Sperre, die nie mit
    // anderen Sperren verschachtelt wird). Flanken in der Zukunft bleiben im Puffer, bis die
    // virtuelle Zeit sie erreicht hat.
    public class SignalRecorder
    {
        public SignalRecorder(string name, bool idle)
        {
            Name = name;
            this.idle = idle;
            Reset();
        }

        public string Name { get; private set; }

        public void Reset()
        {
            lock(sync)
            {
                edges.Clear();
                lastLevel = idle;
                reportedLevel = idle;
                lost = 0;
            }
        }

        // Aktueller bzw. zuletzt eingetragener Pegel (auch zukünftige Flanken)
        public bool LastLevel { get { lock(sync) { return lastLevel; } } }

        public void Add(IList<SignalEdge> list)
        {
            lock(sync)
            {
                foreach(var e in list)
                {
                    if(e.Level == lastLevel) continue;   // nur echte Pegelwechsel
                    if(edges.Count > 0 && e.Ns <= edges[edges.Count - 1].Ns)
                    {
                        // gleiche Zeit: vorige Flanke wird ersetzt (Glitch von 0 ns)
                        edges.RemoveAt(edges.Count - 1);
                        lastLevel = edges.Count > 0 ? edges[edges.Count - 1].Level : reportedLevel;
                        if(e.Level == lastLevel) continue;
                    }
                    if(edges.Count >= MaxEdges)
                    {
                        int drop = MaxEdges / 4;
                        reportedLevel = edges[drop - 1].Level;
                        edges.RemoveRange(0, drop);
                        lost += drop;
                    }
                    edges.Add(e);
                    lastLevel = e.Level;
                }
            }
        }

        // Flanken nach ns verwerfen; ab ns liegt die Leitung auf Ruhepegel
        public void Truncate(ulong ns)
        {
            lock(sync)
            {
                int n = edges.Count;
                while(n > 0 && edges[n - 1].Ns > ns) n--;
                edges.RemoveRange(n, edges.Count - n);
                lastLevel = n > 0 ? edges[n - 1].Level : reportedLevel;
            }
            Add(new[] { new SignalEdge(ns + 1, idle) });
        }

        // "SE:<name>:<now>:<level>:<baud>:<format>:<lost>:<t0>,<l0>;<dt>,<l>;..."
        // Liefert die Flanken mit Zeit <= now und entfernt sie aus dem Puffer. Die erste Zeit ist
        // absolut, jede weitere relativ zur vorigen Flanke (ns). level = Pegel bei now.
        public string Format(ulong nowNs, string baud, string format)
        {
            lock(sync)
            {
                var sb = new StringBuilder();
                int n = 0;
                while(n < edges.Count && edges[n].Ns <= nowNs) n++;
                bool levelNow = n > 0 ? edges[n - 1].Level : reportedLevel;
                sb.Append("SE:").Append(Name).Append(':').Append(nowNs).Append(':').Append(levelNow ? 1 : 0)
                  .Append(':').Append(baud).Append(':').Append(format).Append(':').Append(lost).Append(':');
                ulong prev = 0;
                for(int i = 0; i < n; i++)
                {
                    var e = edges[i];
                    sb.Append(i == 0 ? e.Ns : e.Ns - prev).Append(',').Append(e.Level ? 1 : 0).Append(';');
                    prev = e.Ns;
                }
                edges.RemoveRange(0, n);
                reportedLevel = levelNow;
                lost = 0;
                return sb.ToString();
            }
        }

        private const int MaxEdges = 200000;
        private readonly object sync = new object();
        private readonly List<SignalEdge> edges = new List<SignalEdge>();
        private readonly bool idle;
        private bool lastLevel;
        private bool reportedLevel;
        private long lost;
    }

    // Zeitgeber für Modelle: virtuelle Zeit in ns und einmalige Aktionen zu einer festen Zeit.
    public class VirtualClock
    {
        public VirtualClock(IMachine machine)
        {
            this.machine = machine;
        }

        // Aktuelle virtuelle Zeit in ns. Auf dem CPU-Thread wird vorher die Zeit des gerade
        // ausgeführten Befehls übernommen (sonst wäre es der Beginn der Zeitscheibe).
        public ulong NowNs()
        {
            ulong t = RawNs();
            lock(sync)
            {
                if(t < monotonic) t = monotonic;   // nie hinter eine schon erreichte Weckzeit zurück
                monotonic = t;
            }
            return t;
        }

        // Führt action(Zeit) aus, sobald die virtuelle Zeit atNs erreicht hat. Nicht aufrufen,
        // während eine eigene Sperre gehalten wird (Aktionen laufen mit gesperrter Uhr).
        public void At(ulong atNs, Action<ulong> action, string name)
        {
            ulong now = RawNs();
            ulong delay = atNs > now ? atNs - now : 1;
            machine.ScheduleAction(Antmicro.Renode.Time.TimeInterval.FromNanoseconds(delay), _ =>
            {
                lock(sync)
                {
                    if(atNs > monotonic) monotonic = atNs;
                }
                action(atNs);
            }, name);
        }

        private ulong RawNs()
        {
            if(machine.SystemBus.TryGetCurrentCPU(out var cpu))
            {
                cpu.SyncTime();
            }
            return machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
        }

        private readonly IMachine machine;
        private readonly object sync = new object();
        private ulong monotonic;
    }
}
