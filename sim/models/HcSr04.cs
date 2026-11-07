// Ultraschall-Modul HC-SR04 (Trigger/Echo), Lab 2 und Lab 3 des Mikrocontroller-Praktikums.
//
// Verhalten wie in den Laborunterlagen (LED-Pendel, Bild 5; NVIC, Bild 2.2 und Tabelle 2.1):
//   * Eingang 0 = "Trigger" (von einem GPIO-AUSGANG):   gpioD:  0 -> hcsr04@0
//   * Ausgang Echo (auf einen GPIO-EINGANG):            hcsr04: Echo -> gpioD@1
//   * Eine FALLENDE Flanke am Trigger startet eine Messung (die Firmware setzt Trigger kurz HIGH,
//     z. B. >= 10 us, und dann wieder LOW). Während einer Messung werden weitere Trigger ignoriert.
//   * EchoDelayUs (Standard 450 us) nach der Flanke geht Echo auf HIGH (Burst gesendet),
//     nach der Laufzeit hin und zurück wieder auf LOW:  Dauer = 2 * Distanz / Schallgeschwindigkeit
//     (343 m/s bei 20 °C -> 58,3 us pro cm; 65 cm -> 3,79 ms).
//   * Außerhalb des Messbereichs (MinDistance..MaxDistance, Standard 3..300 cm) kommt kein Echo
//     zurück: Echo bleibt TimeoutUs (Standard 200 ms) HIGH.
//   Alle Zeiten sind virtuelle Simulationszeit, auf etwa ein Renode-Quantum genau (Lab-Skripte: 10 us).
//
// Bedienung im Renode-Monitor (bzw. per Schieberegler in der Web-Konsole):
//   sysbus.gpioD.hcsr04 Distance 65        (cm, ganzzahlig wie beim I2C-Sensor)
//   sysbus.gpioD.hcsr04 Distance
//   sysbus.gpioD.hcsr04 MeasurementCount   (Anzahl gestarteter Messungen)
//   sysbus.gpioD.hcsr04 LastEchoUs         (Dauer des letzten Echo-Pulses in us)
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.Sensors
{
    public class HcSr04 : IGPIOReceiver
    {
        public HcSr04(IMachine machine, int distance = 100, uint echoDelayUs = 450, int minDistance = 3,
                      int maxDistance = 300, uint timeoutUs = 200000, double speedOfSound = 343.0)
        {
            this.machine = machine;
            this.distance = distance;
            EchoDelayUs = echoDelayUs;
            MinDistance = minDistance;
            MaxDistance = maxDistance;
            TimeoutUs = timeoutUs;
            SpeedOfSound = speedOfSound;
            Echo = new GPIO();
            Reset();
        }

        public GPIO Echo { get; private set; }

        // Abstand zum Objekt in cm
        public int Distance
        {
            get { lock(sync) { return distance; } }
            set { lock(sync) { distance = Math.Max(0, Math.Min(1000, value)); } }
        }

        public uint EchoDelayUs { get; set; }
        public int MinDistance { get; set; }
        public int MaxDistance { get; set; }
        public uint TimeoutUs { get; set; }
        public double SpeedOfSound { get; set; }   // m/s

        public int MeasurementCount { get { lock(sync) { return measurements; } } }
        public uint LastEchoUs { get { lock(sync) { return lastEchoUs; } } }

        // Trigger-Eingang
        public void OnGPIO(int number, bool value)
        {
            if(number != 0) return;
            uint echoUs;
            ulong gen;
            lock(sync)
            {
                bool falling = trigger && !value;
                trigger = value;
                if(!falling || busy) return;
                busy = true;
                measurements++;
                int d = distance;
                if(d < MinDistance || d > MaxDistance)
                {
                    echoUs = TimeoutUs;
                }
                else
                {
                    // Laufzeit hin und zurück in us: 2 * d[cm] / 100 / v[m/s] * 1e6
                    echoUs = (uint)Math.Round(2.0 * d * 1e4 / SpeedOfSound);
                }
                lastEchoUs = echoUs;
                gen = ++generation;
            }
            this.Log(LogLevel.Debug, "HC-SR04: Messung gestartet, Echo {0} us", echoUs);
            machine.ScheduleAction(TimeInterval.FromMicroseconds(EchoDelayUs), _ =>
            {
                lock(sync) { if(gen != generation) return; }
                Echo.Set(true);
                machine.ScheduleAction(TimeInterval.FromMicroseconds(Math.Max(1u, echoUs)), __ =>
                {
                    lock(sync) { if(gen != generation) return; }
                    Echo.Set(false);
                    lock(sync) { busy = false; }
                }, "HC-SR04 echo end");
            }, "HC-SR04 echo start");
        }

        public void Reset()
        {
            lock(sync)
            {
                trigger = false;
                busy = false;
                measurements = 0;
                lastEchoUs = 0;
                generation++;
            }
            Echo.Set(false);
        }

        private readonly object sync = new object();
        private readonly IMachine machine;
        private int distance;
        private bool trigger;
        private bool busy;
        private int measurements;
        private uint lastEchoUs;
        private ulong generation;
    }
}
