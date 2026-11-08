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
            // WFI-Hook möglichst vor dem ersten Befehl setzen: Der Hook meldet nur Wechsel – wer ihn
            // erst setzt, während die CPU schon schläft, hält sie bis zum Aufwachen für wach
            machine.PeripheralsChanged += (m, e) =>
            {
                if(wfiHooked) return;
                var cpu = machine.GetPeripheralsOfType(typeof(ICPU)).Cast<ICPU>().FirstOrDefault();
                if(cpu != null) HookWfi(cpu);
            };
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
                ResetCpuStats();   // erst hier: auch der Befehlszähler der CPU ist jetzt zurückgesetzt
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
        // CPU-Zustand: Running, Paused, Step (Einzelschritt), Wake (Schritt über WFI, läuft bis zum
        // nächsten Interrupt), InReset, Aborted, ...; halted = wartet (z. B. WFI);
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
                      : machine.IsPaused ? "Paused"
                      : haltOnWake ? "Wake"     // Schritt über WFI: läuft bis zum Aufwachen (StepCpu)
                      : cpu.EmulationState.ToString();
                halted = cpu.IsHalted || inWfi || enteringWfi;
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
            // Nach dem Reset läuft die CPU ab dem Reset-Handler (kein WFI mehr); der Hook meldet das
            // nicht von selbst
            inWfi = false;
            enteringWfi = false;
            haltOnWake = false;
            ResetCpuStats();
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
        // ---- Einzelschritt wie am Debugger ------------------------------------------------------

        // "sysbus.sysctl StepCpu <n> [<budgetMs>]" -> "SS:<erledigt>:<Zustand>:<PC hex>"
        //   erledigt = abgearbeitete Schritte (<= n), Zustand:
        //     ok   alle n Schritte erledigt, CPU hält an
        //     more Zeitbudget (Wanduhr) aufgebraucht, CPU hält an – Rest mit neuem Aufruf
        //     wfi  CPU schläft und ist bis zum Budgetende nicht aufgewacht: sie LÄUFT weiter (mit
        //          aller Peripherie) und hält beim Aufwachen von selbst an (CancelStep bricht ab)
        // Renodes "cpu Step" rechnet bei schlafender CPU (WFI) je Schritt nur eine Befehlszeit
        // (1/PerformanceInMips, z. B. 91 ns) weiter – bis zum nächsten Timer-Interrupt wären
        // Tausende bis Millionen Schritte nötig. Am echten Board endet der WFI-Befehl erst mit dem
        // Interrupt. Deshalb hier: Schläft die CPU, läuft die ganze Simulation (Timer, UART, Pendel
        // …) bis zum Aufwachen weiter; das Aufwachen zählt als ein Schritt, danach steht die CPU vor
        // dem ersten Befehl der Interrupt-Routine.
        public string StepCpu(int count, int budgetMs = 1500)
        {
            var tcpu = machine.GetPeripheralsOfType(typeof(ICPU)).Cast<ICPU>().FirstOrDefault() as TranslationCPU;
            if(tcpu == null) return "SS:0:err:00000000";
            HookWfi(tcpu);
            count = Math.Max(1, Math.Min(count, 100000));
            var watch = System.Diagnostics.Stopwatch.StartNew();
            int done = 0;
            string state = "ok";
            while(done < count)
            {
                if(inWfi || enteringWfi)
                {
                    if(!RunUntilWake(tcpu, Math.Max(1, budgetMs - (int)watch.ElapsedMilliseconds)))
                    {
                        state = "wfi";
                        break;
                    }
                    done++;
                    continue;
                }
                if(watch.ElapsedMilliseconds >= budgetMs)
                {
                    state = "more";
                    break;
                }
                // In Stücken, damit das Budget eingehalten wird und WFI bald erkannt wird. Gerät die
                // CPU mitten im Stück in den WFI, verstreichen die restlichen Schritte als Schlafzeit
                // (je eine Befehlszeit) – ein Interrupt in dieser Zeit weckt sie wie gewohnt. Gezählt
                // werden nur wirklich ausgeführte Befehle.
                int chunk = Math.Min(count - done, StepChunk);
                ulong before = tcpu.ExecutedInstructions;
                tcpu.Step(chunk);
                int executed = (int)Math.Min((ulong)chunk, tcpu.ExecutedInstructions - before);
                done += (inWfi || enteringWfi) ? executed : chunk;
            }
            return string.Format("SS:{0}:{1}:{2:X8}", done, state, tcpu.PC.RawValue);
        }

        // Wartendes "bis zum Aufwachen" (StepCpu mit Zustand wfi) aufheben, z. B. vor "Weiter"
        public void CancelStep()
        {
            haltOnWake = false;
        }

        // Nach einem WFI meldet Renode das Einschlafen erst, wenn die CPU weiterrechnen will – im
        // Einzelschritt also erst beim nächsten Schritt. Der WFI-Befehl selbst wird deshalb über einen
        // Opcode-Hook erkannt (Thumb WFI = 0xBF30): "schläft gleich ein".
        private const ulong WfiOpcode = 0xBF30;

        // true = CPU ist aufgewacht und steht im Einzelschrittmodus; false = schläft noch nach
        // waitMs Wanduhrzeit (läuft dann weiter und hält beim Aufwachen an)
        private bool RunUntilWake(TranslationCPU tcpu, int waitMs)
        {
            woke.Reset();
            haltOnWake = true;
            if(enteringWfi)
            {
                // Schläft die CPU doch nicht ein (Interrupt schon anhängig), hält sie am Befehl danach
                ArmStop(tcpu, tcpu.PC.RawValue);
            }
            tcpu.ExecutionMode = ExecutionMode.Continuous;
            if(machine.IsPaused)
            {
                EmulationManager.Instance.CurrentEmulation.StartAll();
            }
            return woke.Wait(waitMs);
        }

        // Anhalten genau vor dem nächsten Befehl nach dem Aufwachen: Renode prüft den
        // Einzelschrittmodus nur zwischen übersetzten Blöcken – die ganze Interrupt-Routine liefe
        // sonst noch durch. Deshalb ein Adress-Hook (wie ein Haltepunkt des Debuggers) auf den
        // Befehl hinter dem WFI und, wenn ein Interrupt angenommen wird, auf dessen Routine.
        // Die Hooks bleiben stehen (wenige Adressen) und wirken nur, solange haltOnWake gesetzt ist:
        // Renode übernimmt das Entfernen und erneute Setzen am selben Ort nicht zuverlässig.
        private void ArmStop(TranslationCPU tcpu, ulong address)
        {
            lock(stopHooks)
            {
                if(stopHooks.Contains(address)) return;
                stopHooks.Add(address);
            }
            tcpu.AddHook(address, stopHook);
        }

        private void OnStopHook(ICpuSupportingGdb cpu, ulong address)
        {
            if(!haltOnWake) return;
            haltOnWake = false;
            enteringWfi = false;
            ((TranslationCPU)cpu).EnterSingleStepModeSafely(new HaltArguments(HaltReason.Step, cpu, address, null));
            woke.Set();
        }

        private const ulong IcsrAddress = 0xE000ED04;   // NVIC_INT_CTRL_R

        // Einsprungadresse der Ausnahme exception (Nummer wie INT_xxx, Vektortabelle ab VTOR)
        private ulong HandlerAddress(TranslationCPU tcpu, ulong exception)
        {
            var cm = tcpu as CortexM;
            ulong vtor = cm != null ? cm.VectorTableOffset : 0;
            return machine.SystemBus.ReadDoubleWord(vtor + 4 * exception) & ~1UL;
        }

        // WFI (CPU schläft bis zum nächsten Interrupt) meldet Renode nur über einen Hook
        private void HookWfi(ICPU cpu)
        {
            if(wfiHooked) return;
            var tcpu = cpu as TranslationCPU;
            if(tcpu == null) return;
            stopHook = OnStopHook;
            tcpu.AddPostOpcodeExecutionHook(0xFFFF, WfiOpcode, (pc, opcode) => enteringWfi = true);
            tcpu.EnablePostOpcodeExecutionHooks(true);
            tcpu.AddHookAtWfiStateChange(isInWfi =>
            {
                StatWfi(isInWfi);
                inWfi = isInWfi;
                enteringWfi = false;
                if(!isInWfi && haltOnWake) ArmStop(tcpu, tcpu.PC.RawValue);
            });
            // Der Parameter ist Renodes interne Ausnahmeart (IRQ = 5), nicht die Vektornummer;
            // welche Ausnahme angenommen wird, steht in ICSR.VECTPENDING
            tcpu.AddHookAtInterruptBegin(kind =>
            {
                enteringWfi = false;
                uint vector = (machine.SystemBus.ReadDoubleWord(IcsrAddress) >> 12) & 0x1FF;
                StatIsrBegin(vector, tcpu.ExecutedInstructions);
                if(!haltOnWake) return;
                if(vector != 0) ArmStop(tcpu, HandlerAddress(tcpu, vector));
            });
            tcpu.AddHookAtInterruptEnd(kind => StatIsrEnd(tcpu.ExecutedInstructions));
            wfiHooked = true;
        }

        // ---- Statistik: Anteil Schlaf (WFI) / Interrupt-Routinen / Normalbetrieb ----------------
        //
        // "sysbus.sysctl GetCpuStats" -> "CS:<Zeit ns>:<Befehle>:<Schlaf ns>:<ISR-Befehle>:<ISR-Aufrufe>:
        //   <Aufwachen>:<schläft 0/1>:<ISR-Tiefe>:<MIPS>:<Vektor>=<Aufrufe>/<Befehle>,…"
        // Alles seit ResetCpuStats (Reset der MCU, Start). Schlafzeit = virtuelle Zeit zwischen
        // Einschlafen und Aufwachen (laufender Schlaf bis jetzt mitgezählt). Die Wachzeit wird nach
        // ausgeführten Befehlen geteilt: Befehle zwischen Interrupt-Eintritt und Rücksprung zählen
        // zur ISR (verschachtelt: je Vektor ohne die inneren), der Rest zum Normalbetrieb. Renodes
        // Zeitraster ist 1 µs – eine ISR dauert oft nur wenige µs, Befehle sind genauer.
        // Nicht modelliert: Stapeln beim Eintritt (am Board 12 Takte), Wartezyklen des Flash.
        public string GetCpuStats()
        {
            ulong now = machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
            var cpu = machine.GetPeripheralsOfType(typeof(ICPU)).Cast<ICPU>().FirstOrDefault() as TranslationCPU;
            ulong instr = cpu != null ? cpu.ExecutedInstructions : 0;
            if(cpu != null) HookWfi(cpu);
            var sb = new System.Text.StringBuilder();
            lock(statLock)
            {
                ulong sleep = statSleepNs;
                if(statSleeping && now > statSleepSince) sleep += now - statSleepSince;
                ulong isrInstr = statIsrInstr;
                // laufende ISR bis jetzt mitzählen
                if(isrStack.Count > 0) isrInstr += instr - isrStack[0].Start;
                sb.AppendFormat("CS:{0}:{1}:{2}:{3}:{4}:{5}:{6}:{7}:{8}:",
                    now - statStartNs, instr - statStartInstr, sleep, isrInstr, statIsrCount, statWakes,
                    statSleeping ? 1 : 0, isrStack.Count, cpu != null ? cpu.PerformanceInMips : 0);
                bool first = true;
                foreach(var kv in vectorStats)
                {
                    if(!first) sb.Append(',');
                    first = false;
                    sb.AppendFormat("{0}={1}/{2}", kv.Key, kv.Value.Count, kv.Value.Instr);
                }
            }
            return sb.ToString();
        }

        public void ResetCpuStats()
        {
            ulong now = machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
            var cpu = machine.GetPeripheralsOfType(typeof(ICPU)).Cast<ICPU>().FirstOrDefault();
            lock(statLock)
            {
                statStartNs = now;
                statStartInstr = cpu != null ? cpu.ExecutedInstructions : 0;
                statSleepNs = 0;
                statSleepSince = now;
                statSleeping = inWfi;
                statIsrInstr = 0;
                statIsrCount = 0;
                statWakes = 0;
                vectorStats.Clear();
                isrStack.Clear();
            }
        }

        private void StatWfi(bool sleeping)
        {
            ulong now = machine.LocalTimeSource.ElapsedVirtualTime.Ticks;
            lock(statLock)
            {
                if(sleeping && !statSleeping)
                {
                    statSleepSince = now;
                }
                else if(!sleeping && statSleeping)
                {
                    if(now > statSleepSince) statSleepNs += now - statSleepSince;
                    statWakes++;
                }
                statSleeping = sleeping;
            }
        }

        private void StatIsrBegin(uint vector, ulong instr)
        {
            lock(statLock)
            {
                if(isrStack.Count >= MaxIsrDepth) isrStack.RemoveAt(isrStack.Count - 1);   // Schutz, falls ein Ende fehlt
                isrStack.Add(new IsrFrame { Vector = vector, Start = instr });
                statIsrCount++;
                VectorStat v;
                if(!vectorStats.TryGetValue(vector, out v)) vectorStats[vector] = v = new VectorStat();
                v.Count++;
            }
        }

        private void StatIsrEnd(ulong instr)
        {
            lock(statLock)
            {
                if(isrStack.Count == 0) return;
                var f = isrStack[isrStack.Count - 1];
                isrStack.RemoveAt(isrStack.Count - 1);
                ulong incl = instr - f.Start;
                VectorStat v;
                if(vectorStats.TryGetValue(f.Vector, out v)) v.Instr += incl > f.Child ? incl - f.Child : 0;
                if(isrStack.Count > 0) isrStack[isrStack.Count - 1].Child += incl;
                else statIsrInstr += incl;
            }
        }

        private class IsrFrame
        {
            public uint Vector;
            public ulong Start;
            public ulong Child;
        }

        private class VectorStat
        {
            public ulong Count;
            public ulong Instr;
        }

        private const int MaxIsrDepth = 16;
        private readonly object statLock = new object();
        private readonly List<IsrFrame> isrStack = new List<IsrFrame>();
        private readonly SortedDictionary<uint, VectorStat> vectorStats = new SortedDictionary<uint, VectorStat>();
        private ulong statStartNs, statStartInstr, statSleepNs, statSleepSince, statIsrInstr, statIsrCount, statWakes;
        private bool statSleeping;

        private CpuAddressHook stopHook;
        private readonly HashSet<ulong> stopHooks = new HashSet<ulong>();
        private const int StepChunk = 50;
        private readonly System.Threading.ManualResetEventSlim woke = new System.Threading.ManualResetEventSlim(false);
        private volatile bool haltOnWake;
        private volatile bool enteringWfi;

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
