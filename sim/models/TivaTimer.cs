// General-Purpose Timer (GPTM) des TM4C1294, Timer0..7 (je 4 KB), nach Datenblatt SPMS433 Kap. 13.
//
// Modelliert (je Hälfte A/B):
//  * GPTMCFG = 0x0 (32 Bit, nur Timer A) und 0x4 (16 Bit, A und B getrennt)
//  * One-Shot (TnMR = 0x1) und Periodic (TnMR = 0x2), abwärts und aufwärts (TnCDIR), Tabelle 13-4:
//      abwärts: Start bei TnILR (16 Bit: Prescaler TnPR als "true prescaler", zählt zuerst ab),
//               Time-out bei 0, Periode = (TnILR + 1) * (TnPR + 1)
//      aufwärts: Start bei 0, Time-out bei TnILR (16 Bit: TnPR = Bits 23:16, lineare Erweiterung),
//               Periode = (TnPR:TnILR) + 1
//    One-Shot: nach dem Time-out wird der Startwert geladen und TnEN gelöscht.
//  * Zählerstand: TnR (Bits 15:0 im 16-Bit-Modus) und TnV (im 16-Bit-Modus Bits 23:16 = Prescaler);
//    vor dem ersten Start die Reset-Werte aus dem Datenblatt (TAR/TAV 0xFFFF.FFFF, TBR/TBV 0xFFFF)
//  * TnILR schreiben während der Timer läuft: TnILD = 0 -> neuer Wert ab dem nächsten Takt,
//    TnILD = 1 -> ab dem nächsten Time-out
//  * Time-out-Interrupt: IMR, RIS, MIS, ICR -> IRQA / IRQB zum NVIC, TnCINTD unterdrückt TnTORIS
//  * TnMATCHR / TnPMR werden gespeichert
//  * Clock-Gating über RCGCTIMER (Offset 0x604)
// Nicht modelliert (Warnung, sobald die Firmware es benutzt): Capture (TnMR = 0x3), PWM (TnAMS),
// RTC (CFG = 0x1), Match-Interrupt (TnMIE), Wait-on-Trigger, Snapshot, ADC-/uDMA-Trigger.
//
// Strenge Prüfung (Warnungen erscheinen in der Web-Konsole unter "Diagnose"):
//  * CFG oder TnMR geändert, während ein Timer läuft (Datenblatt 13.4: vorher TnEN = 0)
//  * reservierte bzw. nicht modellierte Betriebsarten und Bits
//  * TnILR > 0xFFFF oder TnPR > 0xFF im 16-Bit-Modus, TnPR im 32-Bit-Modus, Timer B im 32-Bit-Modus
//  * Timer ohne Startwert (TnILR = 0) gestartet
// Der Timer läuft mit 16 MHz (PIOSC, Reset-Takt).
using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Miscellaneous;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Timers
{
    public class TivaTimer : IDoubleWordPeripheral, IKnownSize
    {
        public TivaTimer(IMachine machine, TivaSysCtl sysCtl, int clockBit, ulong frequency = 16000000)
        {
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            this.frequency = frequency;
            IRQA = new GPIO();
            IRQB = new GPIO();
            timers = new[]
            {
                new LimitTimer(machine.ClockSource, frequency, this, "A", 1, Direction.Descending,
                    enabled: false, workMode: WorkMode.Periodic, eventEnabled: true),
                new LimitTimer(machine.ClockSource, frequency, this, "B", 1, Direction.Descending,
                    enabled: false, workMode: WorkMode.Periodic, eventEnabled: true),
            };
            timers[0].LimitReached += () => OnTimeout(0);
            timers[1].LimitReached += () => OnTimeout(1);
            Reset();
        }

        public long Size { get { return 0x1000; } }

        public GPIO IRQA { get; private set; }
        public GPIO IRQB { get; private set; }

        public uint ReadDoubleWord(long offset)
        {
            if(!ClockOk()) return 0;
            switch(offset)
            {
                case Cfg: return cfg;
                case TamR: return mr[0];
                case TbmR: return mr[1];
                case Ctl: return ctl;
                case Imr: return imr;
                case Ris: return ris;
                case Mis: return ris & imr;
                case TailR: return ilr[0];
                case TbilR: return ilr[1];
                case TamatchR: return match[0];
                case TbmatchR: return match[1];
                case TapR: return pr[0];
                case TbpR: return pr[1];
                case TapmR: return pmr[0];
                case TbpmR: return pmr[1];
                case TaR: return Counter(0, false);
                case TbR: return Counter(1, false);
                case TaV: return Counter(0, true);
                case TbV: return Counter(1, true);
                case Pp: return 0x0; // 16/32-Bit-Timer (SIZE = 0)
                case Cc: return cc;
                case Sync: return 0;
                default:
                    // Anzeige der Web-Konsole (alle Register des Moduls) liest still
                    if(!Antmicro.Renode.Peripherals.Miscellaneous.TivaSysCtl.Peeking)
                    {
                        this.Log(LogLevel.Warning, "Timer: Lesen von Offset 0x{0:X3} wird nicht unterstützt (liefert 0)", offset);
                    }
                    return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk()) return;
            switch(offset)
            {
                case Cfg:
                    if((ctl & (CtlTaen | CtlTben)) != 0)
                    {
                        Warn("cfgRun", "GPTMCFG geändert, während der Timer läuft (TAEN/TBEN = 1). Datenblatt: Timer zuerst ausschalten (GPTMCTL).");
                    }
                    cfg = value & CfgMask;
                    if(cfg != 0 && cfg != 4)
                    {
                        Warn("cfg" + cfg, cfg == 1
                            ? "GPTMCFG = 0x1 (RTC) ist im Simulator nicht modelliert."
                            : string.Format("GPTMCFG = 0x{0:X} ist reserviert (erlaubt: 0x0 = 32 Bit, 0x1 = RTC, 0x4 = 16 Bit).", cfg));
                    }
                    break;
                case TamR: WriteMode(0, value); break;
                case TbmR: WriteMode(1, value); break;
                case Ctl:
                    if((value & ~(CtlTaen | CtlTastall | CtlTben | CtlTbstall)) != 0)
                    {
                        Warn("ctlBits", string.Format("GPTMCTL = 0x{0:X}: Bits außer TnEN/TnSTALL (Ereignis, RTC, PWM, Trigger) sind nicht modelliert.", value));
                    }
                    uint old = ctl;
                    ctl = value & 0x7F7F;
                    if((ctl & CtlTaen) != 0 && (old & CtlTaen) == 0) CheckStart(0);
                    if((ctl & CtlTben) != 0 && (old & CtlTben) == 0) CheckStart(1);
                    Apply(0, (old & CtlTaen) == 0);
                    Apply(1, (old & CtlTben) == 0);
                    break;
                case Imr:
                    if((value & ~(ImTatoim | ImTbtoim)) != 0)
                    {
                        Warn("imrBits", string.Format("GPTMIMR = 0x{0:X}: nur die Time-out-Interrupts (TATOIM, TBTOIM) sind modelliert, Capture-/Match-/RTC-Interrupts kommen nie.", value));
                    }
                    imr = value & ImrMask;
                    break;
                case Icr: ris &= ~value; break;
                case TailR: WriteLoad(0, value); break;
                case TbilR: WriteLoad(1, value); break;
                case TamatchR: match[0] = value; break;
                case TbmatchR: match[1] = value; break;
                case TapR: WritePrescale(0, value); break;
                case TbpR: WritePrescale(1, value); break;
                case TapmR: pmr[0] = value & 0xFF; break;
                case TbpmR: pmr[1] = value & 0xFF; break;
                case Cc:
                    cc = value & 1;
                    if(cc != 0) Warn("altclk", "GPTMCC.ALTCLK = 1 (alternativer Takt) ist im Simulator nicht modelliert: der Timer läuft weiter mit dem Systemtakt.");
                    break;
                case Sync:
                    if(value != 0) Warn("sync", "GPTMSYNC ist im Simulator nicht modelliert (ignoriert).");
                    break;
                case TaV: case TbV:
                    Warn("tvWrite", "Schreiben von GPTMTnV ist im Simulator nicht modelliert (ignoriert).");
                    break;
                case Ris: case Mis: case TaR: case TbR:
                    Warn("ro" + offset, string.Format("Schreiben auf Offset 0x{0:X3}: Register ist nur lesbar (ignoriert).", offset));
                    break;
                default:
                    this.Log(LogLevel.Warning, "Timer: Schreiben auf Offset 0x{0:X3} wird nicht unterstützt (ignoriert)", offset);
                    break;
            }
            UpdateIrq();
        }

        public void Reset()
        {
            foreach(var t in timers) t.Enabled = false;
            cfg = 0; ctl = 0; imr = 0; ris = 0; cc = 0;
            mr = new uint[2];
            ilr = new uint[] { 0xFFFFFFFF, 0xFFFF };
            pr = new uint[2];
            match = new uint[] { 0xFFFFFFFF, 0xFFFF };
            pmr = new uint[2];
            pendingLoad = new bool[2];
            started = new bool[2];
            stopped = new bool[2];
            clockWarned = false;
            warned = new HashSet<string>();
            IRQA.Unset();
            IRQB.Unset();
        }

        private void WriteMode(int half, uint value)
        {
            if((ctl & (half == 0 ? CtlTaen : CtlTben)) != 0)
            {
                Warn("mrRun" + half, string.Format("GPTMT{0}MR geändert, während Timer {0} läuft. Datenblatt: Timer zuerst ausschalten (T{0}EN = 0).", Name(half)));
            }
            mr[half] = value & MrMask;
            uint mode = value & TnmrMask;
            string n = Name(half);
            if(mode == 0) Warn("mr0" + half, string.Format("GPTMT{0}MR: T{0}MR = 0x0 ist reserviert (0x1 = One-Shot, 0x2 = Periodic).", n));
            if(mode == 3) Warn("mr3" + half, string.Format("GPTMT{0}MR: Capture-Modus (T{0}MR = 0x3) ist im Simulator nicht modelliert.", n));
            if((value & MrAms) != 0) Warn("ams" + half, string.Format("GPTMT{0}MR: PWM-Modus (T{0}AMS) ist im Simulator nicht modelliert.", n));
            if((value & MrMie) != 0) Warn("mie" + half, string.Format("GPTMT{0}MR: Match-Interrupt (T{0}MIE) ist im Simulator nicht modelliert.", n));
            if((value & (MrWot | MrSnaps | MrPwmie | MrMrsu | MrPlo)) != 0)
            {
                Warn("mrx" + half, string.Format("GPTMT{0}MR = 0x{1:X}: Wait-on-Trigger, Snapshot, PWM-Interrupt, MRSU und PLO sind nicht modelliert.", n, value));
            }
        }

        private void WriteLoad(int half, uint value)
        {
            if(cfg == 4 && value > 0xFFFF)
            {
                Warn("ilr16" + half, string.Format("GPTMT{0}ILR = 0x{1:X} im 16-Bit-Modus: nur Bits 15:0 zählen (Rest ignoriert). Größere Werte: Prescaler GPTMT{0}PR oder 32-Bit-Modus.", Name(half), value));
            }
            if(half == 1 && cfg == 0)
            {
                Warn("tbilr32", "GPTMTBILR im 32-Bit-Modus geschrieben: Timer B gibt es nur im 16-Bit-Modus (GPTMCFG = 0x4).");
            }
            ilr[half] = cfg == 4 ? value & 0xFFFF : value;
            Reload(half);
        }

        private void WritePrescale(int half, uint value)
        {
            if(value > 0xFF)
            {
                Warn("pr8" + half, string.Format("GPTMT{0}PR = 0x{1:X}: der Prescaler hat nur 8 Bit (Rest ignoriert).", Name(half), value));
            }
            pr[half] = value & 0xFF;
            Reload(half);
        }

        // TnILR/TnPR geschrieben: läuft der Timer, gilt der Wert ab dem nächsten Takt (TnILD = 0)
        // bzw. ab dem nächsten Time-out (TnILD = 1)
        private void Reload(int half)
        {
            if(!timers[half].Enabled) return;
            if((mr[half] & MrIld) != 0)
            {
                pendingLoad[half] = true;
                return;
            }
            Apply(half, true);
        }

        // Prüfungen beim Einschalten (TnEN 0 -> 1)
        private void CheckStart(int half)
        {
            string n = Name(half);
            if(half == 1 && cfg == 0)
            {
                Warn("tb32", "TBEN gesetzt, aber GPTMCFG = 0x0 (32 Bit): Timer B läuft nur im 16-Bit-Modus (GPTMCFG = 0x4).");
                return;
            }
            if(cfg == 0 && pr[0] != 0)
            {
                Warn("pr32", "GPTMTAPR != 0 im 32-Bit-Modus: der Prescaler wirkt nur im 16-Bit-Modus (GPTMCFG = 0x4).");
            }
            if(ilr[half] == 0 && (cfg != 4 || pr[half] == 0))
            {
                Warn("ilr0" + half, string.Format("Timer {0} gestartet mit GPTMT{0}ILR = 0: kein sinnvoller Startwert/Endwert gesetzt.", n));
            }
            uint mode = mr[half] & TnmrMask;
            if(mode != TnmrOneShot && mode != TnmrPeriodic)
            {
                Warn("start" + half, string.Format("Timer {0} gestartet ohne gültige Betriebsart (GPTMT{0}MR = 0x{1:X}): der Timer bleibt stehen.", n, mr[half]));
            }
        }

        private bool Up(int half)
        {
            return (mr[half] & MrCdir) != 0;
        }

        // Takte pro Periode (Tabelle 13-4)
        private ulong Ticks(int half)
        {
            if(cfg != 4) return (ulong)ilr[0] + 1;
            ulong load = ilr[half] & 0xFFFF;
            ulong pre = pr[half] & 0xFF;
            return Up(half) ? ((pre << 16) | load) + 1 : (load + 1) * (pre + 1);
        }

        // Zählerstand wie GPTMTnR (value = false) bzw. GPTMTnV (value = true).
        // Der LimitTimer zählt die verbleibenden Takte der Periode abwärts (Ticks .. 1).
        private uint Counter(int half, bool value)
        {
            if(!started[half])
            {
                return half == 0 ? 0xFFFFFFFF : 0xFFFF; // Reset-Werte
            }
            bool up = Up(half);
            if(stopped[half])
            {
                // One-Shot abgelaufen: Startwert ist geladen (abwärts TnILR/TnPR, aufwärts 0)
                if(up) return 0;
                if(cfg != 4) return ilr[0];
                return value ? (((pr[half] & 0xFF) << 16) | (ilr[half] & 0xFFFF)) : ilr[half] & 0xFFFF;
            }
            ulong ticks = Ticks(half);
            ulong remaining = Math.Min(ticks, Math.Max(1UL, timers[half].Value));
            ulong elapsed = ticks - remaining;                // 0 .. ticks-1
            if(cfg != 4)
            {
                return (uint)(up ? elapsed : ilr[0] - elapsed);
            }
            if(up)
            {
                // Prescaler = Bits 23:16 des Zählers (lineare Erweiterung); TnR zeigt nur 15:0
                return value ? (uint)(elapsed & 0xFFFFFF) : (uint)(elapsed & 0xFFFF);
            }
            // Abwärts: "true prescaler" zählt von TnPR bis 0, erst dann zählt der Zähler um 1 weiter
            ulong scale = (pr[half] & 0xFF) + 1;
            uint counter = (uint)((ilr[half] & 0xFFFF) - elapsed / scale);
            uint prescale = (uint)((pr[half] & 0xFF) - elapsed % scale);
            return value ? ((prescale & 0xFF) << 16) | (counter & 0xFFFF) : counter & 0xFFFF;
        }

        // half: 0 = Timer A, 1 = Timer B; restart: Zähler neu laden (Einschalten bzw. TnILR geändert)
        private void Apply(int half, bool restart)
        {
            var timer = timers[half];
            bool enable = (ctl & (half == 0 ? CtlTaen : CtlTben)) != 0;
            uint mode = mr[half] & TnmrMask;
            if(cfg == 0 && half == 1) enable = false; // Timer B gibt es nur im 16-Bit-Modus
            if(mode != TnmrOneShot && mode != TnmrPeriodic) enable = false; // reserviert / Capture: nicht modelliert

            if(!enable)
            {
                timer.Enabled = false;               // TnEN = 0: Zähler bleibt stehen
                return;
            }
            ulong ticks = Ticks(half);
            bool wasRunning = timer.Enabled;
            timer.Enabled = false;
            timer.Limit = ticks;
            timer.Mode = mode == TnmrOneShot ? WorkMode.OneShot : WorkMode.Periodic;
            if(restart || !wasRunning || timer.Value > ticks)
            {
                timer.ResetValue();                  // Startwert laden (Tabelle 13-4)
            }
            pendingLoad[half] = false;
            started[half] = true;
            stopped[half] = false;
            timer.Enabled = true;
        }

        private void OnTimeout(int half)
        {
            if((mr[half] & MrCintd) == 0)
            {
                ris |= half == 0 ? RisTatoris : RisTbtoris;
            }
            if((mr[half] & TnmrMask) == TnmrOneShot)
            {
                ctl &= ~(half == 0 ? CtlTaen : CtlTben);          // One-Shot: Timer schaltet sich ab (TnEN = 0)
                stopped[half] = true;
            }
            else if(pendingLoad[half])
            {
                pendingLoad[half] = false;           // TnILD = 1: neuer Startwert ab jetzt
                timers[half].Limit = Ticks(half);
            }
            UpdateIrq();
        }

        private void UpdateIrq()
        {
            IRQA.Set((ris & imr & 0xFF) != 0);
            IRQB.Set((ris & imr & 0xFF00) != 0);
        }

        private void Warn(string key, string message)
        {
            if(warned.Add(key))
            {
                this.Log(LogLevel.Warning, "Timer: {0}", message);
            }
        }

        private static string Name(int half)
        {
            return half == 0 ? "A" : "B";
        }

        private bool ClockOk()
        {
            if(sysCtl.IsClockEnabled(RcgcTimer, clockBit))
            {
                clockWarned = false;
                return true;
            }
            if(TivaSysCtl.PeekClockOff()) return false;
            if(!clockWarned)
            {
                this.Log(LogLevel.Warning,
                    "Timer: Zugriff ohne Takt! RCGCTIMER Bit {0} muss gesetzt werden (SysCtlPeripheralEnable). " +
                    "Auf der Hardware führt das zu einem Fault.", clockBit);
                clockWarned = true;
            }
            return false;
        }

        // Register-Offsets und Bits wie in tm4c1294ncpdt.h (TIMERn_..._R, TIMER_...); geprüft mit
        // tools/check_header.py
        private const long RcgcTimer = 0x604;
        private const long Cfg = 0x000, TamR = 0x004, TbmR = 0x008, Ctl = 0x00C, Imr = 0x018, Ris = 0x01C,
                           Mis = 0x020, Icr = 0x024, TailR = 0x028, TbilR = 0x02C, TamatchR = 0x030,
                           TbmatchR = 0x034, TapR = 0x038, TbpR = 0x03C, TapmR = 0x040, TbpmR = 0x044,
                           TaR = 0x048, TbR = 0x04C, TaV = 0x050, TbV = 0x054, Sync = 0x010, Pp = 0xFC0, Cc = 0xFC8;
        private const uint CtlTaen = 1u << 0, CtlTastall = 1u << 1, CtlTben = 1u << 8, CtlTbstall = 1u << 9;
        private const uint MrAms = 1u << 3, MrCdir = 1u << 4, MrMie = 1u << 5, MrWot = 1u << 6, MrSnaps = 1u << 7,
                           MrIld = 1u << 8, MrPwmie = 1u << 9, MrMrsu = 1u << 10, MrPlo = 1u << 11, MrCintd = 1u << 12;
        private const uint MrMask = 0x1FFF;                                  // TnMR .. TnCINTD (Bits 12:0)
        private const uint CfgMask = 0x7;                                    // TIMER_CFG_M
        private const uint TnmrMask = 0x3, TnmrOneShot = 0x1, TnmrPeriodic = 0x2;
        private const uint RisTatoris = 1u << 0, RisTbtoris = 1u << 8;
        private const uint ImTatoim = 1u << 0, ImTbtoim = 1u << 8;
        // Time-out-, Capture-, Match- und RTC-Bits von A und B (DMA/Wake-up nicht modelliert)
        private const uint ImrMask = 0x0F1F;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly ulong frequency;
        private readonly LimitTimer[] timers;
        private uint cfg, ctl, imr, ris, cc;
        private uint[] mr, ilr, pr, match, pmr;
        private bool[] pendingLoad, started, stopped;
        private bool clockWarned;
        private HashSet<string> warned;
    }
}
