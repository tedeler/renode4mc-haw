using System;
using System.Collections.Generic;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.GPIOPort
{
    public class TivaGPIOPort : BaseGPIOPort, IDoubleWordPeripheral
    {
        public TivaGPIOPort(IMachine machine) : base(machine, 8) { }

        public uint ReadDoubleWord(long offset)
        {
            if (offset <= 0x3FC)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                return dataOut & mask;
            }
            if (offset == 0x400) return dir;
            if (offset == 0x51C) return den;
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if (offset <= 0x3FC)
            {
                uint mask = (uint)((offset >> 2) & 0xFF);
                dataOut = (dataOut & ~mask) | (value & mask);
                for (int i = 0; i < 8; i++)
                {
                    bool pinState = ((dataOut >> i) & 1) != 0;
                    if (Connections[i].IsSet != pinState)
                    {
                        Connections[i].Set(pinState);
                        this.Log(LogLevel.Info, "Pin {0} -> {1}", i, pinState ? "HIGH (LED AN)" : "LOW (LED AUS)");
                    }
                }
                return;
            }
            if (offset == 0x400) dir = value;
            else if (offset == 0x51C) den = value;
        }

        public override void Reset()
        {
            base.Reset();
            dataOut = dir = den = 0;
        }

        private uint dataOut, dir, den;
    }
}
