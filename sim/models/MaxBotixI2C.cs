// MaxBotix MB1242 (I2CXL-MaxSonar-EZ) – Ultraschall-Distanzsensor am I2C-Bus.
//
// Protokoll (7-Bit-Adresse, Standard 0x70):
//   Schreiben 0x51            -> Messung starten (der aktuelle Distance-Wert wird übernommen)
//   Lesen 2 Bytes             -> Distanz in cm, höherwertiges Byte zuerst
//   Schreiben 0xAA, addr, 0xA5 -> Adresswechsel (wird nur gemeldet, nicht umgesetzt)
// Die Messdauer (ca. 80 ms auf der echten Hardware) wird nicht nachgebildet.
//
// Bedienung im Renode-Monitor (bzw. per Schieberegler in der Web-Konsole):
//   sysbus.i2c0.sensor Distance 120     (setzen, in cm, 0..765)
//   sysbus.i2c0.sensor Distance         (lesen)
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;

namespace Antmicro.Renode.Peripherals.Sensors
{
    public class MaxBotixI2C : II2CPeripheral
    {
        public MaxBotixI2C()
        {
            Reset();
        }

        public int Distance
        {
            get { lock(sync) { return distance; } }
            set { lock(sync) { distance = Math.Max(MinDistance, Math.Min(MaxDistance, value)); } }
        }

        // Anzahl der seit Reset gestarteten Messungen (zur Kontrolle im Monitor)
        public int MeasurementCount
        {
            get { lock(sync) { return measurements; } }
        }

        public void Reset()
        {
            lock(sync)
            {
                distance = 100;
                latched = 100;
                measurements = 0;
                readIndex = 0;
            }
        }

        public void Write(byte[] data)
        {
            lock(sync)
            {
                foreach(var b in data)
                {
                    if(b == RangeCommand)
                    {
                        latched = distance;
                        measurements++;
                        readIndex = 0;
                    }
                    else if(b == 0xAA || b == 0xA5)
                    {
                        this.Log(LogLevel.Info, "MaxBotix: Adresswechsel wird im Simulator nicht unterstützt.");
                    }
                }
            }
        }

        // Liest fortlaufend [MSB, LSB, MSB, LSB, ...]; der Zeiger beginnt bei jedem Transfer neu.
        public byte[] Read(int count = 1)
        {
            lock(sync)
            {
                var result = new byte[Math.Max(0, count)];
                for(int i = 0; i < result.Length; i++)
                {
                    result[i] = (readIndex % 2 == 0) ? (byte)((latched >> 8) & 0xFF) : (byte)(latched & 0xFF);
                    readIndex++;
                }
                return result;
            }
        }

        public void FinishTransmission()
        {
            lock(sync) { readIndex = 0; }
        }

        private const byte RangeCommand = 0x51;
        private const int MinDistance = 0;
        private const int MaxDistance = 765;

        private readonly object sync = new object();
        private int distance;
        private int latched;
        private int measurements;
        private int readIndex;
    }
}
