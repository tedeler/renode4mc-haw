// UART des TM4C1294 (UART0..7, je 4 KB, ARM-PrimeCell-PL011-ähnlich).
//
// Modelliert:
//  * DR (Senden/Empfangen mit Fehlerbits FE/PE/BE/OE), RSR/ECR, FR (Flags), IBRD/FBRD/LCRH
//    (Baudrate, Format, BRK), CTL (UARTEN/TXE/RXE/HSE/EOT/LBE), CC (Taktquelle), IFLS
//  * Sende- und Empfangs-FIFO 16 Zeichen (LCRH.FEN=1) bzw. 1 Zeichen (FEN=0), Overrun-Fehler
//  * Interrupts: RX (Füllstand nach IFLS), RT (vereinfacht: "Daten liegen an"), TX (Füllstand
//    nach IFLS bzw. Ende der Übertragung mit CTL.EOT), OE, FE, PE, BE -> IRQ zum NVIC
//  * Clock-Gating über RCGCUART (Offset 0x618)
//  * Peripheral-/PrimeCell-ID-Register wie im Datenblatt
//
// Leitung (sim/models/UartLine.cs): Gesendet wird ein Signal aus Flanken mit Zeitstempel in ns.
// Die Bitdauer ergibt sich aus IBRD/FBRD, CTL.HSE und dem UART-Takt (CC: Systemtakt aus
// TivaSysCtl oder PIOSC 16 MHz). Ein Zeichen braucht also so lange wie auf der Hardware: TXFF,
// TXFE und BUSY in FR folgen dem zeitlichen Ablauf. Empfangen wird ebenso aus Flanken: der
// Empfänger tastet in der Bitmitte ab, gemessen ab der fallenden Flanke des Startbits und mit
// SEINER eingestellten Baudrate. Falsche Baudrate oder falsches Format ergeben falsche Zeichen,
// Framing- und Paritätsfehler wie an der echten Hardware.
//
// Gegenstelle: ein Endpunkt (IUartLineEndpoint), der unter dem UART registriert wird, z. B.
//   host: UART.UartHostTerminal @ uart0      (PC mit Terminalprogramm, siehe UartHostTerminal.cs)
// Ohne Gegenstelle gibt der UART jedes Zeichen am Ende seines Frames als Byte aus
// (CharReceived), ein direkt verbundenes Renode-Terminal funktioniert also weiter.
//
// Pins: Mit pinPort/txPin/rxPin/pinFunction (z. B. gpioA, 1, 0, 1 für PA1 = U0TX, PA0 = U0RX)
// prüft der UART, ob die Pins per AFSEL/DEN/PCTL wirklich ihm gehören. Sonst erscheinen die
// Flanken nicht auf der Leitung bzw. erreichen den Empfänger nicht (mit einer Warnung).
//
// Anzeige (Oszilloskop der Web-Konsole):
//   sysbus.uart0 GetEdges   -> "SE:uart0.tx:..." und "SE:uart0.rx:..." (Format in UartLine.cs,
//                              SignalRecorder.Format), durch ein Leerzeichen getrennt
//   sysbus.uart0 LineBaudRate / FrameFormat -> aktuelle Einstellung (z. B. 115190.8 / "8N1")
using System;
using System.Collections.Generic;
using System.Globalization;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.GPIOPort;
using Antmicro.Renode.Peripherals.Miscellaneous;

namespace Antmicro.Renode.Peripherals.UART
{
    public class TivaUART : UARTBase, IDoubleWordPeripheral, IKnownSize, IUartLineEndpoint
    {
        // clockBit: Bit in RCGCUART (UART0 = 0 ... UART7 = 7)
        public TivaUART(IMachine machine, TivaSysCtl sysCtl, int clockBit, TivaGPIOPort pinPort = null,
                        int txPin = -1, int rxPin = -1, uint pinFunction = 1) : base(machine)
        {
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            this.pinPort = pinPort;
            this.txPin = txPin;
            this.rxPin = rxPin;
            this.pinFunction = pinFunction;
            clock = new VirtualClock(machine);
            name = "uart" + clockBit;
            txRecorder = new SignalRecorder(name + ".tx", true);
            rxRecorder = new SignalRecorder(name + ".rx", true);
            decoder = new UartLineDecoder(() => CurrentFormat());
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
        public override uint BaudRate { get { return (uint)Math.Round(LineBaudRate); } }

        public double LineBaudRate
        {
            get
            {
                double divisor = ibrd + fbrd / 64.0;
                if(divisor <= 0) return 0;
                double clkDiv = (ctl & CtlHse) != 0 ? 8 : 16;
                return UartClock / (clkDiv * divisor);
            }
        }

        // Takt des UART: Systemtakt (CC = 0) oder PIOSC 16 MHz (CC = 5)
        public double UartClock { get { return (cc & 0xF) == CcPiosc ? 16000000.0 : sysCtl.SystemClockFrequency; } }

        public string FrameFormat { get { return CurrentFormat().Name; } }

        public UartFrameFormat TransmitFormat { get { return CurrentFormat(); } }

        public ulong DecodedUntilNs { get { return decoder.DecodedUntilNs; } }

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
                case Ibrd: ibrd = value & 0xFFFF; break;
                case Fbrd: fbrd = value & 0x3F; break;
                case Lcrh:
                {
                    bool oldBrk = (lcrh & LcrhBrk) != 0;
                    lcrh = value & 0xFF;
                    bool newBrk = (lcrh & LcrhBrk) != 0;
                    if(oldBrk != newBrk) SetBreak(newBrk);
                    formatWarned = false;
                    break;
                }
                case Ctl:
                    ctl = value;
                    break;
                case Ifls: ifls = value & 0x3F; break;
                case Im: im = value & ImMask; break;
                case Icr: ris &= ~value; break;
                case Dmactl: dmactl = value & 0x7; break;
                case Cc: cc = value & 0xF; break;
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
            ifls = 0x12;   // RX und TX: 1/2 voll
            clockWarned = formatWarned = txPinWarned = rxPinWarned = false;
            other = new Dictionary<long, uint>();
            rxFifo.Clear();
            txWaiting.Clear();
            txLineFreeNs = 0;
            breakActive = false;
            rxWakeNs = ulong.MaxValue;
            decoder.Reset();
            txRecorder.Reset();
            rxRecorder.Reset();
            if(IRQ != null) IRQ.Unset();
        }

        // ---- Gegenstelle --------------------------------------------------------------------

        // Ein Endpunkt (z. B. UartHostTerminal) wird unter dem UART registriert: Er bekommt die
        // Flanken statt der Bytes. Andere IUART (z. B. Renode-Terminals) werden wie üblich über
        // Bytes verbunden.
        public override void Register(IUART uart, NullRegistrationPoint registrationPoint)
        {
            base.Register(uart, registrationPoint);
            var endpoint = uart as IUartLineEndpoint;
            if(endpoint != null)
            {
                CharReceived -= uart.WriteChar;
                uart.CharReceived -= WriteChar;
                line = endpoint;
                endpoint.AttachLine(this);
            }
        }

        public override void Unregister(IUART uart)
        {
            base.Unregister(uart);
            if(ReferenceEquals(uart, line)) line = null;
        }

        public void AttachLine(IUartLineEndpoint partner)
        {
            line = partner;
        }

        // Flanken der Gegenstelle auf der Empfangsleitung (RX-Pin)
        public void LineEdges(IList<SignalEdge> edges)
        {
            rxRecorder.Add(edges);
            if(!RxPinOk())
            {
                if(!rxPinWarned)
                {
                    this.Log(LogLevel.Warning,
                        "UART{0}: Auf der Empfangsleitung kommen Zeichen an, aber {1} ist nicht als U{0}RX " +
                        "geschaltet (GPIOAFSEL, GPIODEN, GPIOPCTL = {2}). Der UART empfängt nichts.",
                        clockBit, PinName(rxPin), pinFunction);
                    rxPinWarned = true;
                }
                return;
            }
            rxPinWarned = false;
            if((ctl & CtlLbe) != 0) return;   // Loopback: Empfänger hört nur den eigenen Sender
            decoder.AddEdges(edges);
            RunDecoder();
        }

        // Flanken, die seit dem letzten Aufruf auf den Leitungen lagen (für das Oszilloskop)
        public string GetEdges()
        {
            ulong now = clock.NowNs();
            var own = CurrentFormat();
            var partner = line != null ? line.TransmitFormat : null;
            return txRecorder.Format(now, BaudText(own), own.Name) + " " +
                   rxRecorder.Format(now, BaudText(partner), partner != null ? partner.Name : "-");
        }

        // ---- Senden -------------------------------------------------------------------------

        private void WriteData(byte c)
        {
            if((ctl & CtlUarten) == 0 || (ctl & CtlTxe) == 0)
            {
                this.Log(LogLevel.Warning,
                    "UART{0}: Zeichen 0x{1:X2} verworfen – UART bzw. Sender nicht eingeschaltet (UARTCTL: UARTEN, TXE).",
                    clockBit, c);
                return;
            }
            ulong now = clock.NowNs();
            DropStarted(now);
            if(txWaiting.Count >= FifoDepth)
            {
                this.Log(LogLevel.Warning,
                    "UART{0}: Sende-FIFO voll, Zeichen 0x{1:X2} verworfen (vor dem Schreiben UARTFR.TXFF prüfen).", clockBit, c);
                return;
            }
            var f = CurrentFormat();
            if(!f.Valid)
            {
                if(!formatWarned)
                {
                    this.Log(LogLevel.Warning,
                        "UART{0}: Zeichen 0x{1:X2} verworfen – keine Baudrate eingestellt (UARTIBRD/UARTFBRD).", clockBit, c);
                    formatWarned = true;
                }
                return;
            }

            if(breakActive)
            {
                // Während BRK bleibt die Leitung LOW; das Zeichen wartet im FIFO, bis BRK endet
                pendingDuringBreak.Enqueue(c);
                txWaiting.Enqueue(double.MaxValue);
                UpdateTxInterruptAfterWrite();
                return;
            }
            double start = Math.Max((double)now, txLineFreeNs);
            if(line != null) start = Math.Max(start, line.DecodedUntilNs);
            SendFrame(c, f, start);
            UpdateTxInterruptAfterWrite();
        }

        private void SendFrame(byte c, UartFrameFormat f, double start)
        {
            var edges = new List<SignalEdge>();
            double end = UartEncoder.Encode(start, c, f, edges);
            txLineFreeNs = end;
            txWaiting.Enqueue(start);
            DriveTx(edges);

            ulong startNs = (ulong)Math.Floor(start);
            ulong endNs = (ulong)Math.Ceiling(end);
            byte data = (byte)(c & ((1 << f.DataBits) - 1));
            clock.At(startNs, t => OnTxFrameStart(t), name + "-tx-start");
            clock.At(endNs, t => OnTxFrameEnd(t, data), name + "-tx-end");
        }

        // Legt Flanken auf den TX-Pin (bzw. bei Loopback direkt in den eigenen Empfänger)
        private void DriveTx(List<SignalEdge> edges)
        {
            if((ctl & CtlLbe) != 0)
            {
                decoder.AddEdges(edges);
                RunDecoder();
                return;
            }
            if(!TxPinOk())
            {
                if(!txPinWarned)
                {
                    this.Log(LogLevel.Warning,
                        "UART{0}: sendet, aber {1} ist nicht als U{0}TX geschaltet (GPIOAFSEL, GPIODEN, " +
                        "GPIOPCTL = {2}). Am Pin kommt nichts an.", clockBit, PinName(txPin), pinFunction);
                    txPinWarned = true;
                }
                return;
            }
            txPinWarned = false;
            txRecorder.Add(edges);
            if(line != null) line.LineEdges(edges);
        }

        private void SetBreak(bool on)
        {
            ulong now = clock.NowNs();
            var edges = new List<SignalEdge>();
            if(on)
            {
                // LOW nach dem gerade laufenden Zeichen
                double t = Math.Max((double)now, txLineFreeNs);
                breakActive = true;
                edges.Add(new SignalEdge((ulong)Math.Floor(t), false));
                txLineFreeNs = t;
            }
            else
            {
                breakActive = false;
                double t = Math.Max((double)now, txLineFreeNs + 1);
                edges.Add(new SignalEdge((ulong)Math.Floor(t), true));
                txLineFreeNs = t;
                // während BRK geschriebene Zeichen jetzt senden
                var f = CurrentFormat();
                var queued = pendingDuringBreak.ToArray();
                pendingDuringBreak.Clear();
                txWaiting.Clear();
                DriveTx(edges);
                edges = null;
                foreach(var c in queued)
                {
                    if(f.Valid) SendFrame(c, f, txLineFreeNs);
                }
            }
            if(edges != null) DriveTx(edges);
        }

        private void OnTxFrameStart(ulong t)
        {
            DropStarted(t);
            if((ctl & CtlEot) == 0 && txWaiting.Count <= TxThreshold)
            {
                ris |= IntTx;
            }
            UpdateInterrupts();
        }

        private void OnTxFrameEnd(ulong t, byte data)
        {
            DropStarted(t);
            if((ctl & CtlEot) != 0 && txWaiting.Count == 0 && t >= (ulong)Math.Floor(txLineFreeNs))
            {
                ris |= IntTx;
                UpdateInterrupts();
            }
            if(line == null && (ctl & CtlLbe) == 0 && TxPinOk())
            {
                TransmitCharacter(data);   // ohne Gegenstelle: Byte an ein Renode-Terminal
            }
        }

        // Zeichen, deren Frame bis now begonnen hat, sind aus dem FIFO ins Schieberegister gewandert
        private void DropStarted(ulong now)
        {
            while(txWaiting.Count > 0 && txWaiting.Peek() <= now) txWaiting.Dequeue();
        }

        private void UpdateTxInterruptAfterWrite()
        {
            if(txWaiting.Count > TxThreshold || (ctl & CtlEot) != 0) ris &= ~IntTx;
        }

        // ---- Empfangen ----------------------------------------------------------------------

        private void RunDecoder()
        {
            ulong now = clock.NowNs();
            ulong? wake = decoder.Process(now, OnRxFrame);
            if(wake.HasValue && wake.Value < rxWakeNs)
            {
                ulong at = wake.Value;
                rxWakeNs = at;
                clock.At(at, t =>
                {
                    if(rxWakeNs == at) rxWakeNs = ulong.MaxValue;
                    RunDecoder();
                }, name + "-rx");
            }
        }

        private void OnRxFrame(int value, UartErrors errors, ulong startNs, ulong stopNs)
        {
            if(!IsReceiveEnabled)
            {
                this.Log(LogLevel.Debug, "UART{0}: Empfänger aus, Zeichen 0x{1:X2} verworfen", clockBit, value);
                return;
            }
            uint flags = 0;
            if((errors & UartErrors.Framing) != 0) { flags |= DrFe; ris |= IntFe; }
            if((errors & UartErrors.Parity) != 0) { flags |= DrPe; ris |= IntPe; }
            if((errors & UartErrors.Break) != 0) { flags |= DrBe; ris |= IntBe; value = 0; }
            PushRx((uint)value | flags);
        }

        // Zeichen von außen als Byte (z. B. ein direkt verbundenes Renode-Terminal)
        protected override void WriteCharInner(byte value, UARTFrame frame)
        {
            if(!IsReceiveEnabled)
            {
                this.Log(LogLevel.Debug, "UART{0}: Empfänger aus, Zeichen 0x{1:X2} verworfen", clockBit, value);
                return;
            }
            PushRx(value);
        }

        private void PushRx(uint entry)
        {
            if(rxFifo.Count >= FifoDepth)
            {
                // Overrun: Zeichen geht verloren, das letzte Zeichen im FIFO bekommt OE
                rsr |= RsrOe;
                ris |= IntOe;
                if(rxFifo.Count > 0)
                {
                    var arr = rxFifo.ToArray();
                    arr[arr.Length - 1] |= DrOe;
                    rxFifo.Clear();
                    foreach(var x in arr) rxFifo.Enqueue(x);
                }
                this.Log(LogLevel.Warning, "UART{0}: Empfangs-FIFO voll, Zeichen 0x{1:X2} verworfen (Overrun)", clockBit, entry & 0xFF);
                UpdateInterrupts();
                return;
            }
            rxFifo.Enqueue(entry);
            UpdateInterrupts();
        }

        protected override void CharWritten()
        {
            UpdateInterrupts();
        }

        protected override void QueueEmptied()
        {
        }

        protected override bool IsReceiveEnabled
        {
            get { return (ctl & CtlUarten) != 0 && (ctl & CtlRxe) != 0; }
        }

        private uint ReadData()
        {
            if(rxFifo.Count == 0)
            {
                return 0;
            }
            uint entry = rxFifo.Dequeue();
            // RSR zeigt die Fehler des zuletzt gelesenen Zeichens (OE bleibt bis zum Löschen)
            rsr = (rsr & RsrOe) | ((entry >> 8) & 0x7);
            UpdateInterrupts();
            return entry;
        }

        // ---- Hilfen -------------------------------------------------------------------------

        private UartFrameFormat CurrentFormat()
        {
            int dataBits = 5 + (int)((lcrh >> 5) & 3);
            UartParity parity;
            if((lcrh & LcrhPen) == 0) parity = UartParity.None;
            else if((lcrh & LcrhSps) != 0) parity = (lcrh & LcrhEps) != 0 ? UartParity.Space : UartParity.Mark;
            else parity = (lcrh & LcrhEps) != 0 ? UartParity.Even : UartParity.Odd;
            int stop = (lcrh & LcrhStp2) != 0 ? 2 : 1;
            return new UartFrameFormat(LineBaudRate, dataBits, parity, stop);
        }

        private static string BaudText(UartFrameFormat f)
        {
            return f != null && f.Valid ? f.Baud.ToString("0.###", CultureInfo.InvariantCulture) : "0";
        }

        private bool TxPinOk()
        {
            return pinPort == null || txPin < 0 || pinPort.IsPinFunction(txPin, pinFunction);
        }

        private bool RxPinOk()
        {
            return pinPort == null || rxPin < 0 || pinPort.IsPinFunction(rxPin, pinFunction);
        }

        private string PinName(int pin)
        {
            return pinPort != null ? "P" + pinPort.PortName + pin : "der Pin";
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

        // TX-Interrupt, sobald höchstens so viele Zeichen im Sende-FIFO warten
        private int TxThreshold
        {
            get
            {
                if((lcrh & LcrhFen) == 0) return 0;
                switch(ifls & 7)
                {
                    case 0: return 2;   // <= 1/8
                    case 1: return 4;   // <= 1/4
                    case 2: return 8;   // <= 1/2
                    case 3: return 12;  // <= 3/4
                    default: return 14; // <= 7/8
                }
            }
        }

        private uint Flags()
        {
            ulong now = clock.NowNs();
            DropStarted(now);
            uint fr = 0;
            if(txWaiting.Count == 0) fr |= FrTxfe;
            if(txWaiting.Count >= FifoDepth) fr |= FrTxff;
            if(breakActive || now < txLineFreeNs || txWaiting.Count > 0) fr |= FrBusy;
            int count = rxFifo.Count;
            if(count == 0) fr |= FrRxfe;
            if(count >= FifoDepth) fr |= FrRxff;
            return fr;
        }

        private void UpdateInterrupts()
        {
            int count = rxFifo.Count;
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

        private const uint FrBusy = 1u << 3, FrRxfe = 1u << 4, FrTxff = 1u << 5, FrRxff = 1u << 6, FrTxfe = 1u << 7;
        private const uint LcrhBrk = 1u << 0, LcrhPen = 1u << 1, LcrhEps = 1u << 2, LcrhStp2 = 1u << 3,
                           LcrhFen = 1u << 4, LcrhSps = 1u << 7;
        private const uint CtlUarten = 1u << 0, CtlEot = 1u << 4, CtlHse = 1u << 5, CtlLbe = 1u << 7,
                           CtlTxe = 1u << 8, CtlRxe = 1u << 9;
        private const uint IntRx = 1u << 4, IntTx = 1u << 5, IntRt = 1u << 6, IntFe = 1u << 7, IntPe = 1u << 8,
                           IntBe = 1u << 9, IntOe = 1u << 10;
        private const uint RsrOe = 1u << 3;
        private const uint DrFe = 1u << 8, DrPe = 1u << 9, DrBe = 1u << 10, DrOe = 1u << 11;
        private const uint CcPiosc = 0x5;
        // alle Bits von UARTIM laut tm4c1294ncpdt.h außer DMA (UART_IM_..., 0..12)
        private const uint ImMask = 0x1FFF;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly TivaGPIOPort pinPort;
        private readonly int txPin, rxPin;
        private readonly uint pinFunction;
        private readonly VirtualClock clock;
        private readonly string name;
        private readonly SignalRecorder txRecorder, rxRecorder;
        private readonly UartLineDecoder decoder;
        private readonly Queue<uint> rxFifo = new Queue<uint>();
        // Startzeiten (ns) der Zeichen im Sende-FIFO, die noch nicht begonnen haben
        private readonly Queue<double> txWaiting = new Queue<double>();
        private readonly Queue<byte> pendingDuringBreak = new Queue<byte>();
        private IUartLineEndpoint line;
        private double txLineFreeNs;
        private bool breakActive;
        private ulong rxWakeNs;
        private uint rsr, ilpr, ibrd, fbrd, lcrh, ctl, ifls, im, ris, dmactl, cc;
        private bool clockWarned, formatWarned, txPinWarned, rxPinWarned;
        private Dictionary<long, uint> other;
    }
}
