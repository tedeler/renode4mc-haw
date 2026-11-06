// System Control (SYSCTL) des TM4C1294 – Basis 0x400FE000.
//
// Modelliert wird das, was für Lehrbeispiele nötig ist:
//  * Clock-Gating:  RCGC*/SCGC*/DCGC* (Takt freigeben) und PR* (Peripherie bereit)
//  * Kennung DID0/DID1
// Alle anderen Register werden gespeichert und wieder gelesen (ohne Funktion).
// Die Takterzeugung (PLL, SysCtlClockFreqSet) ist NICHT modelliert: der Simulator läuft
// mit dem Reset-Takt PIOSC = 16 MHz.
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class TivaSysCtl : IDoubleWordPeripheral, IKnownSize
    {
        public TivaSysCtl(IMachine machine)
        {
            Reset();
        }

        // true, wenn im Register RCGC<offset> das Bit <bit> gesetzt ist.
        // rcgcOffset ist der Offset des RCGC-Registers, z. B. 0x608 für RCGCGPIO.
        public long Size { get { return 0x1000; } }

        public bool IsClockEnabled(long rcgcOffset, int bit)
        {
            return ((rcgc[(rcgcOffset - RcgcBase) / 4] >> bit) & 1) != 0;
        }

        public uint ReadDoubleWord(long offset)
        {
            if(offset >= RcgcBase && offset < RcgcBase + RegisterCount * 4)
            {
                return rcgc[(offset - RcgcBase) / 4];
            }
            if(offset >= ScgcBase && offset < ScgcBase + RegisterCount * 4)
            {
                return scgc[(offset - ScgcBase) / 4];
            }
            if(offset >= DcgcBase && offset < DcgcBase + RegisterCount * 4)
            {
                return dcgc[(offset - DcgcBase) / 4];
            }
            if(offset >= PrBase && offset < PrBase + RegisterCount * 4)
            {
                // Peripherie ist sofort "bereit", sobald der Takt freigegeben ist.
                return rcgc[(offset - PrBase) / 4];
            }

            switch(offset)
            {
                case 0x000: return 0x180F0000; // DID0: Klasse TM4C129
                case 0x004: return 0x10A1A000; // DID1
                default:
                    uint value;
                    other.TryGetValue(offset, out value);
                    return value;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset >= RcgcBase && offset < RcgcBase + RegisterCount * 4)
            {
                rcgc[(offset - RcgcBase) / 4] = value;
            }
            else if(offset >= ScgcBase && offset < ScgcBase + RegisterCount * 4)
            {
                scgc[(offset - ScgcBase) / 4] = value;
            }
            else if(offset >= DcgcBase && offset < DcgcBase + RegisterCount * 4)
            {
                dcgc[(offset - DcgcBase) / 4] = value;
            }
            else if(offset >= PrBase && offset < PrBase + RegisterCount * 4)
            {
                // PR* sind nur lesbar.
            }
            else
            {
                other[offset] = value;
            }
        }

        public void Reset()
        {
            rcgc = new uint[RegisterCount];
            scgc = new uint[RegisterCount];
            dcgc = new uint[RegisterCount];
            other = new Dictionary<long, uint>();
        }

        private const long RcgcBase = 0x600;
        private const long ScgcBase = 0x700;
        private const long DcgcBase = 0x800;
        private const long PrBase = 0xA00;
        private const int RegisterCount = 32;

        private uint[] rcgc;
        private uint[] scgc;
        private uint[] dcgc;
        private Dictionary<long, uint> other;
    }
}
