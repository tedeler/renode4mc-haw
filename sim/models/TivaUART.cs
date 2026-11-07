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
// Anschluss im Renode-Monitor, z. B.:
//   emulation CreateServerSocketTerminal 3335 "term" false
//   connector Connect sysbus.uart0 term
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
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
                    lcrh = value & 0xFF;
                    break;
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
            clockWarned = false;
            other = new Dictionary<long, uint>();
            if(IRQ != null) IRQ.Unset();
        }

        // Zeichen von außen (Terminal): bei vollem FIFO verwerfen und Overrun melden (wie Hardware)
        protected override void WriteCharInner(byte value, UARTFrame frame)
        {
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
            TransmitCharacter(c);
            ris |= IntTx;   // Sendepuffer sofort wieder frei
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
        private const uint CtlUarten = 1u << 0, CtlHse = 1u << 5, CtlTxe = 1u << 8, CtlRxe = 1u << 9;
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
    }
}
