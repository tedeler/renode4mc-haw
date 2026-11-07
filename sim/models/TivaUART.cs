// UART des TM4C1294 (UART0..7, je 4 KB, ARM-PrimeCell-PL011-ähnlich).
//
// Modelliert:
//  * DR (Senden/Empfangen), FR (Flags), IBRD/FBRD/LCRH (Baudrate, Format), CTL (UARTEN/TXE/RXE/HSE)
//  * Empfangs-FIFO 16 Byte (LCRH.FEN=1) bzw. 1 Byte (FEN=0), Overrun-Fehler
//  * Interrupts: RX (Füllstand nach IFLS), RT (Receive-Timeout, vereinfacht: "Daten liegen an"),
//    TX (nach jedem gesendeten Zeichen), OE -> IRQ zum NVIC
//  * Clock-Gating über RCGCUART (Offset 0x618)
//  * Peripheral-/PrimeCell-ID-Register wie im Datenblatt
// Senden passiert sofort (TX-FIFO ist immer leer, BUSY=0). Die Baudrate wird nur
// berechnet (Property BaudRate), nicht zeitlich nachgebildet.
//
// Strenge Prüfung wie auf dem Board (Warnungen erscheinen in der Web-Konsole unter "Diagnose"):
//  * Datenblatt 19.3.2: IBRD/FBRD gelten erst nach dem nächsten Schreiben von UARTLCRH;
//    IBRD = 0 ist ungültig. Änderungen an IBRD/FBRD/LCRH bei UARTEN = 1 werden gemeldet.
//  * WLEN < 8 Bit: nur die unteren Datenbits werden übertragen.
//  * Mit  ConnectPins <gpio> <rx> <tx>  (z. B. im .resc:  sysbus.uart0 ConnectPins sysbus.gpioA 0 1)
//    werden die Pins geprüft: Takt, AFSEL, PCTL = 1, DEN. Stimmt etwas nicht, verlässt kein Zeichen
//    den Chip bzw. kommt keins an.
//  * Mit  ExpectedBaudRate <Baud>  und  ExpectedFormat "8N1"  ist die Gegenstelle (Terminal)
//    eingestellt. Passt die Konfiguration der Firmware nicht (Baudrate mehr als BaudTolerance
//    daneben oder anderes Format), kommt wie auf dem Board Zeichensalat an – in beide Richtungen.
//
// Oszilloskop: Mit ConnectPins übernimmt der UART die Pins (Ruhepegel HIGH) und gibt jeden Rahmen als
// Bitstrom aus – TX mit Baudrate und Format der Firmware, RX mit der Einstellung des Terminals. Weil das
// Modell sofort sendet, werden aufeinanderfolgende TX-Rahmen im Leitungstakt aneinandergereiht.
//
// Anschluss im Renode-Monitor, z. B.:
//   emulation CreateServerSocketTerminal 3335 "term" false
//   connector Connect sysbus.uart0 term
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.GPIOPort;
using Antmicro.Renode.Peripherals.Miscellaneous;

namespace Antmicro.Renode.Peripherals.UART
{
    public class TivaUART : UARTBase, IDoubleWordPeripheral, IKnownSize
    {
        // clockBit: Bit in RCGCUART (UART0 = 0 ... UART7 = 7); frequency: UART-Takt (Systemtakt)
        public TivaUART(IMachine machine, TivaSysCtl sysCtl, int clockBit, uint frequency = 16000000) : base(machine)
        {
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            this.frequency = frequency;
            this.machine = machine;
            IRQ = new GPIO();
            Reset();
        }

        public long Size { get { return 0x1000; } }

        public GPIO IRQ { get; private set; }

        public override Bits StopBits { get { return (lcrh & LcrhStp2) != 0 ? Bits.Two : Bits.One; } }

        public override Parity ParityBit
        {
            get
            {
                if((lcrh & LcrhPen) == 0) return Parity.None;
                bool even = (lcrh & LcrhEps) != 0;
                if((lcrh & LcrhSps) != 0) return even ? Parity.Forced0 : Parity.Forced1;
                return even ? Parity.Even : Parity.Odd;
            }
        }

        // Baudrate = UARTCLK / (ClkDiv * (IBRD + FBRD/64)), ClkDiv = 16 (HSE=0) bzw. 8 (HSE=1)
        public override uint BaudRate
        {
            get
            {
                double divisor = ibrd + fbrd / 64.0;
                if(divisor <= 0) return 0;
                uint clkDiv = (ctl & CtlHse) != 0 ? 8u : 16u;
                return (uint)(frequency / (clkDiv * divisor) + 0.5);
            }
        }

        // Einstellung der Gegenstelle (Terminal). 0 = keine Prüfung
        public uint ExpectedBaudRate { get; set; }
        public string ExpectedFormat { get; set; } = "8N1";
        public double BaudTolerance { get; set; } = 0.025;

        // Aktuelle Konfiguration der Firmware, z. B. "9600 7N1"
        public string Configuration { get { return string.Format("{0} {1}", EffectiveBaud(), Format()); } }

        public void ConnectPins(TivaGPIOPort port, int rxPin, int txPin)
        {
            pinPort = port;
            this.rxPin = rxPin;
            this.txPin = txPin;
            port.RegisterAlternateOutput(rxPin, PinFunction, true);
            port.RegisterAlternateOutput(txPin, PinFunction, true);
        }

        public uint ReadDoubleWord(long offset)
        {
            if(!ClockOk(offset)) return 0;
            switch(offset)
            {
                case Dr: return ReadData();
                case Rsr: return rsr;
                case Fr: return Flags();
                case Ilpr: return ilpr;
                case Ibrd: return ibrd;
                case Fbrd: return fbrd;
                case Lcrh: return lcrh;
                case Ctl: return ctl;
                case Ifls: return ifls;
                case Im: return im;
                case Ris: return ris;
                case Mis: return ris & im;
                case Dmactl: return dmactl;
                case Pp: return 0x3;          // NB + SC (laut Datenblatt)
                case Cc: return cc;
                case 0xFD0: case 0xFD4: case 0xFD8: case 0xFDC: return 0x00; // PeriphID4..7
                case 0xFE0: return 0x60;      // PeriphID0
                case 0xFE4: return 0x00;      // PeriphID1
                case 0xFE8: return 0x18;      // PeriphID2
                case 0xFEC: return 0x01;      // PeriphID3
                case 0xFF0: return 0x0D;      // PCellID0
                case 0xFF4: return 0xF0;      // PCellID1
                case 0xFF8: return 0x05;      // PCellID2
                case 0xFFC: return 0xB1;      // PCellID3
                default:
                    uint value;
                    other.TryGetValue(offset, out value);
                    return value;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk(offset)) return;
            switch(offset)
            {
                case Dr: WriteData((byte)value); break;
                case Rsr: rsr = 0; break;     // ECR: Schreiben löscht die Fehler
                case Ilpr: ilpr = value & 0xFF; break;
                case Ibrd:
                    WarnIfEnabled("UARTIBRD");
                    ibrd = value & 0xFFFF;
                    baudPending = true;
                    break;
                case Fbrd:
                    WarnIfEnabled("UARTFBRD");
                    fbrd = value & 0x3F;
                    baudPending = true;
                    break;
                case Lcrh:
                    WarnIfEnabled("UARTLCRH");
                    lcrh = value & 0xFF;
                    latchedIbrd = ibrd;          // Datenblatt: Schreiben von LCRH übernimmt IBRD/FBRD
                    latchedFbrd = fbrd;
                    baudPending = false;
                    break;
                case Ctl:
                    ctl = value;
                    if((value & CtlUarten) != 0 && (value & (CtlLbe | CtlSiren | CtlSmart | CtlEot)) != 0)
                    {
                        Warn("ctlBits", "UARTCTL: Loopback, IrDA, Smartcard und EOT sind im Simulator nicht modelliert.");
                    }
                    break;
                case Ifls: ifls = value & 0x3F; break;
                case Im: im = value & ImMask; break;
                case Icr: ris &= ~value; break;
                case Dmactl: dmactl = value & 0x7; break;
                case Cc:
                    cc = value & 0xF;
                    if(cc != 0 && cc != 5) Warn("cc", string.Format("UARTCC = 0x{0:X} ist reserviert (0x0 = Systemtakt, 0x5 = ALTCLK).", cc));
                    break;
                case Fr: case Ris: case Mis: break; // nur lesbar
                default: other[offset] = value; break;
            }
            UpdateInterrupts();
        }

        public override void Reset()
        {
            base.Reset();
            rsr = ilpr = ibrd = fbrd = lcrh = im = ris = dmactl = cc = 0;
            ctl = 0x300;   // TXE, RXE
            latchedIbrd = latchedFbrd = 0;
            baudPending = false;
            warned = new HashSet<string>();
            lastConfigWarning = null;
            lock(lineLock) { line.Clear(); lineBusy = false; }
            txLineFreeUs = 0;
            ifls = 0x12;   // RX und TX: 1/2 voll
            clockWarned = false;
            other = new Dictionary<long, uint>();
            if(IRQ != null) IRQ.Unset();
        }

        // Zeichen vom Terminal. Mit ExpectedBaudRate kommen sie im Takt der Leitung an (ein Zeichen
        // pro Rahmen aus Start-, Daten-, Paritäts- und Stoppbits) – wie auf dem Board: Bei 9600 Bit/s
        // 7N1 also ca. alle 0,94 ms, auch wenn das Terminal eine ganze Zeile auf einmal schickt.
        public override void WriteChar(byte value)
        {
            if(ExpectedBaudRate == 0)
            {
                if(pinPort != null && EffectiveBaud() > 0)
                {
                    EmitFrame(rxPin, value, EffectiveBaud(), DataBits, Format()[1], (lcrh & LcrhStp2) != 0 ? 2 : 1, pinPort.NowUs());
                }
                base.WriteChar(value);
                return;
            }
            bool start;
            lock(lineLock)
            {
                if(line.Count >= MaxLine)
                {
                    Warn("lineFull", "Mehr als 4096 Zeichen vom Terminal unterwegs – weitere verworfen.");
                    return;
                }
                line.Enqueue(value);
                start = !lineBusy;
                lineBusy = true;
            }
            if(start)
            {
                EmitTerminalFrame(value);
                machine.ScheduleAction(FrameTime(), _ => LineNext(), "UART RX");
            }
        }

        private void LineNext()
        {
            byte value, next = 0;
            bool more;
            lock(lineLock)
            {
                if(line.Count == 0)
                {
                    lineBusy = false;
                    return;
                }
                value = line.Dequeue();
                more = line.Count > 0;
                if(more) next = line.Peek();
                if(!more) lineBusy = false;
            }
            base.WriteChar(value);
            if(more)
            {
                EmitTerminalFrame(next);
                machine.ScheduleAction(FrameTime(), _ => LineNext(), "UART RX");
            }
        }

        // Rahmen vom Terminal auf dem RX-Pin (beginnt jetzt, Format des Terminals)
        private void EmitTerminalFrame(byte value)
        {
            if(pinPort == null) return;
            string f = ExpectedFormat ?? "8N1";
            int dataBits = 8, stop = 1;
            char par = 'N';
            if(f.Length == 3 && char.IsDigit(f[0]) && char.IsDigit(f[2]))
            {
                dataBits = f[0] - '0';
                par = f[1];
                stop = f[2] - '0';
            }
            EmitFrame(rxPin, value, ExpectedBaudRate, dataBits, par, stop, pinPort.NowUs());
        }

        // Ein UART-Rahmen als Pegelwechsel am Pin: Startbit (LOW), Datenbits LSB zuerst, Parität,
        // Stoppbit(s) (HIGH). Liefert das Ende des Rahmens (us).
        private double EmitFrame(int pin, byte value, uint baud, int dataBits, char parity, int stopBits, double startUs)
        {
            if(baud == 0) return startUs;
            double bitUs = 1e6 / baud;
            var bits = new List<bool> { false };
            int ones = 0;
            for(int i = 0; i < dataBits; i++)
            {
                bool b = ((value >> i) & 1) != 0;
                bits.Add(b);
                if(b) ones++;
            }
            switch(parity)
            {
                case 'E': bits.Add(ones % 2 == 1); break;
                case 'O': bits.Add(ones % 2 == 0); break;
                case 'S': bits.Add(false); break;
                case 'M': bits.Add(true); break;
            }
            bool level = true;
            for(int i = 0; i < bits.Count; i++)
            {
                if(bits[i] != level)
                {
                    level = bits[i];
                    pinPort.AlternateOutput(pin, PinFunction, startUs + i * bitUs, level);
                }
            }
            if(!level) pinPort.AlternateOutput(pin, PinFunction, startUs + bits.Count * bitUs, true);
            return startUs + (bits.Count + stopBits) * bitUs;
        }

        // Dauer eines Zeichens auf der Leitung nach der Einstellung des Terminals
        private Antmicro.Renode.Time.TimeInterval FrameTime()
        {
            string f = ExpectedFormat ?? "8N1";
            int bits = 1 + 8 + 1;
            if(f.Length == 3 && char.IsDigit(f[0]) && char.IsDigit(f[2]))
            {
                bits = 1 + (f[0] - '0') + (f[1] == 'N' ? 0 : 1) + (f[2] - '0');
            }
            ulong us = (ulong)System.Math.Ceiling(bits * 1e6 / ExpectedBaudRate);
            return Antmicro.Renode.Time.TimeInterval.FromMicroseconds(System.Math.Max(1UL, us));
        }

        // Zeichen von außen (Terminal): bei vollem FIFO verwerfen und Overrun melden (wie Hardware)
        protected override void WriteCharInner(byte value, UARTFrame frame)
        {
            if(!IsReceiveEnabled)
            {
                Warn("rxOff", "Zeichen vom Terminal verworfen – Empfänger nicht eingeschaltet (UARTCTL: UARTEN, RXE).");
                return;
            }
            string pins = PinProblem(rxPin, "RX");
            if(pins != null)
            {
                Warn("rxPin", "Zeichen vom Terminal kommt nicht an – " + pins);
                return;
            }
            if(!ConfigMatches("Empfangen"))
            {
                value = Garble(value);
            }
            value = (byte)(value & DataMask());
            if(IsReceiveEnabled && Count >= FifoDepth)
            {
                rsr |= RsrOe;
                ris |= IntOe;
                this.Log(LogLevel.Warning, "UART{0}: Empfangs-FIFO voll, Zeichen 0x{1:X2} verworfen (Overrun)", clockBit, value);
                UpdateInterrupts();
                return;
            }
            base.WriteCharInner(value, frame);
        }

        // Die Basisklasse hat das Zeichen in die Empfangs-Queue gelegt.
        protected override void CharWritten()
        {
            UpdateInterrupts();
        }

        protected override void QueueEmptied()
        {
            UpdateInterrupts();
        }

        protected override bool IsReceiveEnabled
        {
            get { return (ctl & CtlUarten) != 0 && (ctl & CtlRxe) != 0; }
        }

        private int FifoDepth { get { return (lcrh & LcrhFen) != 0 ? 16 : 1; } }

        private int RxThreshold
        {
            get
            {
                if((lcrh & LcrhFen) == 0) return 1;
                switch((ifls >> 3) & 7)
                {
                    case 0: return 2;   // 1/8
                    case 1: return 4;   // 1/4
                    case 2: return 8;   // 1/2
                    case 3: return 12;  // 3/4
                    default: return 14; // 7/8
                }
            }
        }

        private uint ReadData()
        {
            byte c;
            if(!TryGetCharacter(out c))
            {
                return 0;
            }
            UpdateInterrupts();
            return c;
        }

        private void WriteData(byte c)
        {
            if((ctl & CtlUarten) == 0 || (ctl & CtlTxe) == 0)
            {
                this.Log(LogLevel.Warning,
                    "UART{0}: Zeichen 0x{1:X2} verworfen – UART bzw. Sender nicht eingeschaltet (UARTCTL: UARTEN, TXE).",
                    clockBit, c);
                return;
            }
            ris |= IntTx;   // Sendepuffer sofort wieder frei
            if(EffectiveDivisor() <= 0)
            {
                Warn("ibrd0", "Baudrate nicht eingestellt: UARTIBRD = 0 (bzw. IBRD/FBRD nicht mit einem Schreiben von UARTLCRH übernommen) – es wird nichts gesendet.");
                return;
            }
            if(baudPending)
            {
                Warn("lcrhMissing", "UARTIBRD/UARTFBRD geschrieben, aber danach UARTLCRH nicht: Datenblatt 19.3.2 – die neue Baudrate gilt erst nach dem Schreiben von UARTLCRH.");
            }
            string pins = PinProblem(txPin, "TX");
            if(pins != null)
            {
                Warn("txPin", "Zeichen verlässt den Chip nicht – " + pins);
                return;
            }
            c = (byte)(c & DataMask());
            if(pinPort != null)
            {
                // Auf der Leitung liegt das Zeichen der Firmware (Zeichensalat entsteht erst beim Terminal)
                char par = Format()[1];
                double start = System.Math.Max(pinPort.NowUs(), txLineFreeUs);
                txLineFreeUs = EmitFrame(txPin, c, EffectiveBaud(), DataBits, par, (lcrh & LcrhStp2) != 0 ? 2 : 1, start);
            }
            TransmitCharacter(ConfigMatches("Senden") ? c : Garble(c));
        }

        private double EffectiveDivisor()
        {
            return latchedIbrd == 0 ? 0 : latchedIbrd + latchedFbrd / 64.0;
        }

        private uint EffectiveBaud()
        {
            double d = EffectiveDivisor();
            if(d <= 0) return 0;
            uint clkDiv = (ctl & CtlHse) != 0 ? 8u : 16u;
            return (uint)(frequency / (clkDiv * d) + 0.5);
        }

        private int DataBits { get { return 5 + (int)((lcrh >> 5) & 3); } }

        private uint DataMask()
        {
            return (1u << DataBits) - 1;
        }

        private string Format()
        {
            char parity = 'N';
            if((lcrh & LcrhPen) != 0)
            {
                bool even = (lcrh & LcrhEps) != 0;
                parity = (lcrh & LcrhSps) != 0 ? (even ? 'S' : 'M') : (even ? 'E' : 'O');
            }
            return string.Format("{0}{1}{2}", DataBits, parity, (lcrh & LcrhStp2) != 0 ? 2 : 1);
        }

        // Passt die Konfiguration zur Gegenstelle? Meldet einen Unterschied einmal je Konfiguration.
        private bool ConfigMatches(string what)
        {
            if(ExpectedBaudRate == 0) return true;
            uint baud = EffectiveBaud();
            string format = Format();
            double error = baud == 0 ? 1 : System.Math.Abs((double)baud - ExpectedBaudRate) / ExpectedBaudRate;
            bool ok = error <= BaudTolerance && format == ExpectedFormat;
            string config = baud + " " + format;
            if(!ok && lastConfigWarning != config)
            {
                lastConfigWarning = config;
                this.Log(LogLevel.Warning,
                    "UART{0}: Firmware ist auf {1} Baud {2} eingestellt (IBRD = {3}, FBRD = {4}, LCRH = 0x{5:X2}), das Terminal erwartet {6} Baud {7}" +
                    " (Abweichung {8:F1} %, erlaubt {9:F1} %). Beim {10} kommt nur Zeichensalat an.",
                    clockBit, baud, format, latchedIbrd, latchedFbrd, lcrh, ExpectedBaudRate, ExpectedFormat,
                    error * 100, BaudTolerance * 100, what);
            }
            if(ok && lastConfigWarning != null && lastConfigWarning != "ok")
            {
                lastConfigWarning = "ok";
                this.Log(LogLevel.Warning, "UART{0}: Konfiguration jetzt korrekt ({1} Baud {2}).", clockBit, baud, format);
            }
            return ok;
        }

        // Falsch eingestellte Gegenstelle: aus einem Zeichen wird ein anderes (nicht druckbar)
        private static byte Garble(byte c)
        {
            return (byte)(0x80 | ((c * 37 + 11) & 0x7F));
        }

        private string PinProblem(int pin, string name)
        {
            if(pinPort == null) return null;
            string p = pinPort.CheckAlternateFunction(pin, 1);
            return p == null ? null : string.Format("UART{0} {1}-Pin falsch konfiguriert: {2}", clockBit, name, p);
        }

        private void WarnIfEnabled(string reg)
        {
            if((ctl & CtlUarten) != 0)
            {
                Warn("en" + reg, reg + " geändert, während der UART eingeschaltet ist (UARTEN = 1). Datenblatt 19.4: UART zuerst ausschalten.");
            }
        }

        private void Warn(string key, string message)
        {
            if(warned.Add(key))
            {
                this.Log(LogLevel.Warning, "UART{0}: {1}", clockBit, message);
            }
        }

        private uint Flags()
        {
            uint fr = FrTxfe;               // TX-FIFO immer leer, nie BUSY
            int count = Count;
            if(count == 0) fr |= FrRxfe;
            if(count >= FifoDepth) fr |= FrRxff;
            return fr;
        }

        private void UpdateInterrupts()
        {
            int count = Count;
            if(count >= RxThreshold) ris |= IntRx; else ris &= ~IntRx;
            if(count > 0) ris |= IntRt; else ris &= ~IntRt;
            IRQ.Set((ris & im) != 0);
        }

        private bool ClockOk(long offset)
        {
            if(sysCtl.IsClockEnabled(RcgcUart, clockBit))
            {
                clockWarned = false;
                return true;
            }
            if(!clockWarned)
            {
                this.Log(LogLevel.Warning,
                    "UART{0}: Zugriff (Offset 0x{1:X}) ohne Takt! RCGCUART Bit {0} muss gesetzt werden " +
                    "(SysCtlPeripheralEnable). Auf der Hardware führt das zu einem Fault.",
                    clockBit, offset);
                clockWarned = true;
            }
            return false;
        }

        // Register-Offsets und Bits wie in tm4c1294ncpdt.h (UARTn_..._R, UART_...); geprüft mit
        // tools/check_header.py
        private const long RcgcUart = 0x618;
        private const long Dr = 0x000, Rsr = 0x004, Fr = 0x018, Ilpr = 0x020, Ibrd = 0x024, Fbrd = 0x028,
                           Lcrh = 0x02C, Ctl = 0x030, Ifls = 0x034, Im = 0x038, Ris = 0x03C, Mis = 0x040,
                           Icr = 0x044, Dmactl = 0x048, Pp = 0xFC0, Cc = 0xFC8;

        private const uint FrRxfe = 1u << 4, FrRxff = 1u << 6, FrTxfe = 1u << 7;
        private const uint LcrhPen = 1u << 1, LcrhEps = 1u << 2, LcrhStp2 = 1u << 3, LcrhFen = 1u << 4,
                           LcrhSps = 1u << 7;
        private const uint CtlUarten = 1u << 0, CtlSiren = 1u << 1, CtlSmart = 1u << 3, CtlEot = 1u << 4,
                           CtlHse = 1u << 5, CtlLbe = 1u << 7, CtlTxe = 1u << 8, CtlRxe = 1u << 9;
        private const uint IntRx = 1u << 4, IntTx = 1u << 5, IntRt = 1u << 6, IntOe = 1u << 10;
        private const uint RsrOe = 1u << 3;
        // alle Bits von UARTIM laut tm4c1294ncpdt.h außer DMA (UART_IM_..., 0..12); nur RX/TX/RT/OE werden ausgelöst
        private const uint ImMask = 0x1FFF;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly uint frequency;
        private uint rsr, ilpr, ibrd, fbrd, lcrh, ctl, ifls, im, ris, dmactl, cc;
        private bool clockWarned;
        private Dictionary<long, uint> other;
        private uint latchedIbrd, latchedFbrd;
        private bool baudPending;
        private HashSet<string> warned;
        private string lastConfigWarning;
        private TivaGPIOPort pinPort;
        private readonly IMachine machine;
        private readonly object lineLock = new object();
        private readonly Queue<byte> line = new Queue<byte>();
        private bool lineBusy;
        private const int MaxLine = 4096;
        private int rxPin, txPin;
        private double txLineFreeUs;
        private const int PinFunction = 1;   // GPIOPCTL-Wert für UnRx/UnTx
    }
}
