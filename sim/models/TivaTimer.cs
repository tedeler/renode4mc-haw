// General-Purpose Timer (GPTM) des TM4C1294, Timer0..7 (je 4 KB).
//
// Modelliert (je Hälfte A/B):
//  * 32-Bit-Modus (CFG=0, nur Timer A) und 16-Bit-Modus (CFG=4, A und B getrennt, mit Prescaler)
//  * Einmal- (TnMR=1) und periodisch (TnMR=2), Abwärtszähler
//  * Time-out-Interrupt: IMR, RIS, MIS, ICR -> IRQA / IRQB zum NVIC
//  * Clock-Gating über RCGCTIMER (Offset 0x604)
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
                case 0x000: return cfg;
                case 0x004: return mr[0];
                case 0x008: return mr[1];
                case 0x00C: return ctl;
                case 0x018: return imr;
                case 0x01C: return ris;
                case 0x020: return ris & imr;
                case 0x028: return ilr[0];
                case 0x02C: return ilr[1];
                case 0x038: return pr[0];
                case 0x03C: return pr[1];
                case 0x048: return ilr[0]; // TAPS/TBPS nicht modelliert
                case 0x050: return (uint)timerA.Value;
                case 0x054: return (uint)timerB.Value;
                default: return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk()) return;
            switch(offset)
            {
                case 0x000: cfg = value & 7; break;
                case 0x004: mr[0] = value; break;
                case 0x008: mr[1] = value; break;
                case 0x00C: ctl = value; Apply(0); Apply(1); break;
                case 0x018: imr = value & 0x1F1F; break;
                case 0x024: ris &= ~value; break;
                case 0x028: ilr[0] = value; Apply(0); break;
                case 0x02C: ilr[1] = value; Apply(1); break;
                case 0x038: pr[0] = value; Apply(0); break;
                case 0x03C: pr[1] = value; Apply(1); break;
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
            bool enable = ((ctl >> (half * 8)) & 1) != 0;
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

            timer.Enabled = false;
            timer.Limit = ticks;
            bool oneShot = (mr[half] & 3) == 1;
            timer.Mode = oneShot ? WorkMode.OneShot : WorkMode.Periodic;
            if(enable)
            {
                timer.Enabled = true;
            }
        }

        private void OnTimeout(int half)
        {
            ris |= 1u << (half * 8); // TATORIS bzw. TBTORIS (Bit 0 / Bit 8)
            if(((mr[half] & 3) == 1))
            {
                ctl &= ~(1u << (half * 8)); // Einmal-Modus: Timer schaltet sich ab
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
            if(sysCtl.IsClockEnabled(0x604, clockBit))
            {
                clockWarned = false;
                return true;
            }
            if(!clockWarned)
            {
                this.Log(LogLevel.Warning,
                    "Timer: Zugriff ohne Takt! RCGCTIMER Bit {0} muss gesetzt werden (SysCtlPeripheralEnable).",
                    clockBit);
                clockWarned = true;
            }
            return false;
        }

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly ulong frequency;
        private readonly LimitTimer timerA, timerB;
        private uint cfg, ctl, imr, ris;
        private uint[] mr, ilr, pr;
        private bool clockWarned;
    }
}
