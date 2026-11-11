// Minimaler WebSocket-Server (Port 9000) für die HTML-LED-Anzeige.
//
// Das Modul hat 8 GPIO-Eingänge (0..7). Pegeländerungen werden als Text "LED<n>=<0|1>" an alle
// verbundenen Clients gesendet; neue Clients erhalten sofort den aktuellen Zustand.
//
// Gesendet wird gesammelt von einem eigenen Thread alle SendIntervalMs (Wanduhr), nicht im
// CPU-Thread: Eine Firmware, die eine LED mit 1 kHz umschaltet, hätte sonst 1000 Socket-Schreib-
// vorgänge je Sekunde mitten in der Emulation ausgelöst (gemessen: Simulation 2–3× langsamer).
// Ein Blinken innerhalb eines Intervalls geht nicht verloren: Hat eine LED seit dem letzten Senden
// gewechselt, endet aber im alten Zustand, werden beide Wechsel gesendet.
//
// Helligkeit (PWM, "Dimmen"): Je LED wird die Helligkeit wie vom Auge gemittelt – Tiefpass 1. Ordnung
// über die virtuelle Zeit, Zeitkonstante BrightnessTauMs. Schaltet eine LED schnell (zwei Wechsel im
// Abstand von höchstens PwmHoldMs), kommt mit jedem Senden zusätzlich "LEDB<n>=<0..1000>" (Promille);
// bleibt sie länger als PwmHoldMs stehen, einmal "LEDB<n>=-" (dann gilt wieder nur an/aus). Langsames
// Blinken (z. B. ein 100-ms-Puls) bleibt so ein hartes An/Aus. Bei 30 Hz bleibt ein leichtes
// Flimmern sichtbar – wie bei einer echten LED.
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class WebSocketBridge : IGPIOReceiver
    {
        public WebSocketBridge(IMachine machine, int port = 9000)
        {
            this.machine = machine;
            clients = new List<NetworkStream>();
            state = new bool[8];
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            this.Log(LogLevel.Info, "WebSocket-Bridge lauscht auf ws://127.0.0.1:{0}", port);
            var t = new Thread(AcceptLoop) { IsBackground = true };
            t.Start();
            var s = new Thread(SendLoop) { IsBackground = true, Name = "WebSocketBridge" };
            s.Start();
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 7) return;
            double now = NowMs();
            lock(pending)
            {
                if(state[number] == value) return;
                Integrate(number, now);
                state[number] = value;
                changed[number] = true;
                // PWM: zwei Wechsel kurz hintereinander (höchstens PwmHoldMs, d. h. ab ca. 12 Hz)
                if(now - lastToggleMs[number] <= PwmHoldMs) toggling[number] = true;
                lastToggleMs[number] = now;
                dirty = true;
            }
        }

        // Virtuelle Zeit in ms
        private double NowMs()
        {
            return machine.LocalTimeSource.ElapsedVirtualTime.TotalMilliseconds;
        }

        // Helligkeit bis 'now' nachführen (Pegel seit dem letzten Aufruf konstant); unter 'pending'
        private void Integrate(int i, double now)
        {
            double dt = now - integratedMs[i];
            if(dt <= 0) return;
            integratedMs[i] = now;
            double target = state[i] ? 1.0 : 0.0;
            brightness[i] += (target - brightness[i]) * (1.0 - Math.Exp(-dt / BrightnessTauMs));
        }

        private void SendLoop()
        {
            var msgs = new List<string>();
            while(true)
            {
                Thread.Sleep(SendIntervalMs);
                msgs.Clear();
                double now = NowMs();
                lock(pending)
                {
                    for(int i = 0; i < 8; i++)
                    {
                        if(!toggling[i]) continue;
                        Integrate(i, now);
                        if(now - lastToggleMs[i] > PwmHoldMs)
                        {
                            toggling[i] = false;
                            msgs.Add("LEDB" + i + "=-");
                        }
                        else
                        {
                            msgs.Add("LEDB" + i + "=" + (int)Math.Round(brightness[i] * 1000));
                        }
                    }
                    for(int i = 0; i < 8 && dirty; i++)
                    {
                        if(!changed[i]) continue;
                        changed[i] = false;
                        if(state[i] == sent[i])
                        {
                            // kurz umgeschaltet und zurück: Blinken zeigen
                            msgs.Add(Message(i, !state[i]));
                        }
                        msgs.Add(Message(i, state[i]));
                        sent[i] = state[i];
                    }
                    dirty = false;
                }
                if(msgs.Count == 0) continue;
                lock(clients)
                {
                    foreach(var m in msgs) Broadcast(m);
                }
            }
        }

        public void Reset()
        {
            lock(pending)
            {
                for(int i = 0; i < 8; i++)
                {
                    changed[i] = state[i];   // LEDs, die an waren, als aus melden
                    state[i] = false;
                    brightness[i] = 0;
                    integratedMs[i] = NowMs();
                }
                dirty = true;
            }
        }

        private static string Message(int i, bool on)
        {
            return "LED" + i + "=" + (on ? "1" : "0");
        }

        private void Broadcast(string text)
        {
            var frame = Frame(text);
            foreach(var c in clients.ToArray())
            {
                try { c.Write(frame, 0, frame.Length); }
                catch { clients.Remove(c); }
            }
        }

        private static byte[] Frame(string text)
        {
            var payload = Encoding.UTF8.GetBytes(text);
            var f = new byte[2 + payload.Length];
            f[0] = 0x81;
            f[1] = (byte)payload.Length; // Nachrichten sind kurz (< 126 Byte)
            Array.Copy(payload, 0, f, 2, payload.Length);
            return f;
        }

        private void AcceptLoop()
        {
            while(true)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    var thread = new Thread(() => Handshake(client)) { IsBackground = true };
                    thread.Start();
                }
                catch { return; }
            }
        }

        private void Handshake(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                var buf = new byte[4096];
                int n = stream.Read(buf, 0, buf.Length);
                var request = Encoding.UTF8.GetString(buf, 0, n);
                int k = request.IndexOf("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase);
                if(k < 0) { client.Close(); return; }
                var key = request.Substring(k + 18, request.IndexOf("\r\n", k) - k - 18).Trim();
                var accept = Convert.ToBase64String(SHA1.Create().ComputeHash(
                    Encoding.UTF8.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                var response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
                               "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
                var bytes = Encoding.ASCII.GetBytes(response);
                stream.Write(bytes, 0, bytes.Length);
                lock(clients)
                {
                    bool[] now;
                    lock(pending) { now = (bool[])sent.Clone(); }
                    clients.Add(stream);
                    keepAlive.Add(client); // sonst schließt der Garbage-Collector die Verbindung
                    for(int i = 0; i < 8; i++)
                    {
                        var f = Frame(Message(i, now[i]));
                        stream.Write(f, 0, f.Length);
                    }
                }
            }
            catch { }
        }

        private readonly TcpListener listener;
        private readonly List<NetworkStream> clients;
        private readonly List<TcpClient> keepAlive = new List<TcpClient>();
        private readonly bool[] state;            // aktueller Pegel (CPU-Thread)
        private readonly bool[] sent = new bool[8];   // zuletzt gesendet
        private readonly bool[] changed = new bool[8];
        private readonly object pending = new object();
        private bool dirty;
        private readonly IMachine machine;
        private readonly double[] brightness = new double[8];     // 0..1, Tiefpass über die virtuelle Zeit
        private readonly double[] integratedMs = new double[8];   // bis hierher nachgeführt
        private readonly double[] lastToggleMs = { -1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9 };
        private readonly bool[] toggling = new bool[8];           // LEDB wird gesendet
        private const int SendIntervalMs = 20;
        private const double BrightnessTauMs = 50;
        private const double PwmHoldMs = 80;
    }
}
