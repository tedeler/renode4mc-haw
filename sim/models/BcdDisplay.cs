// 7-Segment-Anzeige mit BCD-Eingängen (HAW-IT-Labor), Lab 1 des Mikrocontroller-Praktikums.
//
// Aufbau wie im Laborskript (Anhang 2, Bild 4):
//   * Zwei Module mit je zwei Ziffern, gemeinsame Datenleitungen D0..D7:
//       D0..D3 = hintere (rechte) Ziffer, D4..D7 = vordere (linke) Ziffer eines Moduls (8421-BCD)
//   * Jedes Modul hat einen Freigabe-Eingang EN. Solange EN = HIGH ist, übernimmt das Modul die
//     Datenleitungen (Latch transparent), bei EN = LOW hält es den zuletzt übernommenen Wert.
//       Eingang 0..7 = D0..D7, Eingang 8 = EN des rechten Moduls (Ziffern 1 und 0),
//       Eingang 9 = EN des linken Moduls (Ziffern 3 und 2)
//   * Werte 0..9 erscheinen als Ziffer, A..F wie bei einem Hex-Decoder (A b C d E F).
//   * Nach dem Einschalten (vor der ersten Übernahme) bleibt ein Modul dunkel.
//
// Verdrahtung z. B. (experiments/lab1_gpio.repl):
//   gpioK:  0 -> bcd@0 ... 7 -> bcd@7        gpioL:  0 -> bcd@8    1 -> bcd@9
//
// Bedienung im Renode-Monitor:
//   sysbus.gpioK.bcd GetState        -> "BCD:<Ziffer3><Ziffer2><Ziffer1><Ziffer0>:<EN links><EN rechts>:<D7..D0 hex>"
//                                       Ziffer = 0..9, A..F oder "-" (dunkel)
//   sysbus.gpioK.bcd Text            -> nur die vier Ziffern, z. B. "--29"
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class BcdDisplay : IGPIOReceiver
    {
        public BcdDisplay()
        {
            Reset();
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 9) return;
            lock(sync)
            {
                if(number < 8)
                {
                    data = value ? (byte)(data | (1 << number)) : (byte)(data & ~(1 << number));
                }
                else
                {
                    enable[number - 8] = value;
                }
                for(int m = 0; m < 2; m++)
                {
                    if(enable[m] && (!latched[m] || value_[m] != data))
                    {
                        value_[m] = data;
                        latched[m] = true;
                        this.Log(LogLevel.Debug, "BCD: Modul {0} = {1:X2}", m, data);
                    }
                }
            }
        }

        public string Text
        {
            get { lock(sync) { return Digits(); } }
        }

        public string GetState()
        {
            lock(sync)
            {
                return "BCD:" + Digits() + ":" + (enable[1] ? "1" : "0") + (enable[0] ? "1" : "0") + ":" + data.ToString("X2");
            }
        }

        public void Reset()
        {
            lock(sync)
            {
                data = 0;
                enable = new bool[2];
                latched = new bool[2];
                value_ = new byte[2];
            }
        }

        // Ziffer 3 (links) .. Ziffer 0 (rechts)
        private string Digits()
        {
            var chars = new char[4];
            for(int m = 0; m < 2; m++)
            {
                chars[3 - 2 * m] = latched[m] ? Hex(value_[m] & 0xF) : '-';
                chars[2 - 2 * m] = latched[m] ? Hex(value_[m] >> 4) : '-';
            }
            return new string(chars);
        }

        private static char Hex(int v)
        {
            return "0123456789ABCDEF"[v & 0xF];
        }

        private readonly object sync = new object();
        private byte data;
        private bool[] enable;
        private bool[] latched;
        private byte[] value_;
    }
}
