// I2C-Modul des TM4C1294 im Master-Betrieb (I2C0..9, je 4 KB).
//
// Modelliert:
//  * Master-Register MSA, MCS, MDR, MTPR, MIMR, MRIS, MMIS, MICR, MCR, MBMON
//  * Einzelbyte-Übertragungen (Senden/Empfangen) mit START, RUN, STOP, ACK, Repeated Start
//  * Fehler: kein Gerät unter der Adresse -> MCS.ERROR + MCS.ADRACK (Adress-NACK)
//  * Master-Interrupt (MRIS.RIS) nach jedem Befehl -> IRQ zum NVIC
//  * Clock-Gating über RCGCI2C (Offset 0x620)
// Busgeräte (Renode II2CPeripheral) werden mit ihrer 7-Bit-Adresse angemeldet:
//     oled: Video.SSD1306I2C @ i2c0 0x3C
// Gesendete Bytes werden gesammelt und beim nächsten Lesen, Repeated Start oder STOP als ein
// Block an das Gerät übergeben; empfangene Bytes werden einzeln gelesen (Read(1)).
// Ein Befehl ist sofort fertig. Damit Programme, die nach dem Schreiben von MCS erst auf
// BUSY=1 und dann auf BUSY=0 warten (Erratum-Workaround), nicht hängen, liefert der erste
// Lesezugriff auf MCS nach einem Befehl noch BUSY=1.
// Nicht modelliert: Slave-Betrieb, FIFO/µDMA, Burst (MBLEN), Glitch-Filter, Zeitverhalten.
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Core.Structure;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Miscellaneous;

namespace Antmicro.Renode.Peripherals.I2C
{
    public class TivaI2C : SimpleContainer<II2CPeripheral>, IDoubleWordPeripheral, IKnownSize
    {
        // clockBit: Bit in RCGCI2C (I2C0 = 0 ... I2C9 = 9)
        public TivaI2C(IMachine machine, TivaSysCtl sysCtl, int clockBit) : base(machine)
        {
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            IRQ = new GPIO();
            txBuffer = new List<byte>();
            missingWarned = new HashSet<int>();
            Reset();
        }

        public long Size { get { return 0x1000; } }

        public GPIO IRQ { get; private set; }

        public uint ReadDoubleWord(long offset)
        {
            if(!ClockOk(offset)) return 0;
            switch(offset)
            {
                case Msa: return msa;
                case Mcs: return Status();
                case Mdr: return mdr;
                case Mtpr: return mtpr;
                case Mimr: return mimr;
                case Mris: return mris;
                case Mmis: return mris & mimr;
                case Mcr: return mcr;
                case Mclkocnt: return mclkocnt;
                case Mbmon: return 0x3;     // SCL und SDA high (Bus frei)
                case Pp: return 0x1;        // High-Speed-fähig
                case Pc: return 0x1;
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
                case Msa: msa = value & 0xFF; break;
                case Mcs: Command(value); break;
                case Mdr: mdr = value & 0xFF; break;
                case Mtpr: mtpr = value & 0xFF; break;
                case Mimr: mimr = value & 0xFF; break;
                case Micr: mris &= ~value; break;
                case Mcr: mcr = value & 0x3F; break;
                case Mclkocnt: mclkocnt = value & 0xFF; break;
                case Mris: case Mmis: case Mbmon: case Pp: break; // nur lesbar
                default: other[offset] = value; break;
            }
            UpdateInterrupt();
        }

        public override void Reset()
        {
            msa = mdr = mimr = mris = mcr = mclkocnt = 0;
            mtpr = 0x1;
            error = adrNack = dataNack = false;
            busBusy = false;
            busyReads = 0;
            current = null;
            currentAddress = -1;
            txBuffer.Clear();
            missingWarned.Clear();
            clockWarned = false;
            other = new Dictionary<long, uint>();
            if(IRQ != null) IRQ.Unset();
        }

        // MCS-Befehl ausführen (Bit 0 RUN, 1 START, 2 STOP, 3 ACK)
        private void Command(uint value)
        {
            if((mcr & McrMfe) == 0)
            {
                this.Log(LogLevel.Warning, "I2C{0}: MCS geschrieben, aber Master nicht freigegeben (I2CMCR.MFE = 0).", clockBit);
                return;
            }

            bool run = (value & CmdRun) != 0;
            bool start = (value & CmdStart) != 0;
            bool stop = (value & CmdStop) != 0;
            int address = (int)(msa >> 1);
            bool read = (msa & 1) != 0;

            if(start)
            {
                // Neuer Transfer bzw. Repeated Start
                if(current != null)
                {
                    FlushTx();
                    if(address != currentAddress)
                    {
                        current.FinishTransmission();
                    }
                }
                error = adrNack = dataNack = false;
                II2CPeripheral device;
                if(!TryGetByAddress(address, out device))
                {
                    if(missingWarned.Add(address))
                    {
                        this.Log(LogLevel.Warning, "I2C{0}: kein Gerät unter Adresse 0x{1:X2} (Adress-NACK). " +
                            "Weitere Zugriffe auf diese Adresse werden nicht mehr gemeldet.", clockBit, address);
                    }
                    current = null;
                    currentAddress = -1;
                    error = adrNack = true;
                    busBusy = false;
                    Finish();
                    return;
                }
                current = device;
                currentAddress = address;
                busBusy = true;
            }
            else if(current == null)
            {
                if(stop)
                {
                    busBusy = false;
                    Finish();
                    return;
                }
                this.Log(LogLevel.Warning, "I2C{0}: Befehl 0x{1:X} ohne vorheriges START ignoriert.", clockBit, value);
                error = true;
                Finish();
                return;
            }

            if(run)
            {
                if(read)
                {
                    FlushTx();
                    var data = current.Read(1);
                    // ACK=0 kennzeichnet das letzte Byte; für das Gerätemodell ohne Bedeutung
                    mdr = (data != null && data.Length > 0) ? data[0] : 0xFFu;
                }
                else
                {
                    txBuffer.Add((byte)mdr);
                }
            }

            if(stop)
            {
                FlushTx();
                current.FinishTransmission();
                current = null;
                currentAddress = -1;
                busBusy = false;
            }
            Finish();
        }

        private void FlushTx()
        {
            if(current != null && txBuffer.Count > 0)
            {
                current.Write(txBuffer.ToArray());
            }
            txBuffer.Clear();
        }

        private void Finish()
        {
            busyReads = 1;
            mris |= 1;          // RIS: Master-Interrupt
            UpdateInterrupt();
        }

        private uint Status()
        {
            uint s = 0;
            if(busyReads > 0)
            {
                busyReads--;
                s |= StBusy;
            }
            if(error) s |= StError;
            if(adrNack) s |= StAdrAck;
            if(dataNack) s |= StDatAck;
            if(busBusy) s |= StBusBsy; else s |= StIdle;
            return s;
        }

        private void UpdateInterrupt()
        {
            IRQ.Set((mris & mimr) != 0);
        }

        private bool ClockOk(long offset)
        {
            if(sysCtl.IsClockEnabled(RcgcI2c, clockBit))
            {
                clockWarned = false;
                return true;
            }
            if(!clockWarned)
            {
                this.Log(LogLevel.Warning,
                    "I2C{0}: Zugriff (Offset 0x{1:X}) ohne Takt! RCGCI2C Bit {0} muss gesetzt werden " +
                    "(SysCtlPeripheralEnable). Auf der Hardware führt das zu einem Fault.",
                    clockBit, offset);
                clockWarned = true;
            }
            return false;
        }

        private const long RcgcI2c = 0x620;
        private const long Msa = 0x000, Mcs = 0x004, Mdr = 0x008, Mtpr = 0x00C, Mimr = 0x010, Mris = 0x014,
                           Mmis = 0x018, Micr = 0x01C, Mcr = 0x020, Mclkocnt = 0x024, Mbmon = 0x02C,
                           Pp = 0xFC0, Pc = 0xFC4;
        private const uint CmdRun = 1u << 0, CmdStart = 1u << 1, CmdStop = 1u << 2, CmdAck = 1u << 3;
        private const uint StBusy = 1u << 0, StError = 1u << 1, StAdrAck = 1u << 2, StDatAck = 1u << 3,
                           StIdle = 1u << 5, StBusBsy = 1u << 6;
        private const uint McrMfe = 1u << 4;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly List<byte> txBuffer;
        private readonly HashSet<int> missingWarned;
        private uint msa, mdr, mtpr, mimr, mris, mcr, mclkocnt;
        private bool error, adrNack, dataNack, busBusy, clockWarned;
        private int busyReads;
        private II2CPeripheral current;
        private int currentAddress;
        private Dictionary<long, uint> other;
    }
}
