// PC am anderen Ende einer UART-Leitung (USB-Seriell-Wandler + Terminalprogramm wie Tera Term).
//
// Auf dem EK-TM4C1294XL hängt UART0 (PA0/PA1) am Debug-Chip, der am PC als virtueller
// COM-Port erscheint. Dieses Modell spielt diesen PC:
//   * Empfangen: dekodiert die Flanken des Mikrocontrollers mit der hier eingestellten Baudrate
//     und dem Format (wie die Einstellung im Terminalprogramm) und gibt die Zeichen als Bytes
//     aus (CharReceived -> TCP-Terminal ServeTcp -> Web-Konsole).
//   * Senden: Tastatureingaben (WriteChar) werden mit derselben Einstellung zu Flanken auf der
//     RX-Leitung des Mikrocontrollers.
// Passt die Einstellung nicht zu der des Mikrocontrollers, erscheinen falsche Zeichen.
//
// Anschluss (repl):
//   host: UART.UartHostTerminal @ uart0
//       baudRate: 115200
//       format: "8N1"
// und im .resc:  sysbus.uart0.host ServeTcp 3335
//
// ServeTcp statt "emulation CreateServerSocketTerminal 3335 …; connector Connect …": Renodes
// Socket-Terminal (1.17) hält mit verbundenem Client einen Thread dauerhaft bei ~100 % CPU
// (gemessen) – auf zwei Kernen halbierte das die Simulation. Hier blockiert das Lesen, gesendet
// wird von einem eigenen Thread; Bytes 1:1, ohne Telnet-Steuerzeichen, ein Client (ein neuer
// ersetzt den alten). Die Connector-Variante funktioniert weiterhin.
//
// Bedienung im Renode-Monitor:
//   sysbus.uart0.host TerminalBaudRate 9600  Baudrate des Terminals
//   sysbus.uart0.host Format "7N1"          Datenbits (5-8), Parität (N/O/E/M/S), Stoppbits (1-2)
//   sysbus.uart0.host Errors                Anzahl der Zeichen mit Framing-/Paritätsfehler
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.UART
{
    public class UartHostTerminal : UARTBase, IUartLineEndpoint, IDisposable
    {
        public UartHostTerminal(IMachine machine, uint baudRate = 115200, string format = "8N1") : base(machine)
        {
            this.hostMachine = machine;
            clock = new VirtualClock(machine);
            settings = UartFrameFormat.Parse(baudRate, format);
            decoder = new UartLineDecoder(() => settings);
            Reset();
        }

        // Baudrate des Terminals (wirkt ab dem nächsten Zeichen)
        public override uint BaudRate
        {
            get { return (uint)Math.Round(settings.Baud); }
        }

        public uint TerminalBaudRate
        {
            get { return BaudRate; }
            set
            {
                settings = UartFrameFormat.Parse(value, settings.Name);
                Changed();
            }
        }

        // "8N1", "7E1", ...
        public string Format
        {
            get { return settings.Name; }
            set
            {
                settings = UartFrameFormat.Parse(settings.Baud, value);
                Changed();
            }
        }

        public long Errors { get; private set; }

        public override Bits StopBits { get { return settings.StopBits == 2 ? Bits.Two : Bits.One; } }

        public override Parity ParityBit
        {
            get
            {
                switch(settings.Parity)
                {
                    case UartParity.Odd: return Parity.Odd;
                    case UartParity.Even: return Parity.Even;
                    case UartParity.Mark: return Parity.Forced1;
                    case UartParity.Space: return Parity.Forced0;
                    default: return Parity.None;
                }
            }
        }

        public UartFrameFormat TransmitFormat { get { return settings; } }

        public ulong DecodedUntilNs { get { return decoder.DecodedUntilNs; } }

        public override void Reset()
        {
            base.Reset();
            decoder.Reset();
            lineFreeNs = 0;
            wakeNs = ulong.MaxValue;
            Errors = 0;
            errorWarned = false;
        }

        public void AttachLine(IUartLineEndpoint partner)
        {
            line = partner;
        }

        // Der Mikrocontroller wurde zurückgesetzt: ein angefangenes Zeichen bricht ab
        public void LineReset(ulong ns)
        {
            decoder.Truncate(ns);
            RunDecoder();
        }

        // Flanken vom TX-Pin des Mikrocontrollers
        public void LineEdges(IList<SignalEdge> edges)
        {
            decoder.AddEdges(edges);
            RunDecoder();
        }

        // Tastatureingabe im Terminal -> Flanken auf der RX-Leitung des Mikrocontrollers
        public override void WriteChar(byte value)
        {
            if(line == null) return;
            ulong now = clock.NowNs();
            double start = Math.Max(Math.Max((double)now, lineFreeNs), line.DecodedUntilNs);
            var edges = new List<SignalEdge>();
            lineFreeNs = UartEncoder.Encode(start, value, settings, edges);
            line.LineEdges(edges);
        }

        // ---- TCP-Terminal ----------------------------------------------------------------------

        public void ServeTcp(int port)
        {
            if(listener != null) return;
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            CharReceived += b =>
            {
                lock(outQueue)
                {
                    // Ohne Client sammeln (Startmeldung, bevor die Web-Konsole verbunden ist) –
                    // beim Verbinden wird der Rest gesendet
                    if(outQueue.Count < MaxQueuedBytes) outQueue.Enqueue(b);
                    if(client != null) System.Threading.Monitor.Pulse(outQueue);
                }
            };
            new Thread(AcceptLoop) { IsBackground = true, Name = "UartHostTerminal accept" }.Start();
            new Thread(SendLoop) { IsBackground = true, Name = "UartHostTerminal send" }.Start();
            this.Log(LogLevel.Info, "Terminal auf TCP-Port {0}", port);
        }

        private void AcceptLoop()
        {
            while(true)
            {
                TcpClient c;
                var l = listener;
                if(l == null) return;
                try
                {
                    c = l.AcceptTcpClient();
                }
                catch(Exception)
                {
                    return;
                }
                c.NoDelay = true;
                lock(outQueue)
                {
                    if(client != null) client.Close();
                    client = c;
                    System.Threading.Monitor.Pulse(outQueue);   // Gesammeltes senden
                }
                new Thread(() => ReadLoop(c)) { IsBackground = true, Name = "UartHostTerminal read" }.Start();
            }
        }

        // Tastatur -> UART (blockierend lesen, im Zeitbereich der Maschine wie Renodes Terminal)
        private void ReadLoop(TcpClient c)
        {
            var buf = new byte[256];
            try
            {
                var stream = c.GetStream();
                while(true)
                {
                    int n = stream.Read(buf, 0, buf.Length);
                    if(n <= 0) break;
                    for(int i = 0; i < n; i++)
                    {
                        hostMachine.HandleTimeDomainEvent<byte>(WriteChar, buf[i], false);
                    }
                }
            }
            catch(Exception)
            {
            }
            lock(outQueue)
            {
                if(client == c) client = null;
            }
            c.Close();
        }

        // UART -> Terminal (eigener Thread: der CPU-Thread schreibt nie in den Socket)
        private void SendLoop()
        {
            var chunk = new List<byte>();
            while(true)
            {
                TcpClient c;
                lock(outQueue)
                {
                    while(!disposed && (outQueue.Count == 0 || client == null)) System.Threading.Monitor.Wait(outQueue);
                    if(disposed) return;
                    chunk.Clear();
                    while(outQueue.Count > 0) chunk.Add(outQueue.Dequeue());
                    c = client;
                }
                try
                {
                    var data = chunk.ToArray();
                    c.GetStream().Write(data, 0, data.Length);
                }
                catch(Exception)
                {
                }
            }
        }

        // Maschine entfernt (mach rem, Renode bleibt laufen): Port und Threads freigeben
        public void Dispose()
        {
            var l = listener;
            listener = null;
            if(l != null) l.Stop();
            lock(outQueue)
            {
                disposed = true;
                if(client != null) client.Close();
                client = null;
                System.Threading.Monitor.PulseAll(outQueue);
            }
        }

        private bool disposed;
        private readonly IMachine hostMachine;
        private TcpListener listener;
        private TcpClient client;
        private readonly Queue<byte> outQueue = new Queue<byte>();
        private const int MaxQueuedBytes = 64 * 1024;

        protected override void CharWritten()
        {
        }

        protected override void QueueEmptied()
        {
        }

        private void Changed()
        {
            errorWarned = false;
            this.Log(LogLevel.Info, "Terminal: {0}", settings.Describe());
        }

        private void RunDecoder()
        {
            ulong now = clock.NowNs();
            ulong? wake = decoder.Process(now, OnFrame);
            if(wake.HasValue && wake.Value < wakeNs)
            {
                ulong at = wake.Value;
                wakeNs = at;
                clock.At(at, t =>
                {
                    if(wakeNs == at) wakeNs = ulong.MaxValue;
                    RunDecoder();
                }, "host-rx");
            }
        }

        private void OnFrame(int value, UartErrors errors, ulong startNs, ulong stopNs)
        {
            if(errors != UartErrors.None)
            {
                Errors++;
                if(!errorWarned)
                {
                    var other = line != null ? line.TransmitFormat : null;
                    this.Log(LogLevel.Warning,
                        "Terminal: {0} beim Empfang – Terminal eingestellt auf {1}, Mikrocontroller sendet mit {2}.",
                        (errors & UartErrors.Break) != 0 ? "Break" : (errors & UartErrors.Framing) != 0 ? "Framing-Fehler" : "Paritätsfehler",
                        settings.Describe(), other != null && other.Valid ? other.Describe() : "?");
                    errorWarned = true;
                }
                if((errors & UartErrors.Break) != 0) return;   // Break erzeugt kein Zeichen
            }
            // Wie ein PC-Treiber: auch fehlerhafte Zeichen werden angezeigt
            TransmitCharacter((byte)value);
        }

        private readonly VirtualClock clock;
        private readonly UartLineDecoder decoder;
        private UartFrameFormat settings;
        private IUartLineEndpoint line;
        private double lineFreeNs;
        private ulong wakeNs;
        private bool errorWarned;
    }
}
