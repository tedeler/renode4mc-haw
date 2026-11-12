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
//  * Timer Compare Action (13.3.3.1, TCACT in GPTMTnMR, nur One-Shot/Periodic mit TnAMS = 0): beim
//    Time-out wird der CCP-Pin gesetzt, gelöscht oder umgeschaltet; TCACT 0x4..0x7 setzen/löschen ihn
//    zusätzlich sofort (beim Schreiben von GPTMTnMR und beim Einschalten). TCACT darf sich bei
//    laufendem Timer ändern. 16 Bit: Timer A -> CCP0, Timer B -> CCP1; 32 Bit: nur CCP0.
//  * PWM (13.3.3.5, TnAMS = 1, TnCMR = 0, TnMR = 0x2, nur 16 Bit): 24-Bit-Abwärtszähler TnPR:TnILR,
//    Ausgang HIGH beim Laden, LOW bei Zähler = TnPMR:TnMATCHR; TnPWML invertiert den Pin.
//    MATCH > ILR: immer HIGH; MATCH = ILR: TnPLO = 1 immer LOW, sonst immer HIGH (Bild 13-5/13-6).
//    TnMRSU: neuer Match-Wert ab dem nächsten Takt bzw. ab dem nächsten Time-out.
//    TnPWMIE + TnEVENT: CnERIS bei steigender/fallender/beiden Flanken (des nicht invertierten Signals).
//  * Input Edge-Time (13.3.3.4, TnMR = 0x3, TnCMR = 1, nur 16 Bit): 24-Bit-Zähler TnPR:TnILR
//    (abwärts ab TnPR:TnILR, aufwärts ab 0, modulo Periode), eine Flanke nach TnEVENT am CCP-Pin
//    speichert den Zählerstand in TnR (Bits 23:0) und TnPS (Bits 23:16) und setzt CnERIS.
//    TnV ist der freilaufende Zähler. Kein Time-out-Interrupt in dieser Betriebsart.
//  * Zählerstand: TnR (Bits 15:0 im 16-Bit-Modus, in PWM/Edge-Time Bits 23:0) und TnV (im 16-Bit-Modus
//    Bits 23:16 = Prescaler); vor dem ersten Start die Reset-Werte (TAR/TAV 0xFFFF.FFFF, TBR/TBV 0xFFFF)
//  * TnILR schreiben während der Timer läuft: TnILD = 0 -> neuer Wert ab dem nächsten Takt,
//    TnILD = 1 -> ab dem nächsten Time-out
//  * Match (13.3.3.1/13.3.3.2, One-Shot/Periodic): mit TnMIE = 1 setzt der Zähler beim Erreichen von
//    GPTMTnMATCHR (16 Bit zusätzlich GPTMTnPMR) TnMRIS – ohne TnMIE nie (anders als TnTORIS).
//    32 Bit: Wert = TAMATCHR; 16 Bit aufwärts: TnPMR:TnMATCHR (24 Bit), abwärts: TnMATCHR und
//    Prescaler-Stand = TnPMR. Match-Wert außerhalb des Zählbereichs: kein Ereignis. TnMRSU wie bei PWM.
//  * Interrupts: IMR, RIS, MIS, ICR (Time-out, Match und Capture-Event) -> IRQA / IRQB zum NVIC,
//    TnCINTD unterdrückt TnTORIS
//  * CCP-Pins nach Tabelle 13-2 (GPIOPCTL = 3), werden selbst gefunden (sysbus.gpioX). Ein Pin wirkt
//    nur mit GPIOAFSEL = 1, GPIODEN = 1 und PCTL = 3 – sonst sieht der Pin nichts vom Timer.
//  * Clock-Gating über RCGCTIMER (Offset 0x604)
// Nicht modelliert (Warnung, sobald die Firmware es benutzt): Input Edge-Count (TnMR = 0x3, TnCMR = 0),
// RTC (CFG = 0x1), Capture-Match (CnMIM), Wait-on-Trigger, Snapshot, ADC-/uDMA-Trigger, SYNC.
//
// Strenge Prüfung (Warnungen erscheinen in der Web-Konsole unter "Diagnose"):
//  * CFG oder TnMR (außer TCACT) geändert, während ein Timer läuft (Datenblatt 13.4: vorher TnEN = 0)
//  * reservierte bzw. nicht modellierte Betriebsarten und Bits, PWM/Capture im 32-Bit-Modus
//  * TnILR > 0xFFFF oder TnPR > 0xFF im 16-Bit-Modus, TnPR im 32-Bit-Modus, Timer B im 32-Bit-Modus
//  * Timer ohne Startwert (TnILR = 0) gestartet
//  * CCP-Betriebsart (Compare-Action, PWM, Capture) gestartet, aber kein CCP-Pin auf PCTL = 3
// Der Timer läuft mit 16 MHz (PIOSC, Reset-Takt).
using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;
using Antmicro.Renode.Peripherals.GPIOPort;
using Antmicro.Renode.Peripherals.Miscellaneous;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Timers
{
    public class TivaTimer : IDoubleWordPeripheral, IKnownSize
    {
        public TivaTimer(IMachine machine, TivaSysCtl sysCtl, int clockBit, ulong frequency = 16000000)
        {
            this.machine = machine;
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            this.frequency = frequency;
            tickUs = 1e6 / frequency;
            IRQA = new GPIO();
            IRQB = new GPIO();
            timers = new[]
            {
                new LimitTimer(machine.ClockSource, frequency, this, "A", 1, Direction.Descending,
                    enabled: false, workMode: WorkMode.Periodic, eventEnabled: true),
                new LimitTimer(machine.ClockSource, frequency, this, "B", 1, Direction.Descending,
                    enabled: false, workMode: WorkMode.Periodic, eventEnabled: true),
            };
            timers[0].LimitReached += () => OnLimit(0);
            timers[1].LimitReached += () => OnLimit(1);
            Reset();
        }

        public long Size { get { return 0x1000; } }

        public GPIO IRQA { get; private set; }
        public GPIO IRQB { get; private set; }

        // Monitor: Zustand der CCP-Pins, z. B. "CCP0=PL4:1 CCP1=-"
        public string CcpPins
        {
            get
            {
                FindPins();
                var parts = new List<string>();
                for(int h = 0; h < 2; h++)
                {
                    var used = new List<string>();
                    foreach(var c in ccp[h])
                    {
                        if(c.Port.IsPinFunction(c.Pin, (uint)CcpFunction)) used.Add(c.Name);
                    }
                    parts.Add(string.Format("CCP{0}={1}:{2}", h, used.Count > 0 ? string.Join("+", used) : "-", PinLevel(h) ? 1 : 0));
                }
                return string.Join(" ", parts);
            }
        }

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
                case TaPs: return run[0] == Kind.EdgeTime ? (captured[0] >> 16) & 0xFF : 0;
                case TbPs: return run[1] == Kind.EdgeTime ? (captured[1] >> 16) & 0xFF : 0;
                case Pp: return 0x0; // 16/32-Bit-Timer (SIZE = 0)
                case Cc: return cc;
                case Sync: return 0;
                default:
                    // Anzeige der Web-Konsole (alle Register des Moduls) liest still
                    if(!TivaSysCtl.Peeking)
                    {
                        this.Log(LogLevel.Warning, "Timer: Lesen von Offset 0x{0:X3} wird nicht unterstützt (liefert 0)", offset);
                    }
                    return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk()) return;
            FindPins();
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
                    UpdateDrive(0);
                    UpdateDrive(1);
                    break;
                case TamR: WriteMode(0, value); break;
                case TbmR: WriteMode(1, value); break;
                case Ctl: WriteControl(value); break;
                case Imr:
                    if((value & ~(ImTatoim | ImTbtoim | ImCaeim | ImCbeim | ImTamim | ImTbmim)) != 0)
                    {
                        Warn("imrBits", string.Format("GPTMIMR = 0x{0:X}: modelliert sind Time-out (TnTOIM), Match (TnMIM) und Capture-Event (CnEIM); Capture-Match- und RTC-Interrupts kommen nie.", value));
                    }
                    imr = value & ImrMask;
                    break;
                case Icr: ris &= ~value; break;
                case TailR: WriteLoad(0, value); break;
                case TbilR: WriteLoad(1, value); break;
                case TamatchR: WriteMatch(0, value, false); break;
                case TbmatchR: WriteMatch(1, value, false); break;
                case TapR: WritePrescale(0, value); break;
                case TbpR: WritePrescale(1, value); break;
                case TapmR: WriteMatch(0, value, true); break;
                case TbpmR: WriteMatch(1, value, true); break;
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
                case Ris: case Mis: case TaR: case TbR: case TaPs: case TbPs:
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
            matchEff = new uint[] { 0xFFFFFFFF, 0xFFFF };
            pmrEff = new uint[2];
            pendingMatch = new bool[2];
            pendingLoad = new bool[2];
            started = new bool[2];
            stopped = new bool[2];
            run = new Kind[2];
            curIlr = new uint[2];
            curPr = new uint[2];
            seg = new int[2];
            segOff = new ulong[2];
            segLen = new ulong[2];
            segStartUs = new double[2];
            ccpState = new bool[2];
            captured = new uint[] { 0xFFFFFFFF, 0xFFFF };
            clockWarned = false;
            warned = new HashSet<string>();
            IRQA.Unset();
            IRQB.Unset();
            if(ccp != null)
            {
                UpdateDrive(0);
                UpdateDrive(1);
            }
        }

        // ---- Register schreiben -------------------------------------------------------------

        private void WriteMode(int half, uint value)
        {
            string n = Name(half);
            uint old = mr[half];
            // Datenblatt (GPTMTnMR): außer TCACT nur bei TnEN = 0 ändern
            if((ctl & EnBit(half)) != 0 && ((old ^ value) & MrMask & ~MrTcact) != 0)
            {
                Warn("mrRun" + half, string.Format("GPTMT{0}MR geändert, während Timer {0} läuft. Datenblatt: außer TCACT nur bei T{0}EN = 0 ändern.", n));
            }
            mr[half] = value & MrMask;
            if((value & ~MrMask) != 0) Warn("mrRes" + half, string.Format("GPTMT{0}MR = 0x{1:X}: Bits 31:16 sind reserviert.", n, value));
            uint mode = value & TnmrMask;
            bool ams = (value & MrAms) != 0, cmr = (value & MrCmr) != 0;
            if(mode == 0) Warn("mr0" + half, string.Format("GPTMT{0}MR: T{0}MR = 0x0 ist reserviert (0x1 = One-Shot, 0x2 = Periodic, 0x3 = Capture).", n));
            if(mode == 3 && !cmr && !ams) Warn("mrEc" + half, string.Format("GPTMT{0}MR: Input Edge-Count (T{0}MR = 0x3, T{0}CMR = 0) ist im Simulator nicht modelliert.", n));
            if(ams && (cmr || mode == 3)) Warn("ams" + half, string.Format("GPTMT{0}MR = 0x{1:X}: PWM braucht T{0}AMS = 1, T{0}CMR = 0 und T{0}MR = 0x2 (Datenblatt 13.4.5).", n, value));
            if(!ams && cmr && mode != 3) Warn("cmr" + half, string.Format("GPTMT{0}MR = 0x{1:X}: T{0}CMR = 1 wirkt nur im Capture-Modus (T{0}MR = 0x3).", n, value));
            if((value & MrTcact) != 0 && (ams || mode == 3))
            {
                Warn("tcact" + half, string.Format("GPTMT{0}MR: TCACT wirkt nur in One-Shot/Periodic mit T{0}AMS = 0 (nicht in PWM/Capture).", n));
            }
            if((value & MrMie) != 0 && (ams || mode == 3))
            {
                Warn("mie" + half, string.Format("GPTMT{0}MR: T{0}MIE wirkt nur in One-Shot/Periodic (nicht in PWM/Capture); im Simulator ignoriert.", n));
            }
            if((value & (MrWot | MrSnaps)) != 0)
            {
                Warn("mrx" + half, string.Format("GPTMT{0}MR = 0x{1:X}: Wait-on-Trigger und Snapshot sind nicht modelliert.", n, value));
            }
            UpdateDrive(half);
            if(CompareActive(half)) ImmediateAction(half, -1);
        }

        private void WriteControl(uint value)
        {
            if((value & ~(CtlTaen | CtlTastall | CtlTaevent | CtlTapwml | CtlTben | CtlTbstall | CtlTbevent | CtlTbpwml)) != 0)
            {
                Warn("ctlBits", string.Format("GPTMCTL = 0x{0:X}: RTCEN und Ausgangs-Trigger (TnOTE) sind nicht modelliert.", value));
            }
            for(int h = 0; h < 2; h++)
            {
                if(((value >> (8 * h + 2)) & 3) == 2)
                {
                    Warn("event2" + h, string.Format("GPTMCTL: T{0}EVENT = 0x2 ist reserviert (0x0 steigend, 0x1 fallend, 0x3 beide).", Name(h)));
                }
            }
            uint old = ctl;
            ctl = value & 0x7F7F;
            bool startA = (ctl & CtlTaen) != 0 && (old & CtlTaen) == 0;
            bool startB = (ctl & CtlTben) != 0 && (old & CtlTben) == 0;
            if(startA) CheckStart(0);
            if(startB) CheckStart(1);
            // beide Hälften im selben Takt starten (ein Schreibzugriff auf GPTMCTL)
            double now = (startA || startB || (((old ^ ctl) & (CtlTapwml | CtlTbpwml)) != 0)) ? NowUs() : 0;
            Apply(0, startA, now);
            Apply(1, startB, now);
            if(((old ^ ctl) & CtlTapwml) != 0) SetPin(0, now);
            if(((old ^ ctl) & CtlTbpwml) != 0) SetPin(1, now);
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

        // GPTMTnMATCHR (prescale = false) bzw. GPTMTnPMR (true)
        private void WriteMatch(int half, uint value, bool prescale)
        {
            if(prescale)
            {
                if(value > 0xFF) Warn("pmr8" + half, string.Format("GPTMT{0}PMR = 0x{1:X}: nur Bits 7:0 zählen.", Name(half), value));
                pmr[half] = value & 0xFF;
            }
            else
            {
                match[half] = value;
            }
            bool counting = run[half] == Kind.OneShot || run[half] == Kind.Periodic;
            bool running = timers[half].Enabled && (run[half] == Kind.Pwm || counting);
            if(running && (mr[half] & MrMrsu) != 0)
            {
                pendingMatch[half] = true;           // TnMRSU = 1: ab dem nächsten Time-out
                return;
            }
            matchEff[half] = match[half];
            pmrEff[half] = pmr[half];
            pendingMatch[half] = false;
            if(!running) return;
            if(run[half] == Kind.Pwm) PwmMatchChanged(half);   // TnMRSU = 0: ab dem nächsten Takt
            else CountMatchChanged(half);
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
            Apply(half, true, NowUs());
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
            var kind = KindOf(half);
            if(kind == Kind.None)
            {
                Warn("start" + half, string.Format("Timer {0} gestartet ohne gültige bzw. modellierte Betriebsart (GPTMCFG = 0x{1:X}, GPTMT{0}MR = 0x{2:X}): der Timer bleibt stehen.", n, cfg, mr[half]));
                return;
            }
            if((kind == Kind.Pwm || kind == Kind.EdgeTime || CompareActive(half)) && !PinConfigured(half))
            {
                string pins = string.Join(", ", ccp[half].ConvertAll(c => c.Name));
                Warn("pin" + half, string.Format("Timer {0} nutzt den CCP-Pin T{1}CCP{2}, aber keiner der möglichen Pins ({3}) ist dafür eingestellt " +
                    "(Takt des Ports, GPIOAFSEL = 1, GPIODEN = 1, GPIOPCTL = 3).", n, clockBit, half, pins.Length > 0 ? pins : "keine"));
            }
        }

        // ---- Betriebsart ---------------------------------------------------------------------

        private enum Kind { None, OneShot, Periodic, Pwm, EdgeTime }

        private Kind KindOf(int half)
        {
            if(cfg != 0 && cfg != 4) return Kind.None;          // RTC / reserviert
            if(cfg == 0 && half == 1) return Kind.None;         // Timer B nur im 16-Bit-Modus
            uint mode = mr[half] & TnmrMask;
            bool ams = (mr[half] & MrAms) != 0, cmr = (mr[half] & MrCmr) != 0;
            if(ams)
            {
                if(cmr || mode == 0 || mode == 3) return Kind.None;
                if(cfg != 4)
                {
                    Warn("pwm32", "PWM-Modus (TnAMS = 1) gibt es nur im 16-Bit-Modus (GPTMCFG = 0x4).");
                    return Kind.None;
                }
                return Kind.Pwm;
            }
            if(mode == TnmrOneShot) return Kind.OneShot;
            if(mode == TnmrPeriodic) return Kind.Periodic;
            if(mode == TnmrCapture && cmr)
            {
                if(cfg != 4)
                {
                    Warn("cap32", "Capture-Modus gibt es nur im 16-Bit-Modus (GPTMCFG = 0x4).");
                    return Kind.None;
                }
                return Kind.EdgeTime;
            }
            return Kind.None;                                   // reserviert / Edge-Count
        }

        // Compare-Action eingestellt (One-Shot/Periodic, TnAMS = 0, TCACT != 0); 32 Bit: nur Timer A
        private bool CompareActive(int half)
        {
            uint mode = mr[half] & TnmrMask;
            if((mr[half] & MrTcact) == 0 || (mr[half] & MrAms) != 0) return false;
            if(mode != TnmrOneShot && mode != TnmrPeriodic) return false;
            if(cfg != 4 && (cfg != 0 || half != 0)) return false;
            return true;
        }

        private bool Up(int half)
        {
            return (mr[half] & MrCdir) != 0;
        }

        private uint EnBit(int half)
        {
            return half == 0 ? CtlTaen : CtlTben;
        }

        // Takte pro Periode One-Shot/Periodic (Tabelle 13-4), mit den Werten der laufenden Periode
        private ulong Ticks(int half, uint load, uint pre)
        {
            if(cfg != 4) return (ulong)load + 1;
            ulong l = load & 0xFFFF;
            ulong p = pre & 0xFF;
            return Up(half) ? ((p << 16) | l) + 1 : (l + 1) * (p + 1);
        }

        // 24-Bit-Startwert (PWM, Edge-Time): TnPR:TnILR
        private uint Start24(int half)
        {
            return ((curPr[half] & 0xFF) << 16) | (curIlr[half] & 0xFFFF);
        }

        private uint Match24(int half)
        {
            return ((pmrEff[half] & 0xFF) << 16) | (matchEff[half] & 0xFFFF);
        }

        // Takte seit Beginn der laufenden Periode (0 .. Periode-1)
        private ulong Elapsed(int half)
        {
            ulong remaining = Math.Min(segLen[half], Math.Max(1UL, timers[half].Value));
            return segOff[half] + (segLen[half] - remaining);
        }

        // Zählerstand wie GPTMTnR (value = false) bzw. GPTMTnV (value = true).
        private uint Counter(int half, bool value)
        {
            if(!started[half])
            {
                return half == 0 ? 0xFFFFFFFF : 0xFFFF; // Reset-Werte
            }
            Kind kind = run[half];
            if(kind == Kind.EdgeTime || kind == Kind.Pwm)
            {
                if(kind == Kind.EdgeTime && !value) return captured[half] & 0xFFFFFF;   // Zeitpunkt der letzten Flanke
                if(stopped[half]) return Start24(half);
                ulong e = Elapsed(half);
                return (uint)((kind == Kind.EdgeTime && Up(half) ? e : Start24(half) - e) & 0xFFFFFF);
            }
            bool up = Up(half);
            if(stopped[half])
            {
                // One-Shot abgelaufen: Startwert ist geladen (abwärts TnILR/TnPR, aufwärts 0)
                if(up) return 0;
                if(cfg != 4) return curIlr[0];
                return value ? (((curPr[half] & 0xFF) << 16) | (curIlr[half] & 0xFFFF)) : curIlr[half] & 0xFFFF;
            }
            ulong elapsed = Elapsed(half);                    // 0 .. ticks-1
            if(cfg != 4)
            {
                return (uint)(up ? elapsed : curIlr[0] - elapsed);
            }
            if(up)
            {
                // Prescaler = Bits 23:16 des Zählers (lineare Erweiterung); TnR zeigt nur 15:0
                return value ? (uint)(elapsed & 0xFFFFFF) : (uint)(elapsed & 0xFFFF);
            }
            // Abwärts: "true prescaler" zählt von TnPR bis 0, erst dann zählt der Zähler um 1 weiter
            ulong scale = (curPr[half] & 0xFF) + 1;
            uint counter = (uint)((curIlr[half] & 0xFFFF) - elapsed / scale);
            uint prescale = (uint)((curPr[half] & 0xFF) - elapsed % scale);
            return value ? ((prescale & 0xFF) << 16) | (counter & 0xFFFF) : counter & 0xFFFF;
        }

        // ---- Zähler starten / Perioden -------------------------------------------------------

        // half: 0 = Timer A, 1 = Timer B; restart: Zähler neu laden (Einschalten bzw. TnILR geändert)
        private void Apply(int half, bool restart, double now)
        {
            var timer = timers[half];
            bool enable = (ctl & EnBit(half)) != 0;
            Kind kind = enable ? KindOf(half) : Kind.None;
            if(kind == Kind.None)
            {
                timer.Enabled = false;               // TnEN = 0 bzw. nicht modelliert: Zähler bleibt stehen
                return;
            }
            if(!restart && timer.Enabled) return;     // läuft schon
            run[half] = kind;
            curIlr[half] = ilr[half];
            curPr[half] = pr[half];
            pendingLoad[half] = false;
            matchEff[half] = match[half];
            pmrEff[half] = pmr[half];
            pendingMatch[half] = false;
            started[half] = true;
            stopped[half] = false;
            segStartUs[half] = now;
            switch(kind)
            {
                case Kind.OneShot:
                case Kind.Periodic:
                    StartCountPeriod(half, now);
                    if(CompareActive(half)) ImmediateAction(half, now);
                    break;
                case Kind.EdgeTime:
                    captured[half] = Up(half) ? 0 : Start24(half);   // Tabelle 13-8
                    Arm(half, 0, 0, (ulong)Start24(half) + 1);
                    break;
                case Kind.Pwm:
                    StartPwmPeriod(half, now);
                    break;
            }
        }

        // Abschnitt der Periode starten: Takte off .. off+len-1 der Periode
        private void Arm(int half, int segment, ulong off, ulong len)
        {
            var timer = timers[half];
            timer.Enabled = false;
            timer.Mode = WorkMode.Periodic;
            timer.Limit = Math.Max(1UL, len);
            timer.ResetValue();
            seg[half] = segment;
            segOff[half] = off;
            segLen[half] = Math.Max(1UL, len);
            timer.Enabled = true;
        }

        // LimitTimer abgelaufen: Abschnitt bzw. Periode zu Ende (exakte Zeit aus dem Startzeitpunkt)
        private void OnLimit(int half)
        {
            double at = segStartUs[half] + segLen[half] * tickUs;
            segStartUs[half] = at;
            switch(run[half])
            {
                case Kind.OneShot:
                case Kind.Periodic:
                    if(seg[half] == 0)
                    {
                        // Zähler = Match: TnMRIS, weiter bis zum Time-out
                        SetMatch(half);
                        ulong m = segOff[half] + segLen[half];
                        Arm(half, 1, m, Ticks(half, curIlr[half], curPr[half]) - m);
                    }
                    else
                    {
                        OnTimeout(half, at);
                    }
                    break;
                case Kind.EdgeTime:
                    // Zähler wird neu geladen (modulo 2^24); kein Interrupt
                    if(pendingLoad[half])
                    {
                        curIlr[half] = ilr[half];
                        curPr[half] = pr[half];
                        pendingLoad[half] = false;
                        Arm(half, 0, 0, (ulong)Start24(half) + 1);
                    }
                    break;
                case Kind.Pwm:
                    if(seg[half] == 0)
                    {
                        // Zähler = Match: Ausgang LOW bis zum Ende der Periode
                        ulong p = (ulong)Start24(half) + 1;
                        ulong hi = segOff[half] + segLen[half];
                        SetPwmSignal(half, false, at);
                        Arm(half, 1, hi, p - hi);
                    }
                    else
                    {
                        if(pendingLoad[half])
                        {
                            curIlr[half] = ilr[half];
                            curPr[half] = pr[half];
                            pendingLoad[half] = false;
                        }
                        if(pendingMatch[half])
                        {
                            matchEff[half] = match[half];
                            pmrEff[half] = pmr[half];
                            pendingMatch[half] = false;
                        }
                        StartPwmPeriod(half, at);
                    }
                    break;
            }
            UpdateIrq();
        }

        private void OnTimeout(int half, double at)
        {
            if((mr[half] & MrCintd) == 0)
            {
                ris |= half == 0 ? RisTatoris : RisTbtoris;
            }
            if(CompareActive(half)) TimeoutAction(half, at);
            if(run[half] == Kind.OneShot)
            {
                ctl &= ~EnBit(half);                 // One-Shot: Timer schaltet sich ab (TnEN = 0)
                timers[half].Enabled = false;
                stopped[half] = true;
            }
            else
            {
                if(pendingLoad[half])
                {
                    pendingLoad[half] = false;       // TnILD = 1: neuer Startwert ab jetzt
                    curIlr[half] = ilr[half];
                    curPr[half] = pr[half];
                }
                if(pendingMatch[half])
                {
                    pendingMatch[half] = false;      // TnMRSU = 1: neuer Match-Wert ab jetzt
                    matchEff[half] = match[half];
                    pmrEff[half] = pmr[half];
                }
                StartCountPeriod(half, at);
            }
        }

        // ---- One-Shot / Periodic: Match ----------------------------------------------------------

        // Takt der Periode (0 .. Periode-1), in dem der Zähler den Match-Wert erreicht; -1 = nie
        // (TnMIE = 0 oder Match-Wert außerhalb des Zählbereichs)
        private long MatchTick(int half)
        {
            if((mr[half] & MrMie) == 0) return -1;
            ulong ticks = Ticks(half, curIlr[half], curPr[half]);
            ulong e;
            if(cfg != 4)
            {
                ulong m = matchEff[half], load = curIlr[half];
                if(m > load) return -1;
                e = Up(half) ? m : load - m;
            }
            else if(Up(half))
            {
                e = Match24(half);                   // lineare Erweiterung: TnPMR:TnMATCHR
            }
            else
            {
                // True Prescaler: Zähler = TnMATCHR und Prescaler-Stand = TnPMR
                ulong m = matchEff[half] & 0xFFFF, pm = pmrEff[half] & 0xFF;
                ulong load = curIlr[half] & 0xFFFF, pre = curPr[half] & 0xFF;
                if(m > load || pm > pre) return -1;
                e = (load - m) * (pre + 1) + (pre - pm);
            }
            return e < ticks ? (long)e : -1;
        }

        private void SetMatch(int half)
        {
            ris |= half == 0 ? RisTamris : RisTbmris;
        }

        // Neue Periode One-Shot/Periodic: Abschnitt 0 bis zum Match, Abschnitt 1 bis zum Time-out
        private void StartCountPeriod(int half, double at)
        {
            segStartUs[half] = at;
            ulong ticks = Ticks(half, curIlr[half], curPr[half]);
            long e = MatchTick(half);
            if(e == 0) SetMatch(half);               // Match-Wert = Startwert
            if(e > 0) Arm(half, 0, 0, (ulong)e);
            else Arm(half, 1, 0, ticks);
        }

        // Match-Wert bei laufendem One-Shot/Periodic geändert (TnMRSU = 0): gilt ab dem nächsten Takt
        private void CountMatchChanged(int half)
        {
            ulong ticks = Ticks(half, curIlr[half], curPr[half]);
            ulong now = Elapsed(half);
            long e = MatchTick(half);
            segStartUs[half] = NowUs();
            if(e > (long)now) Arm(half, 0, now, (ulong)e - now);
            else Arm(half, 1, now, ticks - now);    // schon vorbei bzw. nie: erst wieder nächste Periode
        }

        // ---- PWM -------------------------------------------------------------------------------

        // Takte HIGH (nicht invertiertes Signal) in einer Periode
        private ulong PwmHigh(int half)
        {
            ulong start = Start24(half), m = Match24(half), p = start + 1;
            if(m < start) return start - m;
            if(m > start) return p;                                  // kein Match: immer HIGH
            return (mr[half] & MrPlo) != 0 ? 0 : p;                  // MATCH = ILR (Bild 13-6)
        }

        private void StartPwmPeriod(int half, double at)
        {
            ulong p = (ulong)Start24(half) + 1;
            ulong hi = PwmHigh(half);
            SetPwmSignal(half, hi > 0, at);
            if(hi > 0 && hi < p) Arm(half, 0, 0, hi);
            else Arm(half, 1, 0, p);
        }

        // Match-Wert bei laufendem PWM geändert (TnMRSU = 0)
        private void PwmMatchChanged(int half)
        {
            if(!ccpState[half]) return;                              // LOW: erst die nächste Periode
            ulong p = (ulong)Start24(half) + 1;
            ulong e = Elapsed(half);
            ulong hi = PwmHigh(half);
            segStartUs[half] = NowUs();
            if(hi > e && hi < p)
            {
                Arm(half, 0, e, hi - e);                             // Rest bis zum neuen Match
            }
            else
            {
                // Match schon vorbei (bzw. nie): HIGH bis zum Ende der Periode
                Arm(half, 1, e, p - e);
            }
        }

        private void SetPwmSignal(int half, bool high, double at)
        {
            bool old = ccpState[half];
            ccpState[half] = high;
            if(old != high && (mr[half] & MrPwmie) != 0)
            {
                uint ev = (ctl >> (8 * half + 2)) & 3;
                if(ev == 3 || (ev == 0 && high) || (ev == 1 && !high))
                {
                    ris |= half == 0 ? RisCaeris : RisCberis;
                }
            }
            SetPin(half, at);
        }

        // ---- Compare-Action ------------------------------------------------------------------

        private void ImmediateAction(int half, double at)
        {
            uint act = (mr[half] & MrTcact) >> 13;
            if(act < 4) return;
            ccpState[half] = act == 4 || act == 6;                    // 4/6 setzen, 5/7 löschen
            SetPin(half, at);
        }

        private void TimeoutAction(int half, double at)
        {
            uint act = (mr[half] & MrTcact) >> 13;
            switch(act)
            {
                case 1: case 4: case 5: ccpState[half] = !ccpState[half]; break;  // umschalten
                case 2: case 6: ccpState[half] = false; break;                    // löschen
                case 3: case 7: ccpState[half] = true; break;                     // setzen
                default: return;
            }
            SetPin(half, at);
        }

        // ---- CCP-Pins --------------------------------------------------------------------------

        private bool PinLevel(int half)
        {
            if(run[half] == Kind.Pwm || ((mr[half] & MrAms) != 0))
            {
                bool inv = (ctl & (half == 0 ? CtlTapwml : CtlTbpwml)) != 0;
                return ccpState[half] ^ inv;
            }
            return ccpState[half];
        }

        // Treibt der Timer den CCP-Pin? (Compare-Action oder PWM eingestellt)
        private bool Drives(int half)
        {
            if(CompareActive(half)) return true;
            return cfg == 4 && (mr[half] & MrAms) != 0 && (mr[half] & MrCmr) == 0 && (mr[half] & TnmrMask) == TnmrPeriodic;
        }

        private void UpdateDrive(int half)
        {
            SetPin(half, -1);
        }

        private void SetPin(int half, double at)
        {
            FindPins();
            bool drive = Drives(half), level = PinLevel(half);
            foreach(var c in ccp[half]) c.Port.SetAlternateDrive(c.Pin, CcpFunction, drive, level, at);
        }

        private bool PinConfigured(int half)
        {
            foreach(var c in ccp[half])
            {
                if(c.Port.IsPinFunction(c.Pin, (uint)CcpFunction)) return true;
            }
            return false;
        }

        // Flanke an einem Eingang: Capture (Edge-Time) auslösen, wenn der Pin T<n>CCP<half> ist
        private void OnPinLevel(TivaGPIOPort port, int pin, bool level)
        {
            for(int h = 0; h < 2; h++)
            {
                if(run[h] != Kind.EdgeTime || !timers[h].Enabled) continue;
                bool ours = false;
                foreach(var c in ccp[h])
                {
                    if(c.Port == port && c.Pin == pin && port.IsPinFunction(pin, (uint)CcpFunction)) ours = true;
                }
                if(!ours) continue;
                uint ev = (ctl >> (8 * h + 2)) & 3;
                if(!(ev == 3 || (ev == 0 && level) || (ev == 1 && !level))) continue;
                captured[h] = Counter(h, true) & 0xFFFFFF;
                ris |= h == 0 ? RisCaeris : RisCberis;
            }
            UpdateIrq();
        }

        private class CcpPin
        {
            public TivaGPIOPort Port;
            public int Pin;
            public string Name;
        }

        // CCP-Pins des Timers suchen (Tabelle 13-2) und anmelden; beim ersten Registerzugriff, weil die
        // GPIO-Ports beim Anlegen des Timers evtl. noch nicht existieren
        private void FindPins()
        {
            if(ccp != null) return;
            ccp = new[] { new List<CcpPin>(), new List<CcpPin>() };
            var ports = new HashSet<TivaGPIOPort>();
            for(int h = 0; h < 2; h++)
            {
                string[] names = clockBit < CcpTable.Length ? CcpTable[clockBit][h] : new string[0];
                foreach(var name in names)
                {
                    IPeripheral p;
                    if(!machine.TryGetByName("sysbus.gpio" + name[1], out p)) continue;
                    var port = p as TivaGPIOPort;
                    if(port == null) continue;
                    ccp[h].Add(new CcpPin { Port = port, Pin = name[2] - '0', Name = name });
                    ports.Add(port);
                }
            }
            foreach(var port in ports)
            {
                var pt = port;
                pt.LevelChanged += (pin, level) => OnPinLevel(pt, pin, level);
            }
            UpdateDrive(0);
            UpdateDrive(1);
        }

        // T<n>CCP0 / T<n>CCP1, GPIOPCTL = 3 (Datenblatt Tabelle 13-2, 128TQFP)
        private static readonly string[][][] CcpTable =
        {
            new[] { new[] { "PD0", "PA0", "PL4" }, new[] { "PD1", "PA1", "PL5" } },   // Timer 0
            new[] { new[] { "PD2", "PA2", "PL6" }, new[] { "PD3", "PA3", "PL7" } },   // Timer 1
            new[] { new[] { "PA4", "PM0" },        new[] { "PA5", "PM1" } },          // Timer 2
            new[] { new[] { "PA6", "PM2", "PD4" }, new[] { "PA7", "PM3", "PD5" } },   // Timer 3
            new[] { new[] { "PM4", "PB0", "PD6" }, new[] { "PM5", "PB1", "PD7" } },   // Timer 4
            new[] { new[] { "PM6", "PB2" },        new[] { "PM7", "PB3" } },          // Timer 5
        };                                                                            // Timer 6/7: keine CCP-Pins
        private const int CcpFunction = 3;

        // ---- Hilfen ------------------------------------------------------------------------------

        private void UpdateIrq()
        {
            IRQA.Set((ris & imr & 0xFF) != 0);
            IRQB.Set((ris & imr & 0xFF00) != 0);
        }

        // Virtuelle Zeit in us, im CPU-Thread auf den Befehl genau
        private double NowUs()
        {
            ICPU cpu;
            if(machine.SystemBus.TryGetCurrentCPU(out cpu))
            {
                var tcpu = cpu as TranslationCPU;
                if(tcpu != null) tcpu.SyncTime();
            }
            return machine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds;
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
                           TaR = 0x048, TbR = 0x04C, TaV = 0x050, TbV = 0x054, TaPs = 0x05C, TbPs = 0x060,
                           Sync = 0x010, Pp = 0xFC0, Cc = 0xFC8;
        private const uint CtlTaen = 1u << 0, CtlTastall = 1u << 1, CtlTaevent = 3u << 2, CtlTapwml = 1u << 6,
                           CtlTben = 1u << 8, CtlTbstall = 1u << 9, CtlTbevent = 3u << 10, CtlTbpwml = 1u << 14;
        private const uint MrCmr = 1u << 2, MrAms = 1u << 3, MrCdir = 1u << 4, MrMie = 1u << 5, MrWot = 1u << 6,
                           MrSnaps = 1u << 7, MrIld = 1u << 8, MrPwmie = 1u << 9, MrMrsu = 1u << 10, MrPlo = 1u << 11,
                           MrCintd = 1u << 12, MrTcact = 7u << 13;
        private const uint MrMask = 0xFFFF;                                  // TnMR .. TCACT (Bits 15:0)
        private const uint CfgMask = 0x7;                                    // TIMER_CFG_M
        private const uint TnmrMask = 0x3, TnmrOneShot = 0x1, TnmrPeriodic = 0x2, TnmrCapture = 0x3;
        private const uint RisTatoris = 1u << 0, RisCaeris = 1u << 2, RisTamris = 1u << 4,
                           RisTbtoris = 1u << 8, RisCberis = 1u << 10, RisTbmris = 1u << 11;
        private const uint ImTatoim = 1u << 0, ImCaeim = 1u << 2, ImTamim = 1u << 4,
                           ImTbtoim = 1u << 8, ImCbeim = 1u << 10, ImTbmim = 1u << 11;
        // Time-out-, Capture-, Match- und RTC-Bits von A und B (DMA/Wake-up nicht modelliert)
        private const uint ImrMask = 0x0F1F;

        private readonly IMachine machine;
        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly ulong frequency;
        private readonly double tickUs;
        private readonly LimitTimer[] timers;
        private uint cfg, ctl, imr, ris, cc;
        private uint[] mr, ilr, pr, match, pmr;
        private uint[] matchEff, pmrEff;          // wirksamer Match-Wert (TnMRSU)
        private uint[] curIlr, curPr;             // Werte der laufenden Periode (TnILD)
        private uint[] captured;                  // Edge-Time: Zählerstand der letzten Flanke
        private bool[] pendingLoad, pendingMatch, started, stopped, ccpState;
        private Kind[] run;
        private int[] seg;                        // PWM: 0 = HIGH-Abschnitt, 1 = Rest der Periode;
                                                  // One-Shot/Periodic: 0 = bis zum Match, 1 = bis zum Time-out
        private ulong[] segOff, segLen;           // Abschnitt in Takten ab Periodenbeginn
        private double[] segStartUs;              // virtuelle Zeit des Abschnittsbeginns
        private List<CcpPin>[] ccp;
        private bool clockWarned;
        private HashSet<string> warned;
    }
}
