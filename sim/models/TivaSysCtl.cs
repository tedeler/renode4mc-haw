// System Control (SYSCTL) des TM4C1294 – Basis 0x400FE000.
//
// Modelliert wird das, was für Lehrbeispiele nötig ist:
//  * Clock-Gating:  RCGC*/SCGC*/DCGC* (Takt freigeben) und PR* (Peripherie bereit)
//  * Kennung DID0/DID1
//  * Systemtakt aus RSCLKCFG/PLLFREQ0/PLLFREQ1 (Property SystemClockFrequency, z. B. für die
//    Baudrate der UARTs). PLLSTAT.LOCK und RIS.PLLLRIS/MOSCPUPRIS lesen sich immer als 1, damit
//    SysCtlClockFreqSet nicht hängen bleibt. Die CPU selbst läuft unverändert weiter (Renode
//    rechnet Befehle, keine Takte).
// Alle anderen Register werden gespeichert und wieder gelesen (ohne Funktion).
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class TivaSysCtl : IDoubleWordPeripheral, IKnownSize
    {
        // moscFrequency: Quarz am Hauptoszillator (EK-TM4C1294XL: 25 MHz)
        public TivaSysCtl(IMachine machine, uint moscFrequency = 25000000)
        {
            this.moscFrequency = moscFrequency;
            Reset();
        }

        // Systemtakt in Hz laut RSCLKCFG (Reset: PIOSC 16 MHz)
        public double SystemClockFrequency
        {
            get
            {
                uint cfg = rsclkcfg;
                if((cfg & RsclkcfgUsepll) != 0)
                {
                    double fin = SourceFrequency((cfg >> 24) & 0xF);
                    double m = (pllfreq0 & 0x3FF) + ((pllfreq0 >> 10) & 0x3FF) / 1024.0;
                    double q = ((pllfreq1 >> 8) & 0x1F) + 1;
                    double n = (pllfreq1 & 0x1F) + 1;
                    double vco = fin * m / (q * n);
                    return vco / ((cfg & 0x3FF) + 1);
                }
                return SourceFrequency((cfg >> 20) & 0xF) / (((cfg >> 10) & 0x3FF) + 1);
            }
        }

        private double SourceFrequency(uint source)
        {
            switch(source)
            {
                case 2: return 33000;            // LFIOSC (ca.)
                case 3: return moscFrequency;    // MOSC
                case 4: return 32768;            // RTC
                default: return 16000000;        // PIOSC
            }
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
                case Ris: return risAlways;
                case Rsclkcfg: return rsclkcfg;
                case Pllfreq0: return pllfreq0;
                case Pllfreq1: return pllfreq1;
                case Pllstat: return PllstatLock;
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
                switch(offset)
                {
                    // MEMTIMU und NEWFREQ lösen nur etwas aus und lesen sich als 0
                    case Rsclkcfg: rsclkcfg = value & ~(RsclkcfgMemtimu | RsclkcfgNewfreq); break;
                    case Pllfreq0: pllfreq0 = value; break;
                    case Pllfreq1: pllfreq1 = value; break;
                    default: other[offset] = value; break;
                }
            }
        }

        public void Reset()
        {
            rcgc = new uint[RegisterCount];
            scgc = new uint[RegisterCount];
            dcgc = new uint[RegisterCount];
            other = new Dictionary<long, uint>();
            rsclkcfg = pllfreq0 = pllfreq1 = 0;
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
        private const long Ris = 0x050, Rsclkcfg = 0x0B0, Pllfreq0 = 0x160, Pllfreq1 = 0x164, Pllstat = 0x168;
        private const uint RsclkcfgMemtimu = 0x80000000, RsclkcfgNewfreq = 0x40000000, RsclkcfgUsepll = 0x10000000;
        private const uint PllstatLock = 0x00000001;
        // RIS: PLL eingerastet (PLLLRIS), Hauptoszillator angelaufen (MOSCPUPRIS)
        private const uint RisPlllris = 0x00000040, RisMoscpupris = 0x00000100;
        private const uint risAlways = RisPlllris | RisMoscpupris;
        private const long RcgcBase = 0x600;
        private const long ScgcBase = 0x700;
        private const long DcgcBase = 0x800;
        private const long PrBase = 0xA00;
        private const int RegisterCount = 40;   // RCGCWD (0x600) ... RCGCEMAC (0x69C)

        private uint[] rcgc;
        private uint[] scgc;
        private uint[] dcgc;
        private Dictionary<long, uint> other;
        private uint rsclkcfg, pllfreq0, pllfreq1;
        private readonly uint moscFrequency;
    }
}
