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
                case Did0: return Did0Value;
                case Did1: return Did1Value;
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

        // Offsets und Feldwerte wie in tm4c1294ncpdt.h (SYSCTL_..._R, SYSCTL_DID0_..., SYSCTL_DID1_...);
        // geprüft mit tools/check_header.py
        private const long Did0 = 0x000, Did1 = 0x004;
        // DID0: VER_1 | CLASS_TM4C129 | MAJ_REVA | MIN_2 (Revision A2; driverlib erkennt am CLASS-Feld
        // einen TM4C129, z. B. in SysCtlClockFreqSet)
        private const uint Did0Value = 0x10000000 | 0x000A0000 | 0x00000000 | 0x00000002;
        // DID1: VER_1 | FAM_TIVA | PRTNO_TM4C1294NCPDT | PINCNT_128 | TEMP_I | PKG_QFP | ROHS | QUAL_FQ
        // (Bauteil auf dem EK-TM4C1294XL: TM4C1294NCPDTI)
        private const uint Did1Value = 0x10000000 | 0x00000000 | 0x001F0000 | 0x0000C000 | 0x00000020 |
                                       0x00000008 | 0x00000004 | 0x00000002;
        private const long RcgcBase = 0x600;
        private const long ScgcBase = 0x700;
        private const long DcgcBase = 0x800;
        private const long PrBase = 0xA00;
        private const int RegisterCount = 40;   // RCGCWD (0x600) ... RCGCEMAC (0x69C)

        private uint[] rcgc;
        private uint[] scgc;
        private uint[] dcgc;
        private Dictionary<long, uint> other;
    }
}
