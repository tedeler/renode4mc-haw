// System Control (SYSCTL) des TM4C1294 – Basis 0x400FE000.
//
// Modelliert wird das, was für Lehrbeispiele nötig ist:
//  * Clock-Gating:  RCGC*/SCGC*/DCGC* (Takt freigeben) und PR* (Peripherie bereit)
//  * Kennung DID0/DID1
//  * Reset-Taster des Boards: ResetMcu() (siehe dort)
//  * Zustand für die Anzeige der Web-Konsole: GetStatus(), GetCpuRegisters(), ReadMemory(),
//    PeekRegisters() (siehe dort). PeekRegisters liest Peripherie-Register ohne Nebenwirkung: Die
//    Tiva-Modelle fragen TivaSysCtl.Peeking ab (z. B. UARTDR nimmt dann nichts aus dem FIFO) und
//    melden bei fehlendem Takt keine Warnung.
//  * Systemtakt aus RSCLKCFG/PLLFREQ0/PLLFREQ1 (Property SystemClockFrequency, z. B. für die
//    Baudrate der UARTs). PLLSTAT.LOCK und RIS.PLLLRIS/MOSCPUPRIS lesen sich immer als 1, damit
//    SysCtlClockFreqSet nicht hängen bleibt. Die CPU selbst läuft unverändert weiter (Renode
//    rechnet Befehle, keine Takte).
// Alle anderen Register werden gespeichert und wieder gelesen (ohne Funktion).
using System;
using System.Collections.Generic;
using System.Linq;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class TivaSysCtl : IDoubleWordPeripheral, IKnownSize
    {
        // moscFrequency: Quarz am Hauptoszillator (EK-TM4C1294XL: 25 MHz)
        public TivaSysCtl(IMachine machine, uint moscFrequency = 25000000)
        {
            this.machine = machine;
            this.moscFrequency = moscFrequency;
            Reset();
        }

        // Reset-Taster des Boards (RESET, SW5): setzt CPU und alle Peripherie AUF DEM CHIP zurück,
        // also alles, was direkt am Systembus hängt. Die Firmware im Flash bleibt erhalten, die CPU
        // startet neu über die Vektortabelle (SP, Reset-Handler). Geräte außerhalb des Chips
        // (PC-Terminal, Sensor, OLED, Pendel, Keypad, LED-Brücke) behalten ihren Zustand.
        //   sysbus.sysctl ResetMcu
        public void ResetMcu()
        {
            IPeripheral bus = machine.SystemBus;
            var keep = new List<IPeripheral>();
            foreach(var p in machine.GetPeripheralsOfType(typeof(IPeripheral)))
            {
                if(!machine.GetParentPeripherals(p).Any(x => ReferenceEquals(x, bus))) keep.Add(p);
            }
            machine.RequestResetInSafeState(() =>
            {
                resetCount++;
                lastResetNs = machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
                this.Log(LogLevel.Info, "Reset-Taster: Mikrocontroller neu gestartet");
            }, keep);
        }

        // ---- Lesen ohne Nebenwirkung (Anzeige) ---------------------------------------------------

        // true, solange PeekRegisters auf DIESEM Thread liest (der CPU-Thread ist nie betroffen)
        public static bool Peeking { get { return peeking; } }

        // Für die Modelle: Zugriff ohne Takt während Peeking -> still merken statt warnen
        public static bool PeekClockOff()
        {
            if(!peeking) return false;
            peekNoClock = true;
            return true;
        }

        // "PR:<adr>=<wert|->;..." – adressen: "4000C000,4000C018,..." (hex). "-" = Modul ohne Takt
        public string PeekRegisters(string addresses)
        {
            var sb = new System.Text.StringBuilder("PR:");
            peeking = true;
            try
            {
                foreach(var part in addresses.Split(','))
                {
                    ulong a;
                    if(!ulong.TryParse(part.Trim(), System.Globalization.NumberStyles.HexNumber, null, out a)) continue;
                    peekNoClock = false;
                    uint v = machine.SystemBus.ReadDoubleWord(a);
                    sb.Append(a.ToString("X8")).Append('=').Append(peekNoClock ? "-" : v.ToString("X8")).Append(';');
                }
            }
            finally
            {
                peeking = false;
            }
            return sb.ToString();
        }

        // "MEM:<adr hex>:<Bytes hex>" – nur Flash und SRAM (Peripherie über PeekRegisters)
        public string ReadMemory(ulong address, int count)
        {
            count = Math.Max(1, Math.Min(count, 4096));
            bool flash = address < FlashSize && address + (ulong)count <= FlashSize;
            bool sram = address >= SramBase && address + (ulong)count <= SramBase + SramSize;
            if(!flash && !sram)
            {
                return "MEM:ERR:nur Flash 0x00000000-0x000FFFFF und SRAM 0x20000000-0x2003FFFF lesbar, Peripherie im Reiter Peripherie";
            }
            var bytes = machine.SystemBus.ReadBytes(address, count, true);
            return "MEM:" + address.ToString("X8") + ":" + BitConverter.ToString(bytes).Replace("-", "");
        }

        // "CR:R0=<hex>;...;PC=<hex>;xPSR=<hex>;..." – Kernregister des Cortex-M4
        public string GetCpuRegisters()
        {
            var cpu = machine.GetPeripheralsOfType(typeof(ICPUWithRegisters)).Cast<ICPUWithRegisters>().FirstOrDefault();
            if(cpu == null) return "CR:";
            var sb = new System.Text.StringBuilder("CR:");
            foreach(var r in cpu.GetRegisters())
            {
                if(r.Aliases == null || r.Aliases.Length == 0) continue;
                string name = r.Aliases[0];
                string shown;
                if(!ShownRegisters.TryGetValue(name, out shown)) continue;
                sb.Append(shown).Append('=').Append(cpu.GetRegister(r.Index).RawValue.ToString("X8")).Append(';');
            }
            return sb.ToString();
        }

        private static readonly Dictionary<string, string> ShownRegisters = new Dictionary<string, string>
        {
            {"R0", "R0"}, {"R1", "R1"}, {"R2", "R2"}, {"R3", "R3"}, {"R4", "R4"}, {"R5", "R5"}, {"R6", "R6"},
            {"R7", "R7"}, {"R8", "R8"}, {"R9", "R9"}, {"R10", "R10"}, {"R11", "R11"}, {"R12", "R12"},
            {"SP", "SP"}, {"LR", "LR"}, {"PC", "PC"}, {"CPSR", "xPSR"}, {"PRIMASK", "PRIMASK"},
            {"FAULTMASK", "FAULTMASK"}, {"BasePri", "BASEPRI"}, {"Control", "CONTROL"}, {"OtherSP", "SP_inaktiv"},
        };

        // "ST:<Zeit ns>:<Reset-Anzahl>:<letzter Reset ns>:<Systemtakt Hz>:<CPU-Zustand>:<halted 0/1>:
        //  <Befehle>:<PC hex>:<Funktion am PC>"
        // CPU-Zustand: Running, Paused, InReset, Aborted, ...; halted = wartet (z. B. WFI);
        // Funktion = Symbol aus der ELF-Datei (leer, wenn unbekannt)
        public string GetStatus()
        {
            ulong now = machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
            string state = "-", symbol = "";
            ulong pc = 0, instr = 0;
            bool halted = false;
            var cpu = machine.GetPeripheralsOfType(typeof(ICPU)).Cast<ICPU>().FirstOrDefault();
            if(cpu != null)
            {
                HookWfi(cpu);
                state = cpu.ExecutionMode == ExecutionMode.SingleStep ? "Step"
                      : machine.IsPaused ? "Paused" : cpu.EmulationState.ToString();
                halted = cpu.IsHalted || inWfi;
                instr = cpu.ExecutedInstructions;
                pc = cpu.PC.RawValue;
                string name;
                Antmicro.Renode.Core.Symbol sym;
                if(machine.SystemBus.TryFindSymbolAt(pc, out name, out sym, cpu, true)) symbol = name ?? "";
            }
            return string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "ST:{0}:{1}:{2}:{3:0}:{4}:{5}:{6}:{7:X8}:{8}", now, resetCount, lastResetNs, SystemClockFrequency,
                state, halted ? 1 : 0, instr, pc, symbol.Replace(':', '.').Replace(' ', '_'));
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
        // WFI (CPU schläft bis zum nächsten Interrupt) meldet Renode nur über einen Hook
        private void HookWfi(ICPU cpu)
        {
            if(wfiHooked) return;
            var tcpu = cpu as TranslationCPU;
            if(tcpu == null) return;
            tcpu.AddHookAtWfiStateChange(isInWfi => inWfi = isInWfi);
            wfiHooked = true;
        }

        [ThreadStatic] private static bool peeking;
        [ThreadStatic] private static bool peekNoClock;
        private const ulong FlashSize = 0x100000, SramBase = 0x20000000, SramSize = 0x40000;
        private volatile bool inWfi;
        private bool wfiHooked;
        private readonly IMachine machine;
        private int resetCount;
        private ulong lastResetNs;
    }
}
