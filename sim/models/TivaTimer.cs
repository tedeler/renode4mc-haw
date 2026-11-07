// General-Purpose Timer (GPTM) des TM4C1294, Timer0..7 (je 4 KB).
//
// Modelliert (je Hälfte A/B):
//  * 32-Bit-Modus (CFG=0, nur Timer A) und 16-Bit-Modus (CFG=4, A und B getrennt, mit Prescaler)
//  * Einmal- (TnMR=1) und periodisch (TnMR=2), Abwärtszähler
//  * Time-out-Interrupt: IMR, RIS, MIS, ICR -> IRQA / IRQB zum NVIC
//  * Clock-Gating über RCGCTIMER (Offset 0x604)
//  * Zählerstand lesbar über GPTMTAR/TBR und GPTMTAV/TBV
// Nicht modelliert: Capture-, PWM-, RTC-Modus, Match, Aufwärtszählen, ADC-Trigger.
// Der Timer läuft mit 16 MHz (PIOSC, Reset-Takt).
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
            timerA = new LimitTimer(machine.ClockSource, frequency, this, "A", 1, Direction.Descending,
                enabled: false, workMode: WorkMode.Periodic, eventEnabled: true);
            timerB = new LimitTimer(machine.ClockSource, frequency, this, "B", 1, Direction.Descending,
                enabled: false, workMode: WorkMode.Periodic, eventEnabled: true);
            timerA.LimitReached += () => OnTimeout(0);
            timerB.LimitReached += () => OnTimeout(1);
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
                case Tamr: return mr[0];
                case Tbmr: return mr[1];
                case Ctl: return ctl;
                case Imr: return imr;
                case Ris: return ris;
                case Mis: return ris & imr;
                case Tailr: return ilr[0];
                case Tbilr: return ilr[1];
                case Tapr: return pr[0];
                case Tbpr: return pr[1];
                // GPTMTnR und GPTMTnV: im Einmal-/periodischen Modus beide der aktuelle Zählerstand
                // (Prescaler-Anteil in Bits 23:16 im 16-Bit-Modus nicht modelliert)
                case Tar: case Tav: return (uint)timerA.Value;
                case Tbr: case Tbv: return (uint)timerB.Value;
                default: return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk()) return;
            switch(offset)
            {
                case Cfg: cfg = value & CfgMask; break;
                case Tamr: mr[0] = value; break;
                case Tbmr: mr[1] = value; break;
                case Ctl: ctl = value; Apply(0); Apply(1); break;
                case Imr: imr = value & ImrMask; break;
                case Icr: ris &= ~value; break;
                case Tailr: ilr[0] = value; Apply(0); break;
                case Tbilr: ilr[1] = value; Apply(1); break;
                case Tapr: pr[0] = value; Apply(0); break;
                case Tbpr: pr[1] = value; Apply(1); break;
            }
            UpdateIrq();
        }

        public void Reset()
        {
            timerA.Enabled = false;
            timerB.Enabled = false;
            cfg = 0; ctl = 0; imr = 0; ris = 0;
            mr = new uint[2];
            ilr = new uint[] { 0xFFFFFFFF, 0xFFFF };
            pr = new uint[2];
            clockWarned = false;
            IRQA.Unset();
            IRQB.Unset();
        }

        // half: 0 = Timer A, 1 = Timer B
        private void Apply(int half)
        {
            var timer = half == 0 ? timerA : timerB;
            bool enable = (ctl & (half == 0 ? CtlTaen : CtlTben)) != 0;
            // Im 32-Bit-Modus (CFG=0) gibt es nur Timer A.
            if(cfg == 0 && half == 1) enable = false;

            ulong ticks;
            if(cfg == 0)
            {
                ticks = (ulong)ilr[0] + 1;
            }
            else
            {
                ticks = (((ulong)ilr[half] & 0xFFFF) + 1) * ((pr[half] & 0xFF) + 1);
            }

            bool wasRunning = timer.Enabled;
            timer.Enabled = false;
            timer.Limit = ticks;
            bool oneShot = (mr[half] & TnmrMask) == TnmrOneShot;
            timer.Mode = oneShot ? WorkMode.OneShot : WorkMode.Periodic;
            if(enable)
            {
                // Wie auf dem Chip: Einschalten (TnEN 0 -> 1) lädt den Zähler aus TnILR, z. B. beim
                // erneuten Start eines Einmal-Timers. Läuft der Timer schon, zählt er weiter.
                if(!wasRunning || timer.Value > ticks)
                {
                    timer.ResetValue(); // abwärts zählend: Zähler = Limit
                }
                timer.Enabled = true;
            }
        }

        private void OnTimeout(int half)
        {
            ris |= half == 0 ? RisTatoris : RisTbtoris;
            if((mr[half] & TnmrMask) == TnmrOneShot)
            {
                ctl &= ~(half == 0 ? CtlTaen : CtlTben); // Einmal-Modus: Timer schaltet sich ab
            }
            UpdateIrq();
        }

        private void UpdateIrq()
        {
            IRQA.Set((ris & imr & 0xFF) != 0);
            IRQB.Set((ris & imr & 0xFF00) != 0);
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
                    "Timer: Zugriff ohne Takt! RCGCTIMER Bit {0} muss gesetzt werden (SysCtlPeripheralEnable).",
                    clockBit);
                clockWarned = true;
            }
            return false;
        }

        // Register-Offsets und Bits wie in tm4c1294ncpdt.h (TIMERn_..._R, TIMER_...); geprüft mit
        // tools/check_header.py
        private const long RcgcTimer = 0x604;
        private const long Cfg = 0x000, Tamr = 0x004, Tbmr = 0x008, Ctl = 0x00C, Imr = 0x018, Ris = 0x01C,
                           Mis = 0x020, Icr = 0x024, Tailr = 0x028, Tbilr = 0x02C, Tapr = 0x038, Tbpr = 0x03C,
                           Tar = 0x048, Tbr = 0x04C, Tav = 0x050, Tbv = 0x054;
        private const uint CfgMask = 0x7;                                    // TIMER_CFG_M
        private const uint TnmrMask = 0x3, TnmrOneShot = 0x1;                // TIMER_TAMR_TAMR_M, _1_SHOT
        private const uint CtlTaen = 1u << 0, CtlTben = 1u << 8;
        private const uint RisTatoris = 1u << 0, RisTbtoris = 1u << 8;
        // Time-out-, Capture-, Match- und RTC-Bits von A und B (DMA/Wake-up nicht modelliert)
        private const uint ImrMask = 0x0F1F;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly ulong frequency;
        private readonly LimitTimer timerA, timerB;
        private uint cfg, ctl, imr, ris;
        private uint[] mr, ilr, pr;
        private bool clockWarned;
    }
}
