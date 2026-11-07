// GPIO-Port des TM4C1294 (AHB-Adressen wie in tm4c1294ncpdt.h, je 4 KB; der TM4C1294 hat für GPIO
// keine APB-Adressen).
//
// Modelliert:
//  * DATA mit Adressmaske (Bits 9:2 der Adresse wählen die Pins), DIR, AFSEL, DEN,
//    Pull-up/Pull-down (PUR/PDR), Interrupts (IS, IBE, IEV, IM, RIS, MIS, ICR)
//  * Clock-Gating: Zugriffe ohne freigegebenen Takt (RCGCGPIO) werden ignoriert und gemeldet
//  * Ein Pin treibt nach außen nur, wenn DIR=1, DEN=1 und AFSEL=0 ("GPIO-Ausgang")
// Alle anderen Register (Treiberstärke, ODR, PCTL, ...) werden nur gespeichert.
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.Miscellaneous;

namespace Antmicro.Renode.Peripherals.GPIOPort
{
    public class TivaGPIOPort : BaseGPIOPort, IDoubleWordPeripheral, IKnownSize
    {
        // portName: z. B. "N"; clockBit: Bit in RCGCGPIO (A=0 ... N=12 ...)
        public TivaGPIOPort(IMachine machine, TivaSysCtl sysCtl, int clockBit, string portName = "?") : base(machine, 8)
        {
            this.sysCtl = sysCtl;
            this.clockBit = clockBit;
            this.portName = portName;
            IRQ = new GPIO();
            Reset();
        }

        // Interrupt-Ausgang zum NVIC
        public long Size { get { return 0x1000; } }

        public GPIO IRQ { get; private set; }

        public override void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 7) return;
            uint bit = 1u << number;
            uint oldPins = PinLevels();
            inputDriven |= bit;
            if(value) inputValue |= bit; else inputValue &= ~bit;
            DetectEdges(oldPins, PinLevels());
            UpdateInterrupt();
        }

        public uint ReadDoubleWord(long offset)
        {
            if(!ClockOk(offset)) return 0;

            if(offset <= Data)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                return PinLevels() & mask;
            }

            switch(offset)
            {
                case Dir: return dir;
                case Is: return isLevel;
                case Ibe: return ibe;
                case Iev: return iev;
                case Im: return im;
                case Ris: return ris;
                case Mis: return ris & im;
                case Afsel: return afsel;
                case Pur: return pur;
                case Pdr: return pdr;
                case Den: return den;
                case Pp: return 0x1;
                default:
                    uint value;
                    other.TryGetValue(offset, out value);
                    return value;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(!ClockOk(offset)) return;

            if(offset <= Data)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                dataLatch = (dataLatch & ~mask) | (value & mask);
                UpdatePins();
                return;
            }

            switch(offset)
            {
                case Dir: dir = value & 0xFF; break;
                case Is: isLevel = value & 0xFF; break;
                case Ibe: ibe = value & 0xFF; break;
                case Iev: iev = value & 0xFF; break;
                case Im: im = value & 0xFF; break;
                case Icr: ris &= ~value; break;
                case Afsel: afsel = value & 0xFF; break;
                case Pur: pur = value & 0xFF; break;
                case Pdr: pdr = value & 0xFF; break;
                case Den: den = value & 0xFF; break;
                case Ris: case Mis: case Pp: break; // nur lesbar
                default: other[offset] = value; break;
            }
            UpdatePins();
            UpdateInterrupt();
        }

        public override void Reset()
        {
            base.Reset();
            dataLatch = dir = isLevel = ibe = iev = im = ris = afsel = pur = pdr = den = 0;
            inputDriven = inputValue = 0;
            drivenLevels = 0;
            clockWarned = false;
            other = new Dictionary<long, uint>();
            if(IRQ != null) IRQ.Unset();
        }

        // Tatsächlicher Pegel der Pins: Ausgänge liefern DATA, Eingänge den
        // von außen gesetzten Pegel bzw. den Pull-up/Pull-down-Zustand.
        private uint PinLevels()
        {
            uint outputs = OutputEnabled();
            uint levels = dataLatch & outputs;
            uint inputs = ~outputs & 0xFF;
            uint floatingLevel = pur & ~pdr;
            levels |= ((inputValue & inputDriven) | (floatingLevel & ~inputDriven)) & inputs;
            return levels & 0xFF;
        }

        private uint OutputEnabled()
        {
            return dir & den & ~afsel & 0xFF;
        }

        private void UpdatePins()
        {
            uint oldPins = PinLevels();
            uint newDriven = dataLatch & OutputEnabled();
            for(int i = 0; i < 8; i++)
            {
                bool level = ((newDriven >> i) & 1) != 0;
                bool old = ((drivenLevels >> i) & 1) != 0;
                if(level != old)
                {
                    Connections[i].Set(level);
                    this.Log(LogLevel.Debug, "GPIO Port {0}: Pin {1} -> {2}", portName, i, level ? "HIGH" : "LOW");
                }
            }
            drivenLevels = newDriven;
            DetectEdges(oldPins, PinLevels());
        }

        private void DetectEdges(uint oldPins, uint newPins)
        {
            uint changed = oldPins ^ newPins;
            if(changed == 0) return;
            uint edgeSensitive = ~isLevel & 0xFF;
            uint rising = changed & newPins;
            uint falling = changed & oldPins;
            // IBE=1: beide Flanken; sonst IEV=1 steigend, IEV=0 fallend
            uint trigger = (ibe & changed) | (~ibe & ((iev & rising) | (~iev & falling)));
            ris |= trigger & edgeSensitive;
        }

        private void UpdateInterrupt()
        {
            // Pegelgesteuerte Interrupts folgen dem Pegel (IEV=1: bei High, IEV=0: bei Low)
            uint levels = PinLevels();
            uint levelEvents = isLevel & ((iev & levels) | (~iev & ~levels));
            ris = (ris & ~isLevel) | levelEvents;
            ris &= 0xFF;
            IRQ.Set((ris & im) != 0);
        }

        private bool ClockOk(long offset)
        {
            if(sysCtl.IsClockEnabled(RcgcGpio, clockBit))
            {
                clockWarned = false;
                return true;
            }
            if(!clockWarned)
            {
                this.Log(LogLevel.Warning,
                    "GPIO Port {0}: Zugriff (Offset 0x{1:X}) ohne Takt! RCGCGPIO Bit {2} muss gesetzt werden " +
                    "(SysCtlPeripheralEnable). Auf der Hardware führt das zu einem Fault.",
                    portName, offset, clockBit);
                clockWarned = true;
            }
            return false;
        }

        // Register-Offsets wie in tm4c1294ncpdt.h (GPIO_PORTx_..._R); geprüft mit tools/check_header.py
        private const long Data = 0x3FC;
        private const long RcgcGpio = 0x608;
        private const long Dir = 0x400, Is = 0x404, Ibe = 0x408, Iev = 0x40C, Im = 0x410, Ris = 0x414,
                           Mis = 0x418, Icr = 0x41C, Afsel = 0x420, Pur = 0x510, Pdr = 0x514,
                           Den = 0x51C, Pp = 0xFC0;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly string portName;
        private uint dataLatch, dir, isLevel, ibe, iev, im, ris, afsel, pur, pdr, den;
        private uint inputDriven, inputValue, drivenLevels;
        private bool clockWarned;
        private Dictionary<long, uint> other;
    }
}
