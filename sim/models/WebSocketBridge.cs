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
            lock(pending)
            {
                if(state[number] == value) return;
                state[number] = value;
                changed[number] = true;
                dirty = true;
            }
        }

        private void SendLoop()
        {
            var msgs = new List<string>();
            while(true)
            {
                Thread.Sleep(SendIntervalMs);
                msgs.Clear();
                lock(pending)
                {
                    if(!dirty) continue;
                    dirty = false;
                    for(int i = 0; i < 8; i++)
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
                }
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
        private const int SendIntervalMs = 20;
    }
}
