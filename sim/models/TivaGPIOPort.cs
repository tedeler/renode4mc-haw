// GPIO-Port des TM4C1294 (AHB-Adressen 0x40058000 ff., je 4 KB), nach Datenblatt SPMS433 Kap. 10.
//
// Modelliert:
//  * GPIODATA mit Adressmaske (Bits 9:2 der Adresse wählen die Pins), GPIODIR, GPIOAFSEL, GPIODEN,
//    GPIOPUR/GPIOPDR (ein gesetztes PDR-Bit löscht das PUR-Bit und umgekehrt), Interrupts
//    (GPIOIS, IBE, IEV, IM, RIS, MIS, ICR), GPIOLOCK/GPIOCR (Commit-Schutz von PC0..3, PD7, PE7)
//  * Clock-Gating: Zugriffe ohne freigegebenen Takt (RCGCGPIO) werden ignoriert und gemeldet
//  * Pin treibt nach außen nur, wenn DIR = 1, DEN = 1 und AFSEL = 0 ("GPIO-Ausgang")
//  * Lesen von GPIODATA (10.3.1): Ausgänge liefern den zuletzt geschriebenen Wert, Eingänge den
//    Pegel am Pin – aber nur mit DEN = 1. Ohne DEN gelangt die Pinspannung nicht in den
//    Empfänger, das Bit liest sich als 0.
//  * Ein Eingang, den niemand treibt und der weder Pull-up noch Pull-down hat, ist offen:
//    Er liest sich als 0 (auf dem Board: zufällig).
// Alle anderen Register (Treiberstärke, ODR, PCTL, AMSEL, ...) werden nur gespeichert.
//
// Strenge Prüfung (Warnungen erscheinen in der Web-Konsole unter "Diagnose"), je Pin einmal:
//  * Eingang gelesen, aber DEN = 0                -> liest immer 0
//  * offener Eingang gelesen (kein PUR/PDR, nicht angeschlossen bzw. Taster losgelassen)
//  * Ausgang beschrieben, aber DEN = 0             -> Pin wird nicht getrieben
//  * Interrupt freigegeben (IM), aber DEN = 0      -> es kommt nie ein Interrupt
//  * geschützter Pin ohne GPIOLOCK/GPIOCR umkonfiguriert -> Schreiben wirkungslos
//
// Pinpegel für das Oszilloskop (sim/models/Oscilloscope.cs): PadLevel(pin) liefert, was ein Tastkopf am
// Pin messen würde (0 = LOW, 1 = HIGH, 2 = offen/hochohmig), das Ereignis PadChanged meldet jeden Wechsel
// mit virtueller Zeit. Getriebener Ausgang -> Latch; sonst von außen getrieben -> dieser Pegel; sonst
// Pull-up/Pull-down; sonst offen. Alternative Funktion (AFSEL = 1, DEN = 1): Ein Peripheriemodell kann den
// Pin mit RegisterAlternateOutput übernehmen (z. B. U0TX, Ruhepegel HIGH) und mit AlternateOutput einen
// Bitstrom ausgeben (auch mit Zeitpunkten in der Zukunft).
//
// Monitor (bzw. Web-Konsole):  sysbus.gpioJ OnGPIO 0 false     Pin von außen auf LOW treiben
//                              sysbus.gpioJ ReleaseInput 0     Pin nicht mehr treiben (offen)
using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;
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
            this.ownMachine = machine;
            for(int i = 0; i < 8; i++) afFunction[i] = -1;
            // Commit-geschützte Pins (Tabelle 10-11): PC[3:0] JTAG/SWD, PD7 und PE7 (NMI)
            protectedPins = portName == "C" ? 0x0Fu : (portName == "D" || portName == "E") ? 0x80u : 0u;
            IRQ = new GPIO();
            Reset();
        }

        public long Size { get { return 0x1000; } }

        // Interrupt-Ausgang zum NVIC
        public GPIO IRQ { get; private set; }

        public string PortName { get { return portName; } }

        // Wechsel des Pinpegels: (Pin, virtuelle Zeit in us, Pegel 0/1/2 = LOW/HIGH/offen).
        // Nur solange jemand angemeldet ist, wird der Pegel nachgeführt (sonst kostet es nichts).
        public event Action<int, double, int> PadChanged
        {
            add
            {
                lock(padLock)
                {
                    padChanged += value;
                    for(int i = 0; i < 8; i++) padLevels[i] = ComputePad(i);
                }
            }
            remove { lock(padLock) { padChanged -= value; } }
        }

        // Was ein Tastkopf am Pin misst: 0 = LOW, 1 = HIGH, 2 = offen (hochohmig, kein Pull-up/-down)
        public int PadLevel(int pin)
        {
            if(pin < 0 || pin > 7) return 2;
            lock(padLock) { return ComputePad(pin); }
        }

        // Peripheriemodell übernimmt den Pin, wenn er auf die alternative Funktion "function" (GPIOPCTL)
        // eingestellt ist (AFSEL = 1, PCTL, DEN = 1). idleHigh: Pegel ohne laufende Ausgabe.
        public void RegisterAlternateOutput(int pin, int function, bool idleHigh)
        {
            if(pin < 0 || pin > 7) return;
            afFunction[pin] = function;
            afIdle[pin] = idleHigh;
            UpdatePads();
        }

        // Pegel einer alternativen Funktion zur virtuellen Zeit us (darf in der Zukunft liegen, z. B. die
        // Bits eines UART-Rahmens). Wirkt nur, wenn der Pin gerade für diese Funktion eingestellt ist.
        public void AlternateOutput(int pin, int function, double us, bool level)
        {
            if(pin < 0 || pin > 7 || afFunction[pin] != function || !AlternateActive(pin)) return;
            var handler = padChanged;
            if(handler != null) handler(pin, us, level ? 1 : 0);
        }

        // Virtuelle Zeit in us, möglichst auf den Befehl genau (CPU-Zeit wird vorher nachgeführt)
        public double NowUs()
        {
            // Im Simulationsthread (Registerzugriff der Firmware) die CPU-Zeit bis zum aktuellen Befehl
            // nachführen, sonst wäre die Zeit nur auf ein Quantum (Lab-Skripte: 10 us) genau
            ICPU cpu;
            if(ownMachine.SystemBus.TryGetCurrentCPU(out cpu))
            {
                var tcpu = cpu as TranslationCPU;
                if(tcpu != null) tcpu.SyncTime();
            }
            return ownMachine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds;
        }

        public override void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 7) return;
            uint bit = 1u << number;
            uint old = ReceiverLevels();
            inputDriven |= bit;
            if(value) inputValue |= bit; else inputValue &= ~bit;
            DetectEdges(old, ReceiverLevels());
            UpdateInterrupt();
            UpdatePads();
        }

        // Pin wird von außen nicht mehr getrieben (z. B. Taster gegen GND losgelassen)
        public void ReleaseInput(int number)
        {
            if(number < 0 || number > 7) return;
            uint old = ReceiverLevels();
            inputDriven &= ~(1u << number);
            DetectEdges(old, ReceiverLevels());
            UpdateInterrupt();
            UpdatePads();
        }

        // Prüft, ob der Pin für die alternative Funktion "function" (GPIOPCTL-Wert) eingestellt ist
        // (Takt, GPIOAFSEL, GPIOPCTL, GPIODEN). Liefert null, wenn alles stimmt, sonst den Fehler.
        public string CheckAlternateFunction(int pin, int function)
        {
            uint bit = 1u << pin;
            var errors = new List<string>();
            if(!sysCtl.IsClockEnabled(RcgcGpio, clockBit)) errors.Add(string.Format("Takt von Port {0} aus (RCGCGPIO Bit {1})", portName, clockBit));
            if((afsel & bit) == 0) errors.Add("GPIOAFSEL-Bit = 0");
            uint pctl;
            other.TryGetValue(Pctl, out pctl);
            uint pmc = (pctl >> (4 * pin)) & 0xF;
            if(pmc != function) errors.Add(string.Format("GPIOPCTL PMC{0} = {1} statt {2}", pin, pmc, function));
            if((den & bit) == 0) errors.Add("GPIODEN-Bit = 0");
            return errors.Count == 0 ? null : Pin(pin) + ": " + string.Join(", ", errors);
        }

        public uint ReadDoubleWord(long offset)
        {
            if(!ClockOk(offset)) return 0;

            if(offset <= Data)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                CheckRead(mask);
                return ReceiverLevels() & mask;
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
                case Lock: return locked ? 1u : 0u;
                case Cr: return cr;
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
            uint old = ReceiverLevels();

            if(offset <= Data)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                dataLatch = (dataLatch & ~mask) | (value & mask);
                CheckWrite(mask);
                UpdatePins();
                DetectEdges(old, ReceiverLevels());
                UpdateInterrupt();
                UpdatePads();
                return;
            }

            switch(offset)
            {
                case Dir: dir = value & 0xFF; break;
                case Is: isLevel = value & 0xFF; break;
                case Ibe: ibe = value & 0xFF; break;
                case Iev: iev = value & 0xFF; break;
                case Im: im = value & 0xFF; CheckInterruptPins(); break;
                case Icr: ris &= ~value; break;
                case Afsel: afsel = Committed("GPIOAFSEL", afsel, value); break;
                case Pur:
                    pur = Committed("GPIOPUR", pur, value);
                    pdr &= ~pur;                     // Datenblatt: PUR-Bit setzen löscht PDR-Bit
                    break;
                case Pdr:
                    pdr = Committed("GPIOPDR", pdr, value);
                    pur &= ~pdr;                     // PDR-Bit setzen löscht PUR-Bit
                    break;
                case Den: den = Committed("GPIODEN", den, value); CheckInterruptPins(); break;
                case Lock: locked = value != LockKey; break;
                case Cr:
                    if(locked)
                    {
                        Warn("crLocked", "GPIOCR beschrieben, ohne vorher GPIOLOCK mit 0x4C4F434B zu entsperren: wirkungslos.");
                    }
                    else
                    {
                        cr = value & 0xFF;
                    }
                    break;
                case Ris: case Mis: case Pp:
                    Warn("ro" + offset, string.Format("Schreiben auf Offset 0x{0:X3}: Register ist nur lesbar (ignoriert).", offset));
                    break;
                default: other[offset] = value; break;
            }
            UpdatePins();
            DetectEdges(old, ReceiverLevels());
            UpdateInterrupt();
            UpdatePads();
        }

        public override void Reset()
        {
            base.Reset();
            dataLatch = dir = isLevel = ibe = iev = im = ris = afsel = pur = pdr = den = 0;
            // Tabelle 10-11: PC[3:0] sind nach Reset JTAG/SWD (AFSEL = DEN = PUR = 1, PCTL = 0x1)
            other = new Dictionary<long, uint>();
            if(portName == "C")
            {
                afsel = den = pur = 0x0F;
                other[Pctl] = 0x1111;
            }
            cr = ~protectedPins & 0xFF;
            locked = true;
            inputDriven = inputValue = 0;
            drivenLevels = 0;
            clockWarned = false;
            warned = new HashSet<string>();
            if(IRQ != null) IRQ.Unset();
            UpdatePads();
        }

        // Pinpegel neu bestimmen und Wechsel melden
        private void UpdatePads()
        {
            var handler = padChanged;
            if(handler == null) return;
            List<int> changes = null;
            lock(padLock)
            {
                for(int i = 0; i < 8; i++)
                {
                    int level = ComputePad(i);
                    if(level != padLevels[i])
                    {
                        padLevels[i] = level;
                        if(changes == null) changes = new List<int>();
                        changes.Add(i | (level << 8));
                    }
                }
            }
            if(changes == null) return;
            double now = NowUs();
            foreach(var c in changes) handler(c & 0xFF, now, c >> 8);
        }

        // Getriebener Ausgang -> Latch; alternative Funktion -> Ruhepegel des Peripheriemodells;
        // von außen getrieben -> dieser Pegel; sonst Pull-up/Pull-down; sonst offen (2)
        private int ComputePad(int i)
        {
            uint bit = 1u << i;
            if((OutputEnabled() & bit) != 0) return (dataLatch & bit) != 0 ? 1 : 0;
            if(AlternateActive(i)) return afIdle[i] ? 1 : 0;
            if((inputDriven & bit) != 0) return (inputValue & bit) != 0 ? 1 : 0;
            if((pur & bit) != 0) return 1;
            if((pdr & bit) != 0) return 0;
            return 2;
        }

        private bool AlternateActive(int pin)
        {
            if(afFunction[pin] < 0) return false;
            uint bit = 1u << pin;
            if((afsel & bit) == 0 || (den & bit) == 0) return false;
            uint pctl;
            other.TryGetValue(Pctl, out pctl);
            return ((pctl >> (4 * pin)) & 0xF) == afFunction[pin];
        }

        // Pegel am Pin von außen: getrieben, sonst Pull-up/Pull-down, sonst offen (0)
        private uint PadInput()
        {
            return ((inputValue & inputDriven) | (pur & ~inputDriven)) & 0xFF;
        }

        // Was der GPIO-Empfänger sieht (= Lesen von GPIODATA ohne Maske):
        // Ausgänge (DIR = 1, AFSEL = 0) den Latch, alle anderen Pins den Pinpegel, nur mit DEN = 1
        private uint ReceiverLevels()
        {
            uint outputs = dir & ~afsel & 0xFF;
            uint levels = dataLatch & outputs;
            levels |= PadInput() & den & ~outputs;
            return levels & 0xFF;
        }

        private uint OutputEnabled()
        {
            return dir & den & ~afsel & 0xFF;
        }

        private void CheckRead(uint mask)
        {
            uint inputs = ~dir & ~afsel & mask & 0xFF;
            for(int i = 0; i < 8; i++)
            {
                uint bit = 1u << i;
                if((inputs & bit) == 0) continue;
                if((den & bit) == 0)
                {
                    // Nur melden, wenn der Pin offensichtlich benutzt wird (konfiguriert oder angeschlossen)
                    if((pur | pdr | inputDriven | im) != 0 && ((pur | pdr | inputDriven | im) & bit) != 0)
                    {
                        Warn("denIn" + i, string.Format("{0} wird als Eingang gelesen, aber GPIODEN = 0: liest immer 0. DEN-Bit setzen.", Pin(i)));
                    }
                }
                else if(((inputDriven | pur | pdr) & bit) == 0)
                {
                    Warn("float" + i, string.Format("{0} ist ein offener Eingang (nichts angeschlossen bzw. Taster losgelassen, kein Pull-up/Pull-down): " +
                        "Pegel undefiniert, im Simulator 0. GPIOPUR oder GPIOPDR setzen.", Pin(i)));
                }
            }
        }

        private void CheckWrite(uint mask)
        {
            uint bad = dir & ~den & ~afsel & mask & 0xFF;
            for(int i = 0; i < 8; i++)
            {
                if((bad & (1u << i)) != 0)
                {
                    Warn("denOut" + i, string.Format("{0} ist Ausgang (GPIODIR = 1), aber GPIODEN = 0: der Pin wird nicht getrieben. DEN-Bit setzen.", Pin(i)));
                }
            }
        }

        private void CheckInterruptPins()
        {
            uint bad = im & ~den & 0xFF;
            uint open = im & den & ~dir & ~afsel & ~(inputDriven | pur | pdr) & 0xFF;
            for(int i = 0; i < 8; i++)
            {
                if((bad & (1u << i)) != 0)
                {
                    Warn("denIm" + i, string.Format("Interrupt an {0} freigegeben (GPIOIM), aber GPIODEN = 0: es kommt nie ein Interrupt.", Pin(i)));
                }
                if((open & (1u << i)) != 0)
                {
                    Warn("float" + i, string.Format("{0} ist ein offener Eingang (nichts angeschlossen bzw. Taster losgelassen, kein Pull-up/Pull-down), " +
                        "aber sein Interrupt ist freigegeben: Pegel undefiniert, im Simulator 0. GPIOPUR oder GPIOPDR setzen.", Pin(i)));
                }
            }
        }

        // Schreiben auf AFSEL/PUR/PDR/DEN: geschützte Bits nur mit GPIOCR = 1 (Commit Control 10.3.4)
        private uint Committed(string reg, uint current, uint value)
        {
            uint blocked = protectedPins & ~cr & ((current ^ value) & 0xFF);
            if(blocked != 0)
            {
                for(int i = 0; i < 8; i++)
                {
                    if((blocked & (1u << i)) != 0)
                    {
                        Warn("commit" + reg + i, string.Format("{0}: {1} ist geschützt (JTAG/NMI). Ohne GPIOLOCK = 0x4C4F434B und GPIOCR-Bit wird das Schreiben ignoriert.", reg, Pin(i)));
                    }
                }
            }
            return ((value & ~blocked) | (current & blocked)) & 0xFF;
        }

        private void UpdatePins()
        {
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
            uint levels = ReceiverLevels();
            uint levelEvents = isLevel & ((iev & levels) | (~iev & ~levels));
            ris = (ris & ~isLevel) | levelEvents;
            ris &= 0xFF;
            IRQ.Set((ris & im) != 0);
        }

        private string Pin(int i)
        {
            return "P" + portName + i;
        }

        private void Warn(string key, string message)
        {
            if(warned.Add(key))
            {
                this.Log(LogLevel.Warning, "GPIO Port {0}: {1}", portName, message);
            }
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
                           Den = 0x51C, Lock = 0x520, Cr = 0x524, Pctl = 0x52C, Pp = 0xFC0;
        private const uint LockKey = 0x4C4F434B;

        private readonly TivaSysCtl sysCtl;
        private readonly int clockBit;
        private readonly string portName;
        private readonly uint protectedPins;
        private uint dataLatch, dir, isLevel, ibe, iev, im, ris, afsel, pur, pdr, den, cr;
        private bool locked;
        private uint inputDriven, inputValue, drivenLevels;
        private bool clockWarned;
        private HashSet<string> warned;
        private Dictionary<long, uint> other;
        private readonly IMachine ownMachine;
        private readonly object padLock = new object();
        private readonly int[] padLevels = { 2, 2, 2, 2, 2, 2, 2, 2 };
        private Action<int, double, int> padChanged;
        private readonly int[] afFunction = new int[8];
        private readonly bool[] afIdle = new bool[8];
    }
}
